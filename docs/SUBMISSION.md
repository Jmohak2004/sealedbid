# Submission checklist (deadline 2 Dec 2026 23:59 UTC, no submit button: the project locks)

Everything marked **YOU** needs your own accounts or a human decision. The rest is done in this repo.

## Before 17 Nov 23:59 UTC: Q-Day Drill (optional, $200 x 5)
- [ ] **YOU** Fund a *fresh* drill account from the faucet and register its ML-DSA-87 key.
- [ ] **YOU** Register on the drill form: that account's ECDSA private key (it gets **published** after the drill, so
      never reuse it) and up to 5 contract addresses. Needs a deployed contract: run `npm run testnet -- setup` first.
- [ ] **YOU** On 18 Nov make one normal transaction from the drill account and submit its hash by 19 Nov.
- Keys prepared locally in `keys/drill.json` (gitignored). Do **not** put the drill account in `setup`/`demo`.

## Get on-chain (needs test QOR, ~5 QOR each)
- [ ] **YOU** Fund `deployer`, `auctioneer`, `bidder1`, `bidder2`, `bidder3` from https://dashboard.qorechain.io/faucet
- [ ] `npm run testnet -- probe`  → must print `PROBE PASSED` (in-window precompile call)
- [ ] `npm run testnet -- setup`  → writes `deployments/testnet.json` (the contract address to submit)
- [ ] `npm run testnet -- demo`   → records `public/demo-log.json` with `mode: "testnet"`, real tx hashes
- [ ] `npm run build` and redeploy/host the UI (any static host)

## Project form (from build.qorechain.io/start)
- [ ] **YOU** Register: GitHub + X + QoreX wallet on testnet (18+, accept Terms)
- [ ] **YOU** Public GitHub repo, **MIT** licence (present), README (present). Install the *QoreChain Build* GitHub App.
- [ ] Category: **Encrypted Apps** (1–4 people). Special awards are open to every project.
- [ ] Cover image: `docs/cover.png` is 1280×720 PNG (needs ≥1200×675, ≤5 MB). Re-take with `npx tsx scripts/screenshot.ts`
      after the testnet recording so it shows the testnet banner.
- [ ] Video ≤ 3:00 (script below)
- [ ] At least one testnet address (`qor1…`): use the deployer/auctioneer address from `npm run testnet -- status`
- [ ] Kits ticked must match the code. Truthfully used: **QoreChain SDK** (`@qorechain/sdk`) and **QoreSeal**
      (`@qorechain/qoreseal`); network features: PQC precompiles, ML-KEM key registry, EVM authorisation window.
      (`@qorechain/pqc` is used only through the SDK, so do not tick it separately.)
- [ ] `AI_USAGE.md` present (Best AI-Native Build). Keep it truthful.
- [ ] Commits made *during* the fest (4 Nov – 2 Dec), no history rewriting, no squashing.
- [ ] Final scan: no `.env`, no `keys/`, no mnemonics anywhere in git history.
- [ ] Re-read https://build.qorechain.io/rules a day before; the organiser may change them.

## Video script (2:45)
| Time | On screen | Say |
|---|---|---|
| 0:00 | Title + the problem | "Public auctions leak bids, and classical crypto will not protect them from a quantum computer." |
| 0:15 | UI: press Play; left pane (chain) vs right pane (agents) | "Four Claude agents bid on a licence. Left is what the chain and an eavesdropper see. Right is what only the agents and seller know." |
| 0:45 | Commit entries: `amount: hidden`, ciphertext bytes, eavesdropper attack | "Each bid is sealed with ML-KEM-1024 and signed with ML-DSA-87. On-chain: only hashes. The eavesdropper holds the full ciphertext and learns nothing." |
| 1:15 | Reveal entries incl. the self-reveal | "The seller reveals for everyone. When the seller goes offline, Chidi reveals his own bid, so nobody can censor a bid. The contract verifies each ML-DSA signature through the precompile, in a real transaction." |
| 1:50 | Settle + result card | "Second price: Ada wins at Bram's bid, so honest bidding is optimal." |
| 2:10 | The blocked thief entry | "Q-Day: a stolen ECDSA key calls withdraw and is rejected. Deposits and payouts both need the owner's ML-DSA signature." |
| 2:30 | README "verified" section + explorer link | "Everything is open source, tested, and checked against the testnet precompile." |
