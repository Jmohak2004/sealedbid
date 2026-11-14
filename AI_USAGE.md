# AI usage

This project (SealedBid, QoreChain Build Before Q-Day 2026) is built with AI assistance. This file is a running,
honest log of where and how, kept up to date as the work happens.

## Tools
- Claude Code (Claude Sonnet 5.5) as a pair-programming agent in the terminal/IDE.
- Claude (via the Anthropic API) as the runtime brain of the bidder agents in the product itself.

## Build-time use (what the assistant did)
- Researched the fest rules, kits and chain docs, and compared candidate projects with parallel research agents
  (ideation, prize-maths, and verification passes). A competitor scan moved the project to the least crowded category.
- Wrote the Solidity contract, the TypeScript sealing/signing library, the bidder agents, the demo orchestrator,
  the React replay UI, the test-suite (18 tests) and the testnet pipeline, under human direction.
- Found and fixed a design hole during threat modelling: deposits were not PQ-gated, so a stolen classical key could
  lock a victim's deposit in an attacker's auction. `commitBid` now needs an ML-DSA signature, with a regression test.
- Verified the central on-chain assumption against the live testnet (`scripts/03-precompile-probe.ts`) instead of
  trusting the docs.
- Human decisions: project choice and category, which accounts to create and fund, what to submit, everything
  involving keys, wallets, faucets and the drill registration.

## Run-time use (what AI does inside the product)
- Implemented: LLM bidder agents (`src/agents/bidder.ts`, model `claude-sonnet-5-5`) with private valuations decide bids; all bids are sealed client-side with ML-KEM-1024
  (QoreSeal) and bound with ML-DSA-87 signatures before anything leaves the bidder's machine.

## What is NOT AI-generated / verified by a human
- Keys, funding and the Q-Day Drill registration are done by the human owner.
- What is verified where (real testnet vs. local mock) is stated precisely in the README; nothing is claimed beyond that.
