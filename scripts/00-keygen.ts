// Generates a THROWAWAY testnet account. Never reuse for anything that matters.
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { saveSecret } from "./lib.js";

const name = process.argv[2];
if (!name) throw new Error("usage: tsx scripts/00-keygen.ts <name>   e.g. deployer | auctioneer | bidder1");
const mnemonic = generateMnemonic(wordlist, 256);
const acct = await deriveUnifiedAccount(mnemonic);
saveSecret(name, { mnemonic });
console.log(`${name}: saved to keys/${name}.json (gitignored)`);
console.log("  native qor1:", acct.cosmos);
console.log("  evm    0x  :", acct.evm);
