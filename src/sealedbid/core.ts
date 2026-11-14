// SealedBid core: digests, commitments, sealing and opening of bids.
// Runs in Node and the browser. The digests mirror contracts/SealedBidAuction.sol byte for byte.
import {
  bytesToHex, concatHex, encodeAbiParameters, hexToBytes, keccak256, stringToBytes, stringToHex,
  type Address, type Hex,
} from "viem";
import { open, seal, type SealKeyPair, type SealRecipient } from "@qorechain/qoreseal";
import { pqcSign, pqcVerify } from "@qorechain/sdk";

export const BID_DOMAIN = keccak256(stringToHex("SEALEDBID_BID_V1"));
export const COMMIT_DOMAIN = keccak256(stringToHex("SEALEDBID_COMMIT_V1"));
export const WITHDRAW_DOMAIN = keccak256(stringToHex("SEALEDBID_WITHDRAW_V1"));

/** What QoreSeal (and the chain registry) call the network, e.g. "qorechain-diana". */
export const SEAL_PURPOSE = "sealedbid/bid/v1";

export interface BidContext {
  /** EVM chain id (block.chainid): 9800 on testnet. */
  evmChainId: number;
  contract: Address;
  auctionId: bigint;
  bidder: Address;
}

export function bidDigest(c: BidContext, amount: bigint, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "address" },
     { type: "uint256" }, { type: "bytes32" }],
    [BID_DOMAIN, BigInt(c.evmChainId), c.contract, c.auctionId, c.bidder, amount, salt]));
}

export function commitmentOf(c: BidContext, amount: bigint, salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
    [c.auctionId, c.bidder, amount, salt]));
}

export function commitDigest(c: BidContext, commitment: Hex, envelopeHash: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "address" },
     { type: "bytes32" }, { type: "bytes32" }],
    [COMMIT_DOMAIN, BigInt(c.evmChainId), c.contract, c.auctionId, c.bidder, commitment, envelopeHash]));
}

export function withdrawDigest(c: Omit<BidContext, "bidder"> & { account: Address; nonce: bigint }): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }],
    [WITHDRAW_DOMAIN, BigInt(c.evmChainId), c.contract, c.auctionId, c.account, c.nonce]));
}

/** keccak256 of the seller's ML-KEM-1024 public key: what the auction pins so bidders know who they sealed to. */
export function kemKeyHash(mlkemPublicKey: Uint8Array): Hex {
  return keccak256(bytesToHex(mlkemPublicKey));
}

export function randomSalt(): Hex {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** The exact bytes the ML-DSA-87 precompile is asked to verify: the raw 32-byte digest. */
export const signingMessage = (digest: Hex): Uint8Array => hexToBytes(digest);

function aadFor(c: BidContext): Uint8Array {
  // Binds the ciphertext to one auction + bidder + contract so it cannot be replayed elsewhere.
  return stringToBytes(`sealedbid|${c.evmChainId}|${c.contract.toLowerCase()}|${c.auctionId}|${c.bidder.toLowerCase()}`);
}

interface BidPlain { v: 1; auctionId: string; bidder: Address; amount: string; salt: Hex; sig: Hex }

export interface SealedBid {
  commitment: Hex;
  envelope: Uint8Array;
  envelopeHash: Hex;
  /** ML-DSA-87 signature authorising the deposit; sent with commitBid. */
  commitSignature: Hex;
  commitDigest: Hex;
  /** Kept by the bidder; lets them reveal their own bid if the seller does not. */
  reveal: RevealArgs;
}
export interface RevealArgs { bidder: Address; amount: bigint; salt: Hex; signature: Hex }

export interface SealBidInput {
  /** The Cosmos chain id QoreSeal uses for domain separation, e.g. "qorechain-diana". */
  sealChainId: string;
  context: BidContext;
  amount: bigint;
  /** The seller's ML-KEM-1024 key (from the on-chain registry via fetchMlkemPublicKey). */
  auctioneer: SealRecipient;
  /** The bidder's ML-DSA-87 secret key; the matching public key must be registered on chain. */
  pqSecretKey: Uint8Array;
  salt?: Hex;
}

/** Everything a bidder does client-side: bind, commit, seal. Nothing here ever leaves the bidder in the clear. */
export function sealBid(i: SealBidInput): SealedBid {
  const salt = i.salt ?? randomSalt();
  const digest = bidDigest(i.context, i.amount, salt);
  const signature = bytesToHex(pqcSign(i.pqSecretKey, signingMessage(digest)));
  const plain: BidPlain = {
    v: 1, auctionId: i.context.auctionId.toString(), bidder: i.context.bidder,
    amount: i.amount.toString(), salt, sig: signature,
  };
  const envelope = seal({
    chainId: i.sealChainId, purpose: SEAL_PURPOSE,
    recipients: [i.auctioneer], plaintext: stringToBytes(JSON.stringify(plain)),
    aad: aadFor(i.context), mode: "mlkem",
  });
  const commitment = commitmentOf(i.context, i.amount, salt);
  const envelopeHash = keccak256(bytesToHex(envelope));
  const cDigest = commitDigest(i.context, commitment, envelopeHash);
  return {
    commitment, envelope, envelopeHash,
    commitDigest: cDigest, commitSignature: bytesToHex(pqcSign(i.pqSecretKey, signingMessage(cDigest))),
    reveal: { bidder: i.context.bidder, amount: i.amount, salt, signature },
  };
}

export interface OpenedBid { args: RevealArgs; commitment: Hex }

/** Seller side: decrypt an envelope and check it is internally consistent before spending gas revealing it. */
export function openBid(i: {
  sealChainId: string; context: BidContext; envelope: Uint8Array; keys: SealKeyPair;
  /** The bidder's registered ML-DSA-87 public key, to pre-check the signature locally. */
  bidderPqPublicKey?: Uint8Array;
}): OpenedBid {
  const raw = open({
    chainId: i.sealChainId, purpose: SEAL_PURPOSE, envelope: i.envelope, keys: i.keys, aad: aadFor(i.context),
  });
  const p = JSON.parse(new TextDecoder().decode(raw)) as BidPlain;
  if (p.v !== 1 || p.auctionId !== i.context.auctionId.toString() || p.bidder.toLowerCase() !== i.context.bidder.toLowerCase())
    throw new Error("envelope does not belong to this auction/bidder");
  const amount = BigInt(p.amount);
  if (i.bidderPqPublicKey) {
    const digest = bidDigest(i.context, amount, p.salt);
    if (!pqcVerify(i.bidderPqPublicKey, signingMessage(digest), hexToBytes(p.sig)))
      throw new Error("ML-DSA signature does not verify for this bid");
  }
  return {
    commitment: commitmentOf(i.context, amount, p.salt),
    args: { bidder: i.context.bidder, amount, salt: p.salt, signature: p.sig },
  };
}

export { concatHex };
