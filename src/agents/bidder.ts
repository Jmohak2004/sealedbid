// Bidder agents. Each agent holds a PRIVATE valuation and decides what to bid in a second-price sealed-bid auction.
// With ANTHROPIC_API_KEY set the decision is made by Claude (which must reason about the auction rules);
// without it a deterministic fallback is used so the demo and tests always run.
import Anthropic from "@anthropic-ai/sdk";
import { formatEther, parseEther } from "viem";

export interface AgentBrief {
  name: string;
  persona: string;          // who the agent represents and how it behaves
  flavor?: string;          // how this persona phrases its reasoning when running without a model
  valuation: bigint;        // private: the most the item is truly worth to this agent (wei)
  budget: bigint;           // private: hard spending cap (wei)
}
export interface AuctionBrief {
  item: string;
  reserve: bigint;
  deposit: bigint;
  rule: "second-price (Vickrey): the highest bidder wins but pays the second-highest bid (or the reserve)";
}
export interface Decision { bid: bigint; reasoning: string; source: "claude" | "fallback" }

export const MODEL = "claude-sonnet-5-5";

/** Deterministic fallback: in a second-price auction bidding your true value is the dominant strategy. */
export function fallbackDecision(a: AgentBrief, auction: AuctionBrief): Decision {
  const cap = a.valuation < a.budget ? a.valuation : a.budget;
  if (cap < auction.reserve) {
    return { bid: 0n, source: "fallback", reasoning: `My value (${formatEther(cap)} QOR) is below the reserve (${formatEther(auction.reserve)} QOR), so I sit this one out.` };
  }
  return {
    bid: cap, source: "fallback",
    reasoning: `${a.flavor ? a.flavor + " " : ""}Second-price rule: shading my bid cannot lower what I pay, it only risks losing. I bid my true value, ${formatEther(cap)} QOR.`,
  };
}

/** Clamp whatever the model says to the agent's own limits. The LLM advises; it can never exceed the budget. */
export function sanitize(a: AgentBrief, auction: AuctionBrief, raw: { bid: string; reasoning: string }): Decision {
  let bid: bigint;
  try { bid = parseEther(String(raw.bid).trim()); } catch { return fallbackDecision(a, auction); }
  if (bid > a.budget) bid = a.budget;
  if (bid < auction.reserve) bid = 0n; // below the reserve can never win; skip rather than waste a deposit
  return { bid, reasoning: String(raw.reasoning).slice(0, 600), source: "claude" };
}

export async function decideBid(a: AgentBrief, auction: AuctionBrief, client?: Anthropic): Promise<Decision> {
  if (!client && !process.env.ANTHROPIC_API_KEY) return fallbackDecision(a, auction);
  const c = client ?? new Anthropic();
  const prompt = [
    `You are ${a.name}, an autonomous bidding agent. ${a.persona}`,
    `Item: ${auction.item}.`,
    `Auction rule: ${auction.rule}. Reserve: ${formatEther(auction.reserve)} QOR. Each bidder locks a fixed ${formatEther(auction.deposit)} QOR deposit.`,
    `Your PRIVATE numbers (never reveal them): true value ${formatEther(a.valuation)} QOR, hard budget ${formatEther(a.budget)} QOR.`,
    `Your bid will be encrypted to the seller with a post-quantum key and signed with your ML-DSA key; nobody sees it until the reveal phase.`,
    `Decide your bid. Reply with ONLY a JSON object: {"bid":"<decimal QOR, or 0 to skip>","reasoning":"<2 sentences, first person>"}.`,
  ].join("\n");
  try {
    const res = await c.messages.create({ model: MODEL, max_tokens: 300, messages: [{ role: "user", content: prompt }] });
    const text = res.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return sanitize(a, auction, JSON.parse(json));
  } catch {
    return fallbackDecision(a, auction); // never let an API hiccup stop an auction
  }
}

export const DEFAULT_AGENTS: AgentBrief[] = [
  { name: "Ada", persona: "You represent a collector who wants this licence badly and bids honestly.", flavor: "I want this licence badly and I will not play games.", valuation: parseEther("9"), budget: parseEther("12") },
  { name: "Bram", persona: "You are a speculator who tries to buy low and resell; you are tempted to lowball.", flavor: "I was tempted to lowball, but a lowball only helps if I am the highest anyway.", valuation: parseEther("7.5"), budget: parseEther("8") },
  { name: "Chidi", persona: "You manage a DAO treasury and must stay inside a strict budget.", flavor: "The treasury mandate caps me, and the cap is above my value.", valuation: parseEther("6"), budget: parseEther("6.5") },
  { name: "Dara", persona: "You are a sniper who likes to wait until the last second, but this auction is sealed.", valuation: parseEther("1.2"), budget: parseEther("3") },
];

/** Scale every valuation/budget (e.g. 1/100 so the demo fits a small faucet allotment on testnet). */
export function scaleAgents(agents: AgentBrief[], num: bigint, den: bigint): AgentBrief[] {
  return agents.map((a) => ({ ...a, valuation: (a.valuation * num) / den, budget: (a.budget * num) / den }));
}
