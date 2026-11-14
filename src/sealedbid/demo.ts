// Orchestrates one complete SealedBid auction and records a two-lane transcript:
//   lane "private": what the agents and the seller know (decisions, plaintext bids)
//   lane "public" : what the chain / an eavesdropper sees (hashes, ciphertext sizes, events)
// The same code drives the local mock chain and the real testnet through the ChainIO interface.
import {
  bytesToHex, formatEther, parseEther, type Abi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { pqcSign } from "@qorechain/sdk";
import { recipientOf } from "@qorechain/qoreseal";
import { decideBid, type AgentBrief, type AuctionBrief, type Decision } from "../agents/bidder.js";
import {
  bidDigest, kemKeyHash, openBid, sealBid, signingMessage, withdrawDigest, type BidContext, type RevealArgs,
} from "./core.js";
import type { Participant } from "./local.js";

export interface ChainIO {
  publicClient: PublicClient;
  walletFor(p: Participant): WalletClient;
  auction: Address;
  auctionAbi: Abi;
  evmChainId: number;
  sealChainId: string;
  /** Advance time (local) or really wait (testnet). */
  sleep(secs: number): Promise<void>;
  /** Local mock only: whitelist a verified signature triple. Real chain: omitted, the precompile verifies. */
  authorize?(p: Participant, digest: Hex, signature: Hex): Promise<void>;
  /** Extra gas settings (testnet may need a fixed gas limit). */
  gas?: bigint;
  timings: { commit: number; reveal: number; pay: number };
}

export type Lane = "public" | "private" | "attack";
export type Phase = "setup" | "commit" | "reveal" | "settle" | "withdraw";
export interface LogEntry {
  n: number; phase: Phase; lane: Lane; actor: string; text: string;
  tx?: Hex; gas?: string; data?: Record<string, string | number | boolean>;
}

export interface DemoResult {
  log: LogEntry[];
  winner?: string; price?: string; auctionId: string; contract: Address; chainId: number;
  summary: { bids: number; revealedBySeller: number; revealedByBidder: number; revealGas: string[] };
}

const short = (h: string, n = 10) => `${h.slice(0, n)}…${h.slice(-6)}`;
const revertReason = (e: any): string => {
  // viem wraps the node's message; the contract's revert string lives in `details` (local) or the message (testnet)
  const text = [e?.details, e?.cause?.details, e?.shortMessage, e?.message].filter(Boolean).join("\n");
  const hit = text.match(/revert(?:ed)?(?: with (?:the following )?reason(?: string)?)?:?\s*"?([^\n"]+)/i);
  return (hit?.[1] ?? text.split("\n")[0]).trim().slice(0, 120);
};

export async function runDemo(opts: {
  io: ChainIO;
  seller: Participant;
  eavesdropper: Participant;      // a stranger: has the ciphertext, not the seller's key
  thief: Participant;             // holds a loser's CLASSICAL key only (simulated stolen key)
  /** Who sends finalize(); on a real chain this must be an account with a PQ key + open window. Defaults to the eavesdropper. */
  finalizer?: Participant;
  agents: { who: Participant; brief: AgentBrief }[];
  item?: string;
  reserve?: bigint;
  deposit?: bigint;
  /** When set, the named agent's seller-side reveal is skipped (seller "goes offline") and they reveal themselves. */
  selfRevealAgent?: string;
  onEntry?: (e: LogEntry) => void;
}): Promise<DemoResult> {
  const { io, seller, agents } = opts;
  const item = opts.item ?? "Q-Day Genesis Licence #1";
  const reserve = opts.reserve ?? parseEther("2");
  const deposit = opts.deposit ?? parseEther("1");
  const log: LogEntry[] = [];
  const add = (e: Omit<LogEntry, "n">) => { const x = { n: log.length + 1, ...e }; log.push(x); opts.onEntry?.(x); return x; };
  const gas = io.gas ?? 3_000_000n;

  const write = async (who: Participant, fn: string, args: unknown[], value?: bigint) => {
    const hash = await io.walletFor(who).writeContract({
      address: io.auction, abi: io.auctionAbi, functionName: fn, args, value, gas, chain: null, account: who.account,
    } as any);
    const rc = await io.publicClient.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${fn} reverted on-chain (tx ${hash})`);
    return rc;
  };
  const read = <T,>(fn: string, args: unknown[] = []) =>
    io.publicClient.readContract({ address: io.auction, abi: io.auctionAbi, functionName: fn, args }) as Promise<T>;
  const ctx = (id: bigint, who: Participant): BidContext =>
    ({ evmChainId: io.evmChainId, contract: io.auction, auctionId: id, bidder: who.account.address });

  // ------------------------------------------------------------------ setup
  const receipt = await write(seller, "createAuction", [
    item, kemKeyHash(seller.seal.mlkemPublicKey), reserve, deposit,
    BigInt(io.timings.commit), BigInt(io.timings.reveal), BigInt(io.timings.pay),
  ]);
  const id = await read<bigint>("auctionCount");
  add({ phase: "setup", lane: "public", actor: "chain", tx: receipt.transactionHash,
    text: `Auction #${id} created for “${item}”. Reserve ${formatEther(reserve)} QOR, fixed deposit ${formatEther(deposit)} QOR. Bids are sealed to the seller's ML-KEM-1024 key (hash ${short(kemKeyHash(seller.seal.mlkemPublicKey))}).`,
    data: { auctionId: id.toString(), rule: "second-price", deposit: formatEther(deposit) } });
  add({ phase: "setup", lane: "private", actor: seller.name,
    text: "I published my ML-KEM-1024 key in the on-chain registry. Bidders encrypt to it; only I can read their bids." });

  const auctionBrief: AuctionBrief = {
    item, reserve, deposit,
    rule: "second-price (Vickrey): the highest bidder wins but pays the second-highest bid (or the reserve)",
  };

  // ------------------------------------------------------------------ commit
  const placed: { who: Participant; brief: AgentBrief; sealed: ReturnType<typeof sealBid>; decision: Decision }[] = [];
  for (const { who, brief } of agents) {
    const decision = await decideBid(brief, auctionBrief);
    add({ phase: "commit", lane: "private", actor: brief.name,
      text: decision.bid > 0n
        ? `${decision.reasoning} → I will bid ${formatEther(decision.bid)} QOR.`
        : `${decision.reasoning} → I skip this auction.`,
      data: { source: decision.source, bid: formatEther(decision.bid) } });
    if (decision.bid === 0n) continue;

    const sealed = sealBid({
      sealChainId: io.sealChainId, context: ctx(id, who), amount: decision.bid,
      auctioneer: recipientOf(seller.seal), pqSecretKey: who.pq.secretKey,
    });
    if (io.authorize) await io.authorize(who, sealed.commitDigest, sealed.commitSignature);
    const r = await write(who, "commitBid", [id, sealed.commitment, sealed.envelopeHash, sealed.commitSignature], deposit);
    placed.push({ who, brief, sealed, decision });
    add({ phase: "commit", lane: "public", actor: who.account.address, tx: r.transactionHash,
      text: `BidCommitted: commitment ${short(sealed.commitment)} · ciphertext ${sealed.envelope.length.toLocaleString()} bytes (hash ${short(sealed.envelopeHash)}) · amount: hidden`,
      data: { bidder: who.account.address, commitment: sealed.commitment, envelopeHash: sealed.envelopeHash,
        ciphertextBytes: sealed.envelope.length, preview: bytesToHex(sealed.envelope.slice(0, 24)) } });
  }

  // an eavesdropper with the full ciphertext still learns nothing
  if (placed[0]) {
    try {
      openBid({ sealChainId: io.sealChainId, context: ctx(id, placed[0].who), envelope: placed[0].sealed.envelope, keys: opts.eavesdropper.seal });
      add({ phase: "commit", lane: "attack", actor: "eavesdropper", text: "UNEXPECTED: the eavesdropper opened a sealed bid." });
    } catch (e: any) {
      add({ phase: "commit", lane: "attack", actor: "eavesdropper",
        text: `Holds the full ${placed[0].sealed.envelope.length.toLocaleString()}-byte ciphertext of ${placed[0].brief.name}'s bid but cannot open it: “${String(e.message).slice(0, 80)}”. (ML-KEM-1024 resists quantum attackers too.)`,
        data: { outcome: "blocked" } });
    }
  }

  // ------------------------------------------------------------------ reveal
  await io.sleep(io.timings.commit + 5);
  add({ phase: "reveal", lane: "public", actor: "chain", text: "Commit phase over. Reveal phase open: anyone may reveal a bid that carries a valid ML-DSA-87 signature by the bidder's registered key." });

  let bySeller = 0, byBidder = 0;
  const revealGas: string[] = [];
  for (const p of placed) {
    const selfReveal = opts.selfRevealAgent === p.brief.name;
    let args: RevealArgs;
    if (selfReveal) {
      args = p.sealed.reveal; // the bidder kept their own opening
    } else {
      const opened = openBid({
        sealChainId: io.sealChainId, context: ctx(id, p.who), envelope: p.sealed.envelope, keys: seller.seal,
        bidderPqPublicKey: p.who.pq.publicKey,
      });
      args = opened.args;
      add({ phase: "reveal", lane: "private", actor: seller.name,
        text: `Decrypted ${p.brief.name}'s envelope: ${formatEther(args.amount)} QOR, signature checks out locally.`,
        data: { bidder: p.brief.name, amount: formatEther(args.amount) } });
    }
    if (io.authorize) await io.authorize(p.who, bidDigest(ctx(id, p.who), args.amount, args.salt), args.signature);
    const revealer = selfReveal ? p.who : seller;
    const r = await write(revealer, "reveal", [id, args]);
    selfReveal ? byBidder++ : bySeller++;
    revealGas.push(r.gasUsed.toString());
    add({ phase: "reveal", lane: "public", actor: revealer.account.address, tx: r.transactionHash, gas: r.gasUsed.toString(),
      text: `BidRevealed: ${p.who.account.address.slice(0, 8)}… bid ${formatEther(args.amount)} QOR${selfReveal ? " — revealed by the bidder themselves (seller went offline)" : ""}. ML-DSA-87 signature verified on-chain (${r.gasUsed.toLocaleString()} gas).`,
      data: { bidder: p.who.account.address, amount: formatEther(args.amount), selfReveal } });
  }

  // ------------------------------------------------------------------ settle
  await io.sleep(io.timings.reveal + 5);
  const fin = await write(opts.finalizer ?? opts.eavesdropper, "finalize", [id]); // anyone can finalize
  const info = await read<any>("auctionInfo", [id]);
  const zero = "0x0000000000000000000000000000000000000000";
  const winner = info.winner !== zero ? placed.find((p) => p.who.account.address.toLowerCase() === info.winner.toLowerCase()) : undefined;
  add({ phase: "settle", lane: "public", actor: "chain", tx: fin.transactionHash,
    text: winner
      ? `Finalized: ${winner.brief.name} (${info.winner.slice(0, 8)}…) wins and pays the SECOND price, ${formatEther(info.price)} QOR — not their own bid.`
      : "Finalized: reserve not met, no sale.",
    data: { winner: info.winner, price: formatEther(info.price) } });

  if (winner) {
    const due = info.price > deposit ? info.price - deposit : 0n;
    const r = await write(winner.who, "payWinning", [id], due);
    add({ phase: "settle", lane: "public", actor: winner.who.account.address, tx: r.transactionHash,
      text: `WinnerPaid: ${winner.brief.name} sends ${formatEther(due)} QOR on top of the ${formatEther(deposit)} QOR deposit.` });
  }

  // ------------------------------------------------------------------ withdraw (every payout needs an ML-DSA signature)
  const victim = placed.find((p) => p !== winner);
  if (victim) {
    // simulated theft: the attacker has the victim's classical key but not their ML-DSA key
    const bogus = bytesToHex(pqcSign(opts.thief.pq.secretKey, new Uint8Array(32)));
    try {
      // eth_call as the victim: the exact revert reason, and no window slot or gas is spent
      await io.publicClient.simulateContract({
        address: io.auction, abi: io.auctionAbi, functionName: "withdraw", args: [id, bogus],
        account: victim.who.account,
      } as any);
      add({ phase: "withdraw", lane: "attack", actor: "thief", text: "UNEXPECTED: the thief withdrew with a stolen classical key." });
    } catch (e: any) {
      add({ phase: "withdraw", lane: "attack", actor: "thief",
        text: `Q-Day: with ${victim.brief.name}'s recovered ECDSA key the thief calls withdraw() — rejected: “${revertReason(e)}”. Funds need the ML-DSA-87 signature too.`,
        data: { outcome: "blocked", reason: revertReason(e) } });
    }
  }
  const payees = [...placed.filter((p) => p !== winner), ...(winner ? [winner] : [])].map((p) => ({ who: p.who, label: p.brief.name }));
  payees.push({ who: seller, label: `${seller.name} (seller)` });
  for (const { who, label } of payees) {
    const owed = await read<bigint>("owed", [id, who.account.address]);
    if (owed === 0n) continue;
    const nonce = await read<bigint>("withdrawNonce", [who.account.address]);
    const digest = withdrawDigest({ evmChainId: io.evmChainId, contract: io.auction, auctionId: id, account: who.account.address, nonce });
    const sig = bytesToHex(pqcSign(who.pq.secretKey, signingMessage(digest)));
    if (io.authorize) await io.authorize(who, digest, sig);
    const r = await write(who, "withdraw", [id, sig]);
    add({ phase: "withdraw", lane: "public", actor: who.account.address, tx: r.transactionHash, gas: r.gasUsed.toString(),
      text: `Withdrawn: ${label} receives ${formatEther(owed)} QOR, authorised by an ML-DSA-87 signature.`,
      data: { owed: formatEther(owed) } });
  }

  return {
    log, auctionId: id.toString(), contract: io.auction, chainId: io.evmChainId,
    winner: winner?.brief.name, price: winner ? formatEther(info.price) : undefined,
    summary: { bids: placed.length, revealedBySeller: bySeller, revealedByBidder: byBidder, revealGas },
  };
}
