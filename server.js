// Live team poll — a small demo app for Dokploy.
// Votes are stored in Postgres when DATABASE_URL is set, otherwise in memory.
const express = require("express");
const crypto = require("crypto");
const os = require("os");
const QRCode = require("qrcode");
const { Pool } = require("pg");

const PORT = process.env.PORT || 8080;
const QUESTION = process.env.POLL_QUESTION || "What should we build next?";
const OPTIONS = (process.env.POLL_OPTIONS || "AI tools,Faster deploys,Better dashboards,More coffee")
  .split(",").map((s) => s.trim()).filter(Boolean);
const CONTAINER = os.hostname();

// ---------- storage ----------
let pool = null;
const memory = new Map(); // voter -> option (only for the current question)

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log("No DATABASE_URL set: votes are kept in memory and lost on redeploy.");
    return;
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS votes (
        question   TEXT NOT NULL,
        voter      TEXT NOT NULL,
        option     TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (question, voter))`);
      console.log("Connected to Postgres.");
      return;
    } catch (err) {
      console.log(`Database not ready (attempt ${attempt}/10): ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error("Could not connect to Postgres. Check DATABASE_URL.");
}

async function castVote(voter, option) {
  if (pool) {
    await pool.query(
      `INSERT INTO votes (question, voter, option) VALUES ($1, $2, $3)
       ON CONFLICT (question, voter) DO UPDATE SET option = EXCLUDED.option, updated_at = now()`,
      [QUESTION, voter, option]
    );
  } else {
    memory.set(voter, option);
  }
}

async function getResults(voter) {
  const counts = Object.fromEntries(OPTIONS.map((o) => [o, 0]));
  let myVote = null;
  if (pool) {
    const { rows } = await pool.query(
      "SELECT option, COUNT(*)::int AS n FROM votes WHERE question = $1 GROUP BY option", [QUESTION]);
    rows.forEach((r) => { if (r.option in counts) counts[r.option] = r.n; });
    if (voter) {
      const mine = await pool.query("SELECT option FROM votes WHERE question = $1 AND voter = $2", [QUESTION, voter]);
      myVote = mine.rows[0]?.option || null;
    }
  } else {
    for (const opt of memory.values()) if (opt in counts) counts[opt]++;
    myVote = memory.get(voter) || null;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { question: QUESTION, options: OPTIONS, counts, total, myVote, persistent: !!pool, container: CONTAINER };
}

async function resetVotes() {
  if (pool) await pool.query("DELETE FROM votes WHERE question = $1", [QUESTION]);
  else memory.clear();
}

// ---------- web ----------
const app = express();
app.use(express.json());

// Give each browser an anonymous ID so people can change (but not stack) their vote.
app.use((req, res, next) => {
  const match = /(?:^|;\s*)voter=([a-f0-9-]+)/.exec(req.headers.cookie || "");
  req.voter = match ? match[1] : crypto.randomUUID();
  if (!match) res.setHeader("Set-Cookie", `voter=${req.voter}; Path=/; Max-Age=31536000; SameSite=Lax`);
  next();
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/api/poll", async (req, res, next) => {
  try { res.json(await getResults(req.voter)); } catch (e) { next(e); }
});

app.post("/api/vote", async (req, res, next) => {
  try {
    const option = req.body?.option;
    if (!OPTIONS.includes(option)) return res.status(400).json({ error: "Unknown option" });
    await castVote(req.voter, option);
    res.json(await getResults(req.voter));
  } catch (e) { next(e); }
});

app.post("/api/reset", async (req, res, next) => {
  try {
    await resetVotes();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get("/qr.svg", async (req, res, next) => {
  try {
    const proto = req.headers["x-forwarded-proto"] || "http";
    const url = process.env.PUBLIC_URL || `${proto}://${req.headers.host}/`;
    res.type("image/svg+xml").send(await QRCode.toString(url, { type: "svg", margin: 1 }));
  } catch (e) { next(e); }
});

app.get(["/", "/results"], (req, res) => res.type("html").send(PAGE));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live Poll</title>
<style>
  :root{--bg:#0f1220;--card:#1a1f35;--text:#eef0f8;--muted:#9aa1bd;--accent:#7c8cff;--accent2:#4fd1c5}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
  .wrap{max-width:640px;margin:0 auto;padding:32px 20px}
  .present .wrap{max-width:1100px;display:grid;grid-template-columns:1fr 280px;gap:40px;align-items:start;padding-top:56px}
  h1{font-size:1.8rem;line-height:1.25;margin:0 0 6px}
  .present h1{font-size:2.8rem}
  .sub{color:var(--muted);margin:0 0 24px}
  button.opt{display:block;width:100%;text-align:left;font-size:1.1rem;padding:16px 18px;margin:0 0 12px;
    border-radius:12px;border:2px solid transparent;background:var(--card);color:var(--text);cursor:pointer}
  button.opt:hover{border-color:#39406a}
  button.opt.mine{border-color:var(--accent);background:#232a4d}
  .bar{margin:0 0 16px}
  .bar .label{display:flex;justify-content:space-between;margin-bottom:6px;font-size:1rem}
  .present .bar .label{font-size:1.5rem}
  .track{height:14px;background:var(--card);border-radius:8px;overflow:hidden}
  .present .track{height:30px}
  .fill{height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width .6s ease}
  .qr{background:#fff;border-radius:16px;padding:14px}
  .qr img{width:100%;display:block}
  .side p{color:var(--muted);text-align:center;margin:12px 0 0}
  .reset{display:block;margin:28px auto 0;background:transparent;color:var(--muted);border:1px solid #39406a;
    border-radius:8px;padding:8px 16px;font-size:.9rem;cursor:pointer}
  .reset:hover{color:var(--text);border-color:var(--accent)}
  .total{font-size:3rem;font-weight:700;text-align:center;margin-top:24px}
  .badge{display:inline-block;font-size:.8rem;padding:3px 10px;border-radius:999px;margin-top:28px}
  .ok{background:#16352f;color:#7ee2c5}.warn{background:#3d2a12;color:#ffc77a}
  footer{color:var(--muted);font-size:.8rem;margin-top:10px}
  #results{margin-top:28px}
  @media (max-width:800px){.present .wrap{grid-template-columns:1fr}}
</style></head>
<body>
<div class="wrap">
  <main>
    <h1 id="q">Loading…</h1>
    <p class="sub" id="sub"></p>
    <div id="buttons"></div>
    <div id="results"></div>
    <span class="badge" id="storage"></span>
    <footer id="foot"></footer>
  </main>
  <aside class="side" id="side" hidden>
    <div class="qr"><img src="/qr.svg" alt="QR code to vote"></div>
    <p>Scan to vote</p>
    <div class="total" id="total">0</div>
    <p>votes</p>
    <button class="reset" id="reset">Reset votes</button>
  </aside>
</div>
<script>
  const present = location.pathname === "/results";
  if (present) { document.body.classList.add("present"); document.getElementById("side").hidden = false; }
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  function render(d) {
    document.getElementById("q").textContent = d.question;
    document.getElementById("sub").textContent = present ? "" :
      d.myVote ? "Thanks! Tap another option to change your vote." : "Tap an option to vote.";
    if (!present) {
      document.getElementById("buttons").innerHTML = d.options.map((o) =>
        '<button class="opt' + (o === d.myVote ? ' mine' : '') + '" data-o="' + esc(o) + '">' + esc(o) + '</button>').join("");
    }
    const showBars = present || d.myVote;
    document.getElementById("results").innerHTML = !showBars ? "" : d.options.map((o) => {
      const n = d.counts[o], pct = d.total ? Math.round(n * 100 / d.total) : 0;
      return '<div class="bar"><div class="label"><span>' + esc(o) + '</span><span>' + n + ' · ' + pct + '%</span></div>' +
             '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div></div>';
    }).join("");
    document.getElementById("total").textContent = d.total;
    const st = document.getElementById("storage");
    st.className = "badge " + (d.persistent ? "ok" : "warn");
    st.textContent = d.persistent ? "Saved in Postgres" : "In memory only: votes reset on redeploy";
    document.getElementById("foot").textContent = "Served by container " + d.container;
  }

  async function refresh() {
    try { render(await (await fetch("/api/poll")).json()); } catch (e) {}
  }
  document.getElementById("buttons").addEventListener("click", async (e) => {
    const o = e.target.closest("button.opt")?.dataset.o;
    if (!o) return;
    const r = await fetch("/api/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ option: o }) });
    render(await r.json());
  });
  document.getElementById("reset").addEventListener("click", async () => {
    if (!confirm("Clear all votes for this question?")) return;
    await fetch("/api/reset", { method: "POST" });
    refresh();
  });
  refresh();
  setInterval(refresh, 1500);
</script>
</body></html>`;

initDb()
  .then(() => app.listen(PORT, () => console.log(`Poll running on port ${PORT} (container ${CONTAINER})`)))
  .catch((err) => { console.error(err.message); process.exit(1); });
