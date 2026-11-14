import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const names = process.argv.slice(2);
if (!names.length) throw new Error("usage: tsx scripts/compile.ts PQCProbe [Other ...]");
const sources: Record<string, { content: string }> = {};
for (const n of names) sources[`${n}.sol`] = { content: readFileSync(`contracts/${n}.sol`, "utf8") };
const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity", sources,
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})));
const errs = (out.errors ?? []).filter((e: any) => e.severity === "error");
for (const e of out.errors ?? []) console.log(e.formattedMessage);
if (errs.length) process.exit(1);
mkdirSync("build", { recursive: true });
for (const [file, cs] of Object.entries<any>(out.contracts))
  for (const [name, c] of Object.entries<any>(cs)) {
    const art = JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object });
    writeFileSync(`build/${name}.json`, art);
    if (name !== "MockPQC" && c.evm.bytecode.object.length) {
      mkdirSync("src/sealedbid/generated", { recursive: true });
      writeFileSync(`src/sealedbid/generated/${name}.json`, art); // committed: UI + scripts import this
    }
    console.log(`compiled ${file}:${name} (${c.evm.bytecode.object.length / 2} bytes)`);
  }
