// Shared helpers for the testnet spikes. Secrets live in ./keys (gitignored).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createClient, deriveUnifiedAccount } from "@qorechain/sdk";

export const CHAIN_ID = "qorechain-diana";
export const REST = "https://api-testnet.qore.host";
export const RPC = "https://rpc-testnet.qore.host";
export const EVM_RPC = "https://evm-testnet.qore.host";

export function keyPath(name: string) {
  return new URL(`../keys/${name}.json`, import.meta.url).pathname;
}
export function saveSecret(name: string, data: unknown) {
  mkdirSync(new URL("../keys/", import.meta.url).pathname, { recursive: true });
  if (existsSync(keyPath(name))) throw new Error(`${name} already exists, refusing to overwrite`);
  writeFileSync(keyPath(name), JSON.stringify(data), { mode: 0o600 });
}
export function loadMnemonic(name: string): string {
  return JSON.parse(readFileSync(keyPath(name), "utf8")).mnemonic;
}
export async function loadAccount(name: string) {
  return deriveUnifiedAccount(loadMnemonic(name));
}
export function client() {
  return createClient({ network: "testnet" });
}
export async function accountSequence(address: string) {
  const r = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!r.ok) throw new Error(`account lookup ${r.status} (is it funded yet?)`);
  const j: any = await r.json();
  const a = j.account?.base_account ?? j.account;
  return { accountNumber: BigInt(a.account_number), sequence: BigInt(a.sequence ?? 0) };
}
