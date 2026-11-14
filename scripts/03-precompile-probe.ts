// Read-only, no funds needed: does the REAL pqcVerify precompile (0x0a01) accept an SDK-made ML-DSA-87 signature
// over the raw 32-byte digest the auction signs?   eth_call needs neither a window nor gas.
import { encodeFunctionData, hexToBytes, toHex, type Hex } from "viem";
import { generatePqcKeypair, pqcSign } from "@qorechain/sdk";
import { pub, PQC_VERIFY } from "./testnet-lib.js";

const ABI = [{
  type: "function", name: "pqcVerify", stateMutability: "view",
  inputs: [{ name: "pubkey", type: "bytes" }, { name: "signature", type: "bytes" }, { name: "message", type: "bytes" }],
  outputs: [{ name: "valid", type: "bool" }],
}] as const;

async function verify(pk: Uint8Array, sig: Uint8Array, msg: Uint8Array) {
  const data = encodeFunctionData({ abi: ABI, functionName: "pqcVerify", args: [toHex(pk), toHex(sig), toHex(msg)] });
  const res = await pub.call({ to: PQC_VERIFY, data });
  return { raw: res.data, valid: res.data?.endsWith("1") ?? false, gas: await pub.estimateGas({ to: PQC_VERIFY, data }).catch((e: any) => `n/a (${String(e.shortMessage).slice(0, 60)})`) };
}

const kp = generatePqcKeypair();
const digest = hexToBytes(("0x" + "ab".repeat(32)) as Hex);
const other = hexToBytes(("0x" + "cd".repeat(32)) as Hex);

console.log("A. raw 32-byte digest, deterministic signature");
const a = await verify(kp.publicKey, pqcSign(kp.secretKey, digest), digest);
console.log("   ->", a.raw?.slice(0, 66), "valid:", a.valid, "estimateGas:", a.gas);
console.log("B. same signature, DIFFERENT message (must be false)");
const b = await verify(kp.publicKey, pqcSign(kp.secretKey, digest), other);
console.log("   ->", b.raw?.slice(0, 66), "valid:", b.valid);
console.log("C. hedged (randomised) signature");
const c = await verify(kp.publicKey, pqcSign(kp.secretKey, digest, { hedged: true }), digest);
console.log("   ->", c.raw?.slice(0, 66), "valid:", c.valid);
console.log("D. wrong public key (must be false)");
const d = await verify(generatePqcKeypair().publicKey, pqcSign(kp.secretKey, digest), digest);
console.log("   ->", d.raw?.slice(0, 66), "valid:", d.valid);

console.log(a.valid && !b.valid && c.valid && !d.valid
  ? "\nRESULT: the real precompile verifies raw-digest signatures exactly as the auction assumes."
  : "\nRESULT: UNEXPECTED. Inspect the outputs above before relying on on-chain verification.");
process.exit(0);
