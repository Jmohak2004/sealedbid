// Runs the full SealedBid story on the in-process mock chain (no network, no funds).
import { DEFAULT_AGENTS } from "../agents/bidder.js";
import { runDemo, type ChainIO, type DemoResult, type LogEntry } from "./demo.js";
import {
  allowSignature, newParticipant, registerPq, startLocalChain, LOCAL_CHAIN_ID, SEAL_CHAIN_ID,
} from "./local.js";
import { signingMessage } from "./core.js";
import { hexToBytes } from "viem";

export async function runLocalDemo(onEntry?: (e: LogEntry) => void): Promise<DemoResult> {
  const deployer = newParticipant("deployer");
  const seller = newParticipant("Seller");
  const eavesdropper = newParticipant("Eve");
  const thief = newParticipant("Thief");
  const agents = DEFAULT_AGENTS.map((brief) => ({ who: newParticipant(brief.name), brief }));
  const everyone = [deployer, seller, eavesdropper, thief, ...agents.map((a) => a.who)];

  const chain = await startLocalChain(everyone);
  for (const p of [seller, ...agents.map((a) => a.who)]) await registerPq(chain, p, deployer);

  const io: ChainIO = {
    publicClient: chain.publicClient, walletFor: chain.walletFor, auction: chain.auction,
    auctionAbi: chain.auctionAbi as any, evmChainId: LOCAL_CHAIN_ID, sealChainId: SEAL_CHAIN_ID,
    sleep: (s) => chain.increaseTime(s),
    authorize: (p, digest, sig) => allowSignature(chain, deployer, p.pq.publicKey, signingMessage(digest), sig),
    timings: { commit: 600, reveal: 600, pay: 600 },
  };
  return runDemo({ io, seller, eavesdropper, thief, agents, selfRevealAgent: "Chidi", onEntry });
}
