// Testnet helpers (QoreChain testnet "qorechain-diana"). Secrets are read from ./keys (gitignored).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { StargateClient } from "@cosmjs/stargate";
import { createPublicClient, createWalletClient, defineChain, hexToBytes, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  EthNativeSigner, buildRegisterPqcKeyMsg, deriveUnifiedAccount, fetchEvmWindow, msg, openEvmWindowMsg,
  signProofOfPossession, type UnifiedAccount,
} from "@qorechain/sdk";
import { deriveSealKeys } from "@qorechain/qoreseal";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { CHAIN_ID, EVM_RPC, REST, RPC, accountSequence, loadMnemonic } from "./lib.js";
import type { Participant } from "../src/sealedbid/local.js";

export const EVM_CHAIN_ID = 9800;
export const PQC_VERIFY = "0x0000000000000000000000000000000000000a01" as const;
export const PQC_STATUS = "0x0000000000000000000000000000000000000a02" as const;
export const DEPLOYMENT_FILE = new URL("../deployments/testnet.json", import.meta.url).pathname;

export const chain = defineChain({
  id: EVM_CHAIN_ID, name: "QoreChain Diana", nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
});
export const pub = createPublicClient({ chain, transport: http(EVM_RPC) });
export const walletFor = (p: Participant) => createWalletClient({ chain, transport: http(EVM_RPC), account: p.account });

export interface Net extends Participant { cosmos: string; evm: Address; publicKey: Hex; unified: UnifiedAccount }

export async function loadNet(name: string): Promise<Net> {
  const mnemonic = loadMnemonic(name);
  const u = await deriveUnifiedAccount(mnemonic);
  const account = privateKeyToAccount(u.privateKey as Hex);
  if (account.address.toLowerCase() !== u.evm.toLowerCase()) throw new Error(`${name}: EVM address mismatch`);
  return {
    name, privateKey: u.privateKey as Hex, account, pq: u.pqc, seal: deriveSealKeys({ mnemonic }),
    cosmos: u.cosmos, evm: u.evm as Address, publicKey: u.publicKey as Hex, unified: u,
  };
}

const stargatePromise = StargateClient.connect(RPC);
const log = (...a: unknown[]) => console.log(...a);

export async function cosmosTx(
  p: Net, label: string, messages: any[], gas: number, uqorFee: number, signMode: "hybrid" | "classical" = "hybrid",
) {
  const signer = new EthNativeSigner(p.unified, { rest: REST, signMode });
  const { accountNumber, sequence } = await accountSequence(p.cosmos);
  const r = await signer.signAndBroadcast(await stargatePromise, {
    chainId: CHAIN_ID, accountNumber, sequence, messages,
    fee: { amount: [{ denom: "uqor", amount: String(uqorFee) }], gas: String(gas) },
  });
  log(`  ${label}: code=${r.code} gasUsed=${r.gasUsed} tx=${r.transactionHash}`);
  if (r.code !== 0) throw new Error(`${label} failed: ${r.rawLog}`);
  return r;
}

const STATUS_ABI = [{
  type: "function", name: "pqcKeyStatus", stateMutability: "view", inputs: [{ name: "account", type: "address" }],
  outputs: [{ type: "bool" }, { type: "uint8" }, { type: "bytes" }, { type: "bool" }],
}] as const;

export async function pqStatus(p: Net) {
  const [registered, algorithmId, pubkey, proven] = await pub.readContract({
    address: PQC_STATUS, abi: STATUS_ABI, functionName: "pqcKeyStatus", args: [p.evm],
  });
  return { registered, algorithmId, pubkeyLen: (pubkey.length - 2) / 2, proven };
}

export async function balanceQor(p: Net) {
  const b = (await (await fetch(`${REST}/cosmos/bank/v1beta1/balances/${p.cosmos}`)).json()) as any;
  const uqor = BigInt((b.balances ?? []).find((c: any) => c.denom === "uqor")?.amount ?? "0");
  return { uqor, qor: Number(uqor) / 1e6 };
}

/** Register the ML-DSA-87 key WITH a proof of possession (the auction contract requires possessionProven). */
export async function ensurePq(p: Net) {
  const st = await pqStatus(p);
  if (st.registered && st.proven) return log(`  ${p.name}: PQ key already registered and proven`);
  if (st.registered && !st.proven)
    throw new Error(`${p.name}: key registered but possession NOT proven; rotate it or use a fresh account`);
  const proofOfPossession = signProofOfPossession({ chainId: CHAIN_ID, account: p.cosmos, keypair: p.pq });
  await cosmosTx(p, `${p.name} register-pqc-key`, [buildRegisterPqcKeyMsg(p.cosmos, {
    pqcKeypair: p.pq, ecdsaPubkey: hexToBytes(p.publicKey), proofOfPossession,
  })], 600_000, 60_000, "classical"); // bootstrap registration is exempt from the hybrid requirement
}

export async function ensureKem(p: Net) {
  const k = await fetchKemKey({ rest: REST, address: p.cosmos });
  if (k.registered) return log(`  ${p.name}: ML-KEM key already published (height ${k.registeredHeight})`);
  await cosmosTx(p, `${p.name} register-kem-key`, [
    msg.pqc.registerKemKey({ sender: p.cosmos, algorithmId: 2, publicKey: p.seal.mlkemPublicKey }),
  ], 600_000, 60_000);
}

/** Open an UNSCOPED window (contract creation needs unscoped). maxValue is uqor: value PLUS max fees. */
export async function openWindow(p: Net, blocks: number, maxTxs: number, maxValueUqor: bigint) {
  await cosmosTx(p, `${p.name} open-window`, [
    openEvmWindowMsg({ sender: p.cosmos, blocks, maxTxs, maxValue: maxValueUqor.toString() }),
  ], 400_000, 80_000);
  const w = await fetchEvmWindow({ rest: REST, address: p.cosmos });
  log(`  ${p.name} window: live=${w.live} txs=${w.remainingTxs} blocks=${w.remainingBlocks}`);
}

export function loadDeployment(): { auction: Address; deployTx: Hex; chainId: number; deployedAt: string } {
  if (!existsSync(DEPLOYMENT_FILE)) throw new Error("no deployment yet: run `npm run testnet -- setup`");
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
}
export function saveDeployment(d: object) {
  mkdirSync(new URL("../deployments/", import.meta.url).pathname, { recursive: true });
  writeFileSync(DEPLOYMENT_FILE, JSON.stringify(d, null, 2));
}
export const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../build/${name}.json`, import.meta.url), "utf8"));
