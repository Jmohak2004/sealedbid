import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { fallbackDecision, sanitize, decideBid, type AgentBrief, type AuctionBrief } from "../src/agents/bidder.js";

const auction: AuctionBrief = {
  item: "Q-Day Genesis licence", reserve: parseEther("2"), deposit: parseEther("1"),
  rule: "second-price (Vickrey): the highest bidder wins but pays the second-highest bid (or the reserve)",
};
const agent = (valuation: string, budget: string): AgentBrief => ({
  name: "T", persona: "test", valuation: parseEther(valuation), budget: parseEther(budget),
});

test("fallback bids true value, capped by budget, and skips below the reserve", () => {
  assert.equal(fallbackDecision(agent("9", "12"), auction).bid, parseEther("9"));
  assert.equal(fallbackDecision(agent("9", "5"), auction).bid, parseEther("5"));
  assert.equal(fallbackDecision(agent("1", "5"), auction).bid, 0n);
});

test("sanitize: an LLM can never exceed the budget or bid under the reserve", () => {
  assert.equal(sanitize(agent("9", "6"), auction, { bid: "100", reasoning: "x" }).bid, parseEther("6"));
  assert.equal(sanitize(agent("9", "6"), auction, { bid: "1.5", reasoning: "x" }).bid, 0n);
  assert.equal(sanitize(agent("9", "6"), auction, { bid: "4.25", reasoning: "x" }).bid, parseEther("4.25"));
  // garbage falls back to the deterministic rule
  assert.equal(sanitize(agent("9", "6"), auction, { bid: "lots", reasoning: "x" }).source, "fallback");
});

test("decideBid uses the model's answer, and survives an API failure", async () => {
  const ok: any = { messages: { create: async () => ({ content: [{ type: "text", text: 'sure {"bid":"7","reasoning":"I bid my value."} done' }] }) } };
  const d = await decideBid(agent("9", "12"), auction, ok);
  assert.equal(d.bid, parseEther("7"));
  assert.equal(d.source, "claude");
  const broken: any = { messages: { create: async () => { throw new Error("529 overloaded"); } } };
  assert.equal((await decideBid(agent("9", "12"), auction, broken)).source, "fallback");
});
