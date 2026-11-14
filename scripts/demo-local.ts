import { mkdirSync, writeFileSync } from "node:fs";
import { runLocalDemo } from "../src/sealedbid/localDemo.js";

const t0 = Date.now();
const res = await runLocalDemo((e) => console.log(`[${e.phase}/${e.lane}] ${e.actor.slice(0, 12)}: ${e.text}`));
mkdirSync("public", { recursive: true });
writeFileSync("public/demo-log.json", JSON.stringify({
  ...res, mode: "local-mock", generatedAt: new Date().toISOString(),
  note: "Recorded on an in-process EVM; ML-DSA verification is mocked there. A testnet recording replaces this once on-chain verification is confirmed.",
}, null, 1));
console.log(`\nwinner=${res.winner} price=${res.price} QOR · ${res.log.length} log entries · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
