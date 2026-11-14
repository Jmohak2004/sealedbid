// Testnet pipeline for SealedBid.   npm run testnet -- <status|probe|setup|demo>
//   status : balances, PQ key state, KEM key, window per account (read-only)
//   probe  : deploy PQCProbe and answer the three on-chain questions (needs funded `deployer`)
//   setup  : register keys, publish the seller's KEM key, deploy SealedBidAuction
//   demo   : run one full auction on testnet and record public/demo-log.json
import { mkdirSync, writeFileSync } from "node:fs";
import { hexToBytes, parseEther, toHex, type Hex } from "viem";
import { fetchEvmWindow, pqcSign } from "@qorechain/sdk";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { REST } from "./lib.js";
import {
  EVM_CHAIN_ID, PQC_STATUS, PQC_VERIFY, artifact, balanceQor, cosmosTx, ensureKem, ensurePq, loadDeployment, loadNet,
  openWindow, pqStatus, pub, saveDeployment, walletFor, type Net,
} from "./testnet-lib.js";
import { DEFAULT_AGENTS, scaleAgents } from "../src/agents/bidder.js";
import { newParticipant } from "../src/sealedbid/local.js";
import { runDemo, type ChainIO } from "../src/sealedbid/demo.js";
import auctionArtifact from "../src/sealedbid/generated/SealedBidAuction.json" with { type: "json" };

const cmd = process.argv[2];
const ROLES = { deployer: "deployer", seller: "auctioneer", bidders: ["bidder1", "bidder2", "bidder3"] } as const;
const names = [ROLES.deployer, ROLES.seller, ...ROLES.bidders];

async function loadAll() {
  const out: Record<string, Net> = {};
  for (const n of names) out[n] = await loadNet(n);
  return out;
}

async function status() {
  const all = await loadAll();
  for (const [n, p] of Object.entries(all)) {
    const [bal, st, kem, w] = await Promise.all([
      balanceQor(p), pqStatus(p), fetchKemKey({ rest: REST, address: p.cosmos }), fetchEvmWindow({ rest: REST, address: p.cosmos }),
    ]);
    console.log(`${n.padEnd(10)} ${p.cosmos}  ${bal.qor} QOR | pq registered=${st.registered} proven=${st.proven} | kem=${kem.registered} | window live=${w.live}`);
  }
}

async function probe() {
  const d = await loadNet("deployer");
  console.log("Deployer balance:", (await balanceQor(d)).qor, "QOR");
  if ((await balanceQor(d)).uqor === 0n) throw new Error("deployer has no test QOR yet: use the faucet");
  await ensurePq(d);
  await openWindow(d, 600, 20, 50_000_000n);
  const { abi, bytecode } = artifact("PQCProbe");
  const w = walletFor(d);
  let nonce = await pub.getTransactionCount({ address: d.evm });
  const dh = await w.deployContract({ abi, bytecode, nonce, gas: 1_500_000n, chain: null, account: d.account });
  const rc = await pub.waitForTransactionReceipt({ hash: dh });
  const probeAddr = rc.contractAddress!;
  console.log("PQCProbe deployed:", probeAddr, "status:", rc.status);

  const message = hexToBytes(("0x" + "ab".repeat(32)) as Hex); // a raw 32-byte digest, as the auction signs
  const sig = pqcSign(d.pq.secretKey, message);
  const call = (m: Uint8Array) => pub.readContract({
    address: probeAddr, abi, functionName: "verify", args: [toHex(d.pq.publicKey), toHex(sig), toHex(m)],
  });
  const good = await call(message);
  const bad = await call(hexToBytes(("0x" + "cd".repeat(32)) as Hex));
  console.log(`Q1  valid signature over raw 32 bytes -> ${good}   (expect true)`);
  console.log(`Q1  tampered message                  -> ${bad}   (expect false)`);
  console.log("    status():", await pub.readContract({ address: probeAddr, abi, functionName: "status", args: [d.evm] }));

  nonce = await pub.getTransactionCount({ address: d.evm });
  const h = await w.writeContract({
    address: probeAddr, abi, functionName: "verifyAndLog", nonce, gas: 800_000n, chain: null, account: d.account,
    args: [toHex(d.pq.publicKey), toHex(sig), toHex(message)],
  });
  const r2 = await pub.waitForTransactionReceipt({ hash: h });
  console.log(`Q2  verifyAndLog inside a windowed tx -> ${r2.status}, gasUsed ${r2.gasUsed}`);
  console.log(good === true && bad === false && r2.status === "success"
    ? "\nPROBE PASSED: on-chain ML-DSA verification works as the auction assumes."
    : "\nPROBE FAILED: do NOT deploy the auction as-is; see README fallback (commitment-only mode).");
}

async function setup() {
  const all = await loadAll();
  console.log("1/4 register post-quantum keys (with proof of possession)");
  for (const n of names) await ensurePq(all[n]);
  console.log("2/4 publish the seller's ML-KEM-1024 key");
  await ensureKem(all[ROLES.seller]);
  console.log("3/4 open an unscoped window for deployment");
  const d = all[ROLES.deployer];
  await openWindow(d, 300, 10, 50_000_000n);
  console.log("4/4 deploy SealedBidAuction");
  const nonce = await pub.getTransactionCount({ address: d.evm });
  const hash = await walletFor(d).deployContract({
    abi: auctionArtifact.abi, bytecode: auctionArtifact.bytecode as Hex, args: [PQC_VERIFY, PQC_STATUS],
    nonce, gas: 4_000_000n, chain: null, account: d.account,
  });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`deploy reverted: ${hash}`);
  saveDeployment({ auction: rc.contractAddress, deployTx: hash, chainId: EVM_CHAIN_ID, deployedAt: new Date().toISOString() });
  console.log("SealedBidAuction:", rc.contractAddress, "(saved to deployments/testnet.json)");
}

async function demo() {
  const dep = loadDeployment();
  const all = await loadAll();
  console.log("opening fresh windows");
  for (const n of names) await openWindow(all[n], 1500, 14, 5_000_000n);
  const bidderNets = ROLES.bidders.map((n) => all[n]);
  const scaled = scaleAgents(DEFAULT_AGENTS, 1n, 100n); // 1/100 so it fits a small faucet allotment
  const agents = scaled.map((brief, i) => ({
    // Dara never transacts (below reserve), so she needs no funded account; she gets a throwaway identity.
    who: bidderNets[i] ?? newParticipant(brief.name), brief,
  }));
  // names in the log should be the persona names, not the account labels
  agents.forEach((a, i) => { a.who = Object.assign(a.who, { name: scaled[i].name }); });
  const t = { commit: 90, reveal: 90, pay: 120 };
  const io: ChainIO = {
    publicClient: pub as any, walletFor: walletFor as any, auction: dep.auction, auctionAbi: auctionArtifact.abi as any,
    evmChainId: EVM_CHAIN_ID, sealChainId: "qorechain-diana",
    sleep: (s) => new Promise((r) => setTimeout(r, s * 1000)), gas: 1_000_000n, timings: t,
  };
  const res = await runDemo({
    io, seller: all[ROLES.seller], finalizer: all[ROLES.deployer],
    eavesdropper: newParticipant("Eve"), thief: newParticipant("Thief"), agents,
    reserve: parseEther("0.02"), deposit: parseEther("0.01"), selfRevealAgent: "Chidi",
    onEntry: (e) => console.log(`[${e.phase}/${e.lane}] ${e.text.slice(0, 160)}`),
  });
  mkdirSync("public", { recursive: true });
  writeFileSync("public/demo-log.json", JSON.stringify({
    ...res, mode: "testnet", generatedAt: new Date().toISOString(),
    note: "Recorded on QoreChain testnet (qorechain-diana); every tx hash is real.",
  }, null, 1));
  console.log(`\nwinner=${res.winner} price=${res.price} QOR. Recorded public/demo-log.json (mode=testnet)`);
}

const commands: Record<string, () => Promise<void>> = { status, probe, setup, demo };
if (!commands[cmd]) { console.error("usage: npm run testnet -- <status|probe|setup|demo>"); process.exit(2); }
await commands[cmd]();
process.exit(0);
