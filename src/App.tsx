import { useEffect, useMemo, useRef, useState } from "react";

type Lane = "public" | "private" | "attack";
type Phase = "setup" | "commit" | "reveal" | "settle" | "withdraw";
interface LogEntry {
  n: number; phase: Phase; lane: Lane; actor: string; text: string; tx?: string; gas?: string;
  data?: Record<string, string | number | boolean>;
}
interface DemoLog {
  mode: string; note?: string; generatedAt: string; auctionId: string; contract: string; chainId: number;
  winner?: string; price?: string; log: LogEntry[];
  summary: { bids: number; revealedBySeller: number; revealedByBidder: number; revealGas: string[] };
}

const PHASES: { id: Phase | "commit"; label: string; match: Phase[] }[] = [
  { id: "setup", label: "1 · Create", match: ["setup"] },
  { id: "commit", label: "2 · Seal & commit", match: ["commit"] },
  { id: "reveal", label: "3 · Reveal", match: ["reveal"] },
  { id: "settle", label: "4 · Settle", match: ["settle", "withdraw"] },
];

const short = (s: string) => (s.startsWith("0x") && s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s);

function Entry({ e }: { e: LogEntry }) {
  const hidden = e.lane === "public" && e.text.includes("amount: hidden");
  const [before, after] = hidden ? e.text.split("amount: hidden") : [e.text, ""];
  return (
    <div className={`entry ${e.lane === "attack" ? "attack" : ""}`}>
      <div className="who">
        <span>{e.lane === "attack" ? "⚠ attack attempt" : e.lane === "public" ? "on-chain" : "private"}</span>
        <span className="mono">{short(e.actor)}</span>
        {e.gas && <span className="gas mono">{Number(e.gas).toLocaleString()} gas</span>}
      </div>
      <div>{before}{hidden && <span className="hidden-amt">amount: hidden 🔒</span>}{after}</div>
      {e.data?.preview && <div className="kv mono">ciphertext starts {String(e.data.preview)}…</div>}
    </div>
  );
}

function Feed({ entries, emptyText }: { entries: LogEntry[]; emptyText: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight; // keep the newest entry in view
  }, [entries.length]);
  return (
    <div className="feed" aria-live="polite" ref={ref}>
      {entries.length === 0 && <div className="empty">{emptyText}</div>}
      {entries.map((e) => <Entry key={e.n} e={e} />)}
    </div>
  );
}

export function App() {
  const [demo, setDemo] = useState<DemoLog | null>(null);
  const [err, setErr] = useState<string>("");
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}demo-log.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`demo-log.json: HTTP ${r.status}`))))
      .then((d: DemoLog) => setDemo(d))
      .catch((e: Error) => setErr(e.message));
  }, []);

  const total = demo?.log.length ?? 0;
  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => {
      setShown((s) => {
        if (s >= total) { setPlaying(false); return s; }
        return s + 1;
      });
    }, 1100);
    return () => window.clearInterval(timer.current);
  }, [playing, total]);

  const visible = useMemo(() => demo?.log.slice(0, shown) ?? [], [demo, shown]);
  const pub = visible.filter((e) => e.lane !== "private");
  const priv = visible.filter((e) => e.lane === "private");
  const current = visible.length ? visible[visible.length - 1].phase : null;
  const done = shown >= total && total > 0;
  const real = demo?.mode === "testnet";

  return (
    <div className="wrap">
      <header className="hero">
        <div className="brand">
          <div className="logo" aria-hidden>S</div>
          <h1>SealedBid</h1>
        </div>
        <p className="tag">
          Sealed-bid auctions where AI agents bid in secret. Every bid is encrypted to the seller with post-quantum
          ML-KEM-1024, signed with ML-DSA-87 and settled on QoreChain, so a future quantum computer learns nothing,
          and a stolen classical key moves nothing.
        </p>
        <div className="chips">
          <span className="chip"><b>ML-KEM-1024</b> sealed bids (QoreSeal)</span>
          <span className="chip"><b>ML-DSA-87</b> bid binding &amp; payouts</span>
          <span className="chip"><b>Second-price</b> truthful bidding</span>
          <span className="chip"><b>Claude</b> bidder agents</span>
        </div>
        {demo && (
          <div className="banner" role="note">
            {real ? "Recorded on QoreChain testnet." : "Replay of a local run."}{" "}
            {demo.note} · Contract <span className="mono">{short(demo.contract)}</span> · chain {demo.chainId}
          </div>
        )}
      </header>

      <section className="steps" aria-label="How it works">
        <div className="step"><h3>Seal</h3><p>Each agent encrypts its bid to the seller's registered ML-KEM-1024 key and signs it with its ML-DSA-87 key. Only a commitment and a ciphertext hash go on-chain.</p></div>
        <div className="step"><h3>Reveal</h3><p>The seller decrypts and reveals for everyone, or any bidder reveals their own. The contract verifies each signature against the bidder's registered key.</p></div>
        <div className="step"><h3>Settle</h3><p>Highest bid wins, pays the second price. Every deposit and every payout needs the owner's ML-DSA signature, so a leaked ECDSA key can neither drain funds nor force them into a trap.</p></div>
      </section>

      <div className="controls">
        <button className="primary" disabled={!demo} onClick={() => { if (done) setShown(0); setPlaying((p) => !p); }}>
          {playing ? "Pause" : done ? "Replay" : shown === 0 ? "▶ Play auction" : "Resume"}
        </button>
        <button disabled={!demo || shown >= total} onClick={() => { setPlaying(false); setShown((s) => Math.min(s + 1, total)); }}>Next step</button>
        <button disabled={!demo || (shown === 0 && !playing)} onClick={() => { setPlaying(false); setShown(0); }}>Reset</button>
        <div className="phases" role="list" aria-label="Auction phase">
          {PHASES.map((p, i) => {
            const idx = PHASES.findIndex((x) => current && x.match.includes(current));
            const cls = idx === i ? "on" : idx > i ? "done" : "";
            return <div key={p.id} role="listitem" className={`phase ${cls}`}>{p.label}</div>;
          })}
        </div>
      </div>
      {err && <div className="banner" role="alert">Could not load the recorded run: {err}. Run <span className="mono">npm run demo:local</span> first.</div>}

      <div className="cols">
        <section className="pane chain" aria-label="What the chain and an eavesdropper see">
          <h2>What the chain &amp; an eavesdropper see <small>public</small></h2>
          <Feed entries={pub} emptyText="Nothing yet. Press play." />
        </section>
        <section className="pane priv" aria-label="What the agents and seller know">
          <h2>What the agents &amp; seller know <small>private</small></h2>
          <Feed entries={priv} emptyText="Nothing yet. Press play." />
        </section>
      </div>

      {done && demo?.winner && (
        <div className="result" role="status">
          <h2>{demo.winner} wins the auction</h2>
          <div>Pays the second price, <b>{demo.price} QOR</b>. {demo.summary.bids} sealed bids · {demo.summary.revealedBySeller} revealed by the seller, {demo.summary.revealedByBidder} by the bidder themselves.</div>
          <div style={{ color: "var(--muted)", fontSize: 13 }}>
            Attack attempts shown above were all rejected on-chain. Reveal gas (ML-DSA-87 verification per bid):{" "}
            <span className="mono">{demo.summary.revealGas.map((g) => Number(g).toLocaleString()).join(", ")}</span>
          </div>
        </div>
      )}

      <div className="grid3">
        <div className="card"><h3>Harvest-now, decrypt-later proof</h3><p>An attacker can record every ciphertext today. ML-KEM-1024 is built to stay unreadable to quantum computers, and amounts never appear on-chain before the reveal.</p></div>
        <div className="card"><h3>Seller cannot cheat</h3><ul><li>Cannot invent or edit a bid: the ML-DSA signature binds amount and salt.</li><li>Cannot censor a bid: bidders can reveal themselves.</li><li>Cannot redirect funds: deposits and payouts need the owner's own signature.</li></ul></div>
        <div className="card"><h3>Built with QoreChain kits</h3><p>@qorechain/sdk · @qorechain/pqc · @qorechain/qoreseal · @qorechain/qoresign · PQC precompiles 0x0a01 / 0x0a02 · EVM authorisation window.</p></div>
      </div>
      <footer>Testnet only. Test tokens have no value. Open source (MIT). Built during the QoreChain Build Before Q-Day fest.</footer>
    </div>
  );
}
