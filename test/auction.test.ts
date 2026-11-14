import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, parseEther, hexToBytes, type Address, type Hex } from "viem";
import { pqcSign, pqcVerify } from "@qorechain/sdk";
import { recipientOf } from "@qorechain/qoreseal";
import {
  newParticipant, startLocalChain, registerPq, allowSignature, LOCAL_CHAIN_ID, SEAL_CHAIN_ID,
  type LocalChain, type Participant,
} from "../src/sealedbid/local.js";
import {
  bidDigest, commitDigest, commitmentOf, kemKeyHash, openBid, sealBid, signingMessage, withdrawDigest, randomSalt,
  type BidContext,
} from "../src/sealedbid/core.js";

const DEPOSIT = parseEther("1");
const RESERVE = parseEther("2");

async function expectRevert(p: Promise<unknown>, reason: string) {
  try { await p; } catch (e: any) {
    const msg = `${e?.shortMessage ?? ""} ${e?.message ?? ""} ${e?.details ?? ""}`;
    assert.ok(msg.includes(reason), `expected revert "${reason}", got: ${msg.slice(0, 300)}`);
    return;
  }
  assert.fail(`expected revert "${reason}" but call succeeded`);
}

class Env {
  chain!: LocalChain;
  deployer = newParticipant("deployer");
  seller = newParticipant("seller");
  alice = newParticipant("alice");
  bob = newParticipant("bob");
  carol = newParticipant("carol");
  mallory = newParticipant("mallory"); // holds a bidder's classical key only
  all = [this.deployer, this.seller, this.alice, this.bob, this.carol, this.mallory];

  async init() {
    this.chain = await startLocalChain(this.all);
    for (const p of [this.seller, this.alice, this.bob, this.carol]) await registerPq(this.chain, p, this.deployer);
  }
  ctx(auctionId: bigint, who: Participant): BidContext {
    return { evmChainId: LOCAL_CHAIN_ID, contract: this.chain.auction, auctionId, bidder: who.account.address };
  }
  async write(who: Participant, fn: string, args: unknown[], value?: bigint) {
    const hash = await this.chain.walletFor(who).writeContract({
      address: this.chain.auction, abi: this.chain.auctionAbi, functionName: fn, args, value, gas: 3_000_000n,
    });
    return this.chain.publicClient.waitForTransactionReceipt({ hash });
  }
  read<T = any>(fn: string, args: unknown[] = []): Promise<T> {
    return this.chain.publicClient.readContract({
      address: this.chain.auction, abi: this.chain.auctionAbi, functionName: fn, args,
    }) as Promise<T>;
  }
  bal(a: Address) { return this.chain.publicClient.getBalance({ address: a }); }

  async createAuction(commit = 600, reveal = 600, pay = 600): Promise<bigint> {
    await this.write(this.seller, "createAuction", [
      "ipfs://q-day-genesis-licence-1", kemKeyHash(this.seller.seal.mlkemPublicKey), RESERVE, DEPOSIT,
      BigInt(commit), BigInt(reveal), BigInt(pay),
    ]);
    return await this.read<bigint>("auctionCount");
  }
  /** A bidder seals + commits. Returns what the bidder keeps. */
  async bid(id: bigint, who: Participant, amount: bigint) {
    const sealed = sealBid({
      sealChainId: SEAL_CHAIN_ID, context: this.ctx(id, who), amount,
      auctioneer: recipientOf(this.seller.seal), pqSecretKey: who.pq.secretKey,
    });
    await this.allow(who, sealed.commitDigest, sealed.commitSignature);
    await this.write(who, "commitBid", [id, sealed.commitment, sealed.envelopeHash, sealed.commitSignature], DEPOSIT);
    return sealed;
  }
  /** Mirror of the precompile: check the real ML-DSA signature, then let the mock accept exactly that triple. */
  async allow(who: Participant, digest: Hex, signature: Hex) {
    assert.ok(pqcVerify(who.pq.publicKey, signingMessage(digest), hexToBytes(signature)), "test bug: sig invalid");
    await allowSignature(this.chain, this.deployer, who.pq.publicKey, signingMessage(digest), signature);
  }
  async revealFor(id: bigint, who: Participant, sealed: Awaited<ReturnType<Env["bid"]>>, by: Participant) {
    const opened = openBid({
      sealChainId: SEAL_CHAIN_ID, context: this.ctx(id, who), envelope: sealed.envelope, keys: this.seller.seal,
      bidderPqPublicKey: who.pq.publicKey,
    });
    await this.allow(who, bidDigest(this.ctx(id, who), opened.args.amount, opened.args.salt), opened.args.signature);
    return this.write(by, "reveal", [id, opened.args]);
  }
  async withdraw(id: bigint, who: Participant) {
    const nonce = await this.read<bigint>("withdrawNonce", [who.account.address]);
    const digest = withdrawDigest({
      evmChainId: LOCAL_CHAIN_ID, contract: this.chain.auction, auctionId: id, account: who.account.address, nonce,
    });
    const sig = bytesToHex(pqcSign(who.pq.secretKey, signingMessage(digest)));
    await this.allow(who, digest, sig);
    return this.write(who, "withdraw", [id, sig]);
  }
}

describe("digest parity with the Solidity contract", () => {
  const env = new Env();
  before(() => env.init());

  test("bidDigest, commitmentOf and withdrawDigest match the contract", async () => {
    const id = 7n, amount = parseEther("3.5"), salt = randomSalt();
    const c = env.ctx(id, env.alice);
    assert.equal(await env.read("bidDigest", [id, c.bidder, amount, salt]), bidDigest(c, amount, salt));
    assert.equal(await env.read("commitmentOf", [id, c.bidder, amount, salt]), commitmentOf(c, amount, salt));
    const cm = commitmentOf(c, amount, salt), eh = randomSalt();
    assert.equal(await env.read("commitDigest", [id, c.bidder, cm, eh]), commitDigest(c, cm, eh));
    assert.equal(
      await env.read("withdrawDigest", [id, c.bidder]),
      withdrawDigest({ evmChainId: LOCAL_CHAIN_ID, contract: env.chain.auction, auctionId: id, account: c.bidder, nonce: 0n }),
    );
  });
});

describe("sealing", () => {
  const env = new Env();
  before(() => env.init());

  test("only the seller can open a sealed bid, and it is bound to its auction", async () => {
    const id = 1n;
    const s = sealBid({
      sealChainId: SEAL_CHAIN_ID, context: env.ctx(id, env.alice), amount: parseEther("5"),
      auctioneer: recipientOf(env.seller.seal), pqSecretKey: env.alice.pq.secretKey,
    });
    const ok = openBid({ sealChainId: SEAL_CHAIN_ID, context: env.ctx(id, env.alice), envelope: s.envelope, keys: env.seller.seal });
    assert.equal(ok.args.amount, parseEther("5"));
    assert.equal(ok.commitment, s.commitment);
    // a stranger cannot read it
    assert.throws(() => openBid({ sealChainId: SEAL_CHAIN_ID, context: env.ctx(id, env.alice), envelope: s.envelope, keys: env.bob.seal }));
    // replaying the same ciphertext for another auction or bidder fails (AAD binding)
    assert.throws(() => openBid({ sealChainId: SEAL_CHAIN_ID, context: env.ctx(2n, env.alice), envelope: s.envelope, keys: env.seller.seal }));
    assert.throws(() => openBid({ sealChainId: SEAL_CHAIN_ID, context: env.ctx(id, env.bob), envelope: s.envelope, keys: env.seller.seal }));
    // the plaintext amount is nowhere in the public ciphertext
    assert.ok(!bytesToHex(s.envelope).includes(parseEther("5").toString(16)));
  });

  test("a forged signature is caught before any gas is spent", () => {
    const s = sealBid({
      sealChainId: SEAL_CHAIN_ID, context: env.ctx(1n, env.alice), amount: parseEther("5"),
      auctioneer: recipientOf(env.seller.seal), pqSecretKey: env.bob.pq.secretKey, // signed with the WRONG key
    });
    assert.throws(
      () => openBid({
        sealChainId: SEAL_CHAIN_ID, context: env.ctx(1n, env.alice), envelope: s.envelope, keys: env.seller.seal,
        bidderPqPublicKey: env.alice.pq.publicKey,
      }), /signature does not verify/);
  });
});

describe("auction lifecycle", () => {
  test("happy path: second-price settlement and exact money flow", async () => {
    const env = new Env(); await env.init();
    const id = await env.createAuction();
    const a = await env.bid(id, env.alice, parseEther("5"));
    const b = await env.bid(id, env.bob, parseEther("8"));   // highest
    const c = await env.bid(id, env.carol, parseEther("6")); // second -> sets the price

    // while bidding is open, nothing on-chain reveals an amount
    const info0 = await env.read<any>("auctionInfo", [id]);
    assert.equal(info0.topAmount, 0n);

    await env.chain.increaseTime(601); // into the reveal phase
    // the seller reveals for alice and bob; carol reveals her own bid
    await env.revealFor(id, env.alice, a, env.seller);
    await env.revealFor(id, env.bob, b, env.seller);
    await env.revealFor(id, env.carol, c, env.carol);

    await env.chain.increaseTime(601);
    await env.write(env.mallory, "finalize", [id]); // anyone can finalize
    const info = await env.read<any>("auctionInfo", [id]);
    assert.equal(info.winner.toLowerCase(), env.bob.account.address.toLowerCase());
    assert.equal(info.price, parseEther("6")); // second price, not 8

    // winner pays price - deposit (6 - 1 = 5)
    const sellerBefore = await env.bal(env.seller.account.address);
    await env.write(env.bob, "payWinning", [id], parseEther("5"));
    assert.equal(await env.read("owed", [id, env.seller.account.address]), parseEther("6"));

    // payouts (each needs an ML-DSA signature)
    await env.withdraw(id, env.alice); // loser: deposit back
    await env.withdraw(id, env.carol);
    await env.withdraw(id, env.seller);
    const gained = (await env.bal(env.seller.account.address)) - sellerBefore;
    assert.ok(gained > parseEther("5.99") && gained <= parseEther("6"), `seller gained ${gained}`); // minus gas
    // winner's deposit (1) is below the price (6): nothing to refund
    await expectRevert(env.withdraw(id, env.bob), "nothing owed");
    assert.equal(await env.bal(env.chain.auction), 0n, "contract must end empty");
  });

  test("a single bidder pays the reserve, not their own bid", async () => {
    const env = new Env(); await env.init();
    const id = await env.createAuction();
    const a = await env.bid(id, env.alice, parseEther("10"));
    await env.chain.increaseTime(601);
    await env.revealFor(id, env.alice, a, env.seller);
    await env.chain.increaseTime(601);
    await env.write(env.alice, "finalize", [id]);
    assert.equal((await env.read<any>("auctionInfo", [id])).price, RESERVE);
  });

  test("reserve not met: no sale, bidders get deposits back", async () => {
    const env = new Env(); await env.init();
    const id = await env.createAuction();
    const a = await env.bid(id, env.alice, parseEther("1.5")); // below the 2 QOR reserve
    await env.chain.increaseTime(601);
    await env.revealFor(id, env.alice, a, env.seller);
    await env.chain.increaseTime(601);
    await env.write(env.alice, "finalize", [id]);
    const info = await env.read<any>("auctionInfo", [id]);
    assert.equal(info.winner, "0x0000000000000000000000000000000000000000");
    await expectRevert(env.write(env.alice, "payWinning", [id], 0n), "no sale");
    assert.equal(await env.read("owed", [id, env.alice.account.address]), DEPOSIT);
    await env.withdraw(id, env.alice);
  });

  test("ties go to the earlier commit and the price equals the tied amount", async () => {
    const env = new Env(); await env.init();
    const id = await env.createAuction();
    const a = await env.bid(id, env.alice, parseEther("4"));
    const b = await env.bid(id, env.bob, parseEther("4"));
    await env.chain.increaseTime(601);
    await env.revealFor(id, env.bob, b, env.seller); // reveal order must not matter
    await env.revealFor(id, env.alice, a, env.seller);
    await env.chain.increaseTime(601);
    await env.write(env.alice, "finalize", [id]);
    const info = await env.read<any>("auctionInfo", [id]);
    assert.equal(info.winner.toLowerCase(), env.alice.account.address.toLowerCase());
    assert.equal(info.price, parseEther("4"));
  });

  test("a censoring seller cannot suppress a bid: the bidder reveals it themselves", async () => {
    const env = new Env(); await env.init();
    const id = await env.createAuction();
    const a = await env.bid(id, env.alice, parseEther("9"));
    const b = await env.bid(id, env.bob, parseEther("3"));
    await env.chain.increaseTime(601);
    await env.revealFor(id, env.bob, b, env.seller); // seller only reveals bob...
    await env.revealFor(id, env.alice, a, env.alice); // ...alice does it herself
    await env.chain.increaseTime(601);
    await env.write(env.carol, "finalize", [id]);
    const info = await env.read<any>("auctionInfo", [id]);
    assert.equal(info.winner.toLowerCase(), env.alice.account.address.toLowerCase());
    assert.equal(info.price, parseEther("3"));
  });

  test("unrevealed deposits are forfeited to the seller", async () => {
    const env = new Env(); await env.init();
    const id = await env.createAuction();
    await env.bid(id, env.alice, parseEther("5")); // never revealed by anyone
    await env.chain.increaseTime(1202);
    await env.write(env.carol, "finalize", [id]);
    assert.equal(await env.read("owed", [id, env.seller.account.address]), DEPOSIT);
    assert.equal(await env.read("owed", [id, env.alice.account.address]), 0n);
  });

  test("a winner who never pays forfeits their deposit; the item stays unsold", async () => {
    const env = new Env(); await env.init();
    const id = await env.createAuction();
    const a = await env.bid(id, env.alice, parseEther("5"));
    await env.chain.increaseTime(601);
    await env.revealFor(id, env.alice, a, env.seller);
    await env.chain.increaseTime(601);
    await env.write(env.carol, "finalize", [id]);
    await expectRevert(env.write(env.carol, "claimForfeit", [id]), "pay window open");
    await env.chain.increaseTime(601);
    await expectRevert(env.write(env.alice, "payWinning", [id], parseEther("1")), "pay window closed");
    await env.write(env.carol, "claimForfeit", [id]);
    assert.equal(await env.read("owed", [id, env.seller.account.address]), DEPOSIT);
  });
});

describe("rules enforced on-chain", () => {
  test("phase, deposit, identity and PQ-key rules", async () => {
    const env = new Env(); await env.init();
    const id = await env.createAuction();
    const mk = (who: Participant) => sealBid({
      sealChainId: SEAL_CHAIN_ID, context: env.ctx(id, who), amount: parseEther("5"),
      auctioneer: recipientOf(env.seller.seal), pqSecretKey: who.pq.secretKey,
    });
    const args = (s: ReturnType<typeof mk>) => [id, s.commitment, s.envelopeHash, s.commitSignature];
    const s = mk(env.alice);
    await env.allow(env.alice, s.commitDigest, s.commitSignature);
    await expectRevert(env.write(env.alice, "commitBid", args(s), DEPOSIT - 1n), "wrong deposit");
    const ss = mk(env.seller);
    await env.allow(env.seller, ss.commitDigest, ss.commitSignature);
    await expectRevert(env.write(env.seller, "commitBid", args(ss), DEPOSIT), "seller cannot bid");
    // mallory never registered a post-quantum key: cannot even commit (a bid that could never be revealed)
    const m = mk(env.mallory);
    await expectRevert(env.write(env.mallory, "commitBid", args(m), DEPOSIT), "PQ key not registered");
    await env.write(env.alice, "commitBid", args(s), DEPOSIT);
    await expectRevert(env.write(env.alice, "commitBid", args(s), DEPOSIT), "already bid");
    // revealing before the commit phase ends is refused
    await expectRevert(env.write(env.seller, "reveal", [id, s.reveal]), "not reveal phase");
    await env.chain.increaseTime(601);
    await expectRevert(env.write(env.alice, "commitBid", args(s), DEPOSIT), "commit closed");
  });

  test("Q-Day: a stolen classical key cannot force a victim's deposit into an attacker's auction", async () => {
    const env = new Env(); await env.init();
    const id = await env.createAuction(); // seller here plays the attacker's colluding seller
    // the thief holds ONLY alice's ECDSA key; the commit needs alice's ML-DSA signature, which he cannot make
    const forged = sealBid({
      sealChainId: SEAL_CHAIN_ID, context: env.ctx(id, env.alice), amount: parseEther("5"),
      auctioneer: recipientOf(env.seller.seal), pqSecretKey: env.mallory.pq.secretKey, // thief's own PQ key
    });
    await env.allow(env.mallory, forged.commitDigest, forged.commitSignature); // valid sig, but not alice's key
    const before = await env.bal(env.alice.account.address);
    await expectRevert(
      env.write(env.alice, "commitBid", [id, forged.commitment, forged.envelopeHash, forged.commitSignature], DEPOSIT),
      "bad ML-DSA signature");
    assert.ok((await env.bal(env.alice.account.address)) > before - parseEther("0.5"), "no deposit may leave alice");
    assert.equal((await env.read<any>("bids", [id, env.alice.account.address]))[3], 0); // BidStatus.None
  });

  test("reveal rejects a wrong amount and an unverifiable signature", async () => {
    const env = new Env(); await env.init();
    const id = await env.createAuction();
    const a = await env.bid(id, env.alice, parseEther("5"));
    await env.chain.increaseTime(601);
    // amount that does not match the commitment
    const lie = { ...a.reveal, amount: parseEther("50") };
    await expectRevert(env.write(env.seller, "reveal", [id, lie]), "commitment mismatch");
    // correct amount, but the precompile has not verified this signature -> rejected
    await expectRevert(env.write(env.seller, "reveal", [id, a.reveal]), "bad ML-DSA signature");
    // a signature made by a different key (mallory-style forgery) never verifies
    const forged = { ...a.reveal, signature: bytesToHex(pqcSign(env.bob.pq.secretKey, signingMessage(
      bidDigest(env.ctx(id, env.alice), a.reveal.amount, a.reveal.salt)))) };
    await env.allow(env.bob, bidDigest(env.ctx(id, env.alice), a.reveal.amount, a.reveal.salt), forged.signature);
    // bob's valid signature is whitelisted for BOB's key, but the contract checks against ALICE's registered key
    await expectRevert(env.write(env.seller, "reveal", [id, forged]), "bad ML-DSA signature");
  });

  test("Q-Day: a stolen classical key cannot withdraw (needs an ML-DSA signature), and signatures are single-use", async () => {
    const env = new Env(); await env.init();
    const id = await env.createAuction();
    const a = await env.bid(id, env.alice, parseEther("5"));
    await env.chain.increaseTime(601);
    await env.revealFor(id, env.alice, a, env.seller);
    await env.chain.increaseTime(601);
    await env.write(env.carol, "finalize", [id]);
    await env.write(env.alice, "payWinning", [id], parseEther("1")); // pays reserve 2 - deposit 1
    // attacker holds ONLY alice's ECDSA key: they can call withdraw but cannot produce her ML-DSA signature
    const attackerSig = bytesToHex(pqcSign(env.mallory.pq.secretKey, new Uint8Array(32)));
    await expectRevert(env.write(env.alice, "withdraw", [id, attackerSig]), "bad ML-DSA signature");
    // the legitimate signature works once...
    const seller = env.seller;
    const nonce = await env.read<bigint>("withdrawNonce", [seller.account.address]);
    const d = withdrawDigest({ evmChainId: LOCAL_CHAIN_ID, contract: env.chain.auction, auctionId: id, account: seller.account.address, nonce });
    const sig = bytesToHex(pqcSign(seller.pq.secretKey, signingMessage(d)));
    await env.allow(seller, d, sig);
    await env.write(seller, "withdraw", [id, sig]);
    // ...and cannot be replayed: the nonce moved on, so the digest differs
    await expectRevert(env.write(seller, "withdraw", [id, sig]), "bad ML-DSA signature");
  });
});
