import { test } from "node:test";
import assert from "node:assert/strict";
import { runLocalDemo } from "../src/sealedbid/localDemo.js";

test("end-to-end: four agents, second-price outcome, censorship fallback, blocked attacks", async () => {
  const r = await runLocalDemo();
  assert.equal(r.winner, "Ada");           // valuation 9
  assert.equal(r.price, "7.5");            // Bram's bid: second price, not Ada's 9
  assert.equal(r.summary.bids, 3);         // Dara (value 1.2) is under the 2 QOR reserve and sits out
  assert.equal(r.summary.revealedByBidder, 1); // Chidi revealed his own bid
  assert.equal(r.summary.revealedBySeller, 2);
  const attacks = r.log.filter((e) => e.lane === "attack");
  assert.equal(attacks.length, 2);
  assert.ok(attacks.every((a) => a.data?.outcome === "blocked"), "every attack must be blocked");
  // no plaintext amount appears in any public commit-phase entry
  for (const e of r.log.filter((x) => x.phase === "commit" && x.lane === "public")) {
    assert.ok(!/QOR/.test(e.text.replace(/Reserve|deposit/gi, "")) || /hidden/.test(e.text));
  }
});
