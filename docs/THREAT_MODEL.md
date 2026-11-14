# SealedBid threat model

Scope: `contracts/SealedBidAuction.sol`, the sealing layer in `src/sealedbid/core.ts`, and the deployment flow.
Written for the Q-Day Drill (an attacker who has recovered the **classical** ECDSA key of an account) and for general review.

## Assets
* Deposits and winning payments (native QOR) held by the contract.
* Bid confidentiality until the reveal phase.
* Bid integrity (nobody can create, change or swap a bid).

## Actors and capabilities
| Actor | Has | Wants |
|---|---|---|
| Quantum-era eavesdropper | Every public ciphertext, forever | Learn bid amounts |
| Drill attacker | A victim's ECDSA key (not their ML-DSA key) | Move or lock the victim's funds |
| Dishonest seller | Own ML-KEM key, can reveal | Forge, alter, censor or steal bids |
| Dishonest bidder | Own keys | Win without paying, grief others |
| Anyone | Can call permissionless functions | Break settlement |

## Attack matrix

| # | Attack | Outcome | Defence | Test |
|---|---|---|---|---|
| 1 | Read a sealed bid from the public ciphertext | Blocked | ML-KEM-1024 envelope; only the seller's key opens it | `sealing` |
| 2 | Replay a ciphertext into another auction or as another bidder | Blocked | AAD binds chain, contract, auction id, bidder | `sealing` |
| 3 | Drill attacker calls `withdraw` with a victim's ECDSA key | **Blocked** | `withdraw` requires an ML-DSA signature by the registered key | `Q-Day: a stolen classical key cannot withdraw` |
| 4 | Drill attacker forces the victim's deposit into an attacker-run auction via `commitBid` | **Blocked** | `commitBid` requires an ML-DSA signature over (auction, bidder, commitment, envelope hash) | `Q-Day: … cannot force a victim's deposit` |
| 5 | Replay a valid withdraw signature | Blocked | Per-account nonce is part of the digest | same test as 3 |
| 6 | Seller invents or edits a bid | Blocked | Reveal needs the bidder's ML-DSA signature over amount + salt, checked on-chain | `reveal rejects a wrong amount…` |
| 7 | Seller hides a bid to steal the deposit or change the winner | Blocked | `reveal` is permissionless; the bidder reveals themselves | `a censoring seller cannot suppress a bid` |
| 8 | Winner refuses to pay | Contained | Deposit forfeited to seller, item unsold | `a winner who never pays forfeits…` |
| 9 | Seller or finalizer front-runs the outcome | Blocked | Outcome is a pure function of revealed, signed bids; ties go to the earlier commit | `ties go to the earlier commit` |
| 10 | Unprotected account bids (no registered PQ key) | Blocked | Commit and reveal check `pqcKeyStatus` (registered **and** possession proven) | `phase, deposit, identity and PQ-key rules` |
| 11 | Reentrancy on payout | Blocked | State is zeroed before the external call; pull payments only | by construction |
| 12 | Silent failure if a precompile is inactive (it returns `0x`) | Blocked | Typed interface calls revert when the return data is empty | by construction |

## Defence in depth for the Drill

On QoreChain an EVM transaction needs a registered PQ key *and* an open authorisation window, and the window can only
be opened by a hybrid-signed Cosmos message. So an attacker with only the ECDSA key usually cannot send an EVM
transaction at all. SealedBid does not rely on that alone: if a window **is** open (the victim is mid-auction), the
contract still refuses to move value in either direction without the owner's ML-DSA signature. That closes the case
where the chain-level gate is open but the key is compromised.

Drill guidance: use a **fresh** account; its ECDSA key is published after the drill, so never reuse it.

## Residual risks and non-goals
* **The seller can read bids.** The design prevents cheating, not knowledge. Mitigation path: threshold decryption.
* **Denial of service by a non-revealing seller** delays settlement until the reveal window ends; bidders can reveal
  themselves, so the auction still resolves correctly.
* **Gas:** each verification is ~90k gas plus calldata; very large auctions need batching (`revealMany`).
* **Precompile semantics** were checked with `eth_call` against testnet (`scripts/03-precompile-probe.ts`); behaviour
  inside a state-changing, windowed transaction is checked by `npm run testnet -- probe`.
* **QoreSeal** is pre-1.0 and pending external review per its authors.
* Not audited. Testnet only.
