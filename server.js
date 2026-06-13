const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "64kb" }));

const DB_PATH = process.env.DB_PATH || "./ryuk.json";
let store = { posts: [] };
try { if (fs.existsSync(DB_PATH)) store = JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch (e) { store = { posts: [] }; }
let writeQueued = false;
function persist() {
  if (writeQueued) return;
  writeQueued = true;
  setImmediate(() => {
    writeQueued = false;
    try { fs.writeFileSync(DB_PATH + ".tmp", JSON.stringify(store)); fs.renameSync(DB_PATH + ".tmp", DB_PATH); } catch (e) {}
  });
}
const clip = (s, n) => String(s || "").trim().slice(0, n);

const ALLOWED_ORIGINS = [
  "https://ryuk.iqmc.in",
  "capacitor://localhost",
  "http://localhost",
  "https://localhost"
];
const APP_SECRET = process.env.APP_SECRET || "";

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 12;
const MAX_PER_DAY = 2000;
const hits = new Map();
let dayCount = 0, dayStart = Date.now();
function rateLimit(ip) {
  const now = Date.now();
  if (now - dayStart > 86400000) { dayCount = 0; dayStart = now; }
  if (dayCount >= MAX_PER_DAY) return "daily";
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) { hits.set(ip, arr); return "ip"; }
  arr.push(now); hits.set(ip, arr); dayCount++;
  return null;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const live = arr.filter((t) => now - t < WINDOW_MS);
    if (live.length) hits.set(ip, live); else hits.delete(ip);
  }
}, WINDOW_MS).unref();

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-key");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/", (_req, res) => res.json({ ok: true, service: "ryuk-api" }));

app.post("/api/chat", async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "Server not configured" });
  if (APP_SECRET && req.headers["x-app-key"] !== APP_SECRET) return res.status(401).json({ error: "unauthorized" });
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const limited = rateLimit(ip);
  if (limited) return res.status(429).json({ error: "rate_limited", scope: limited });
  try {
    const { system, messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "messages required" });
    if (messages.length > 40) return res.status(400).json({ error: "too many messages" });
    const trimmed = messages.slice(-12).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 4000)
    }));
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: String(system || "You are a helpful social-compliance audit assistant.").slice(0, 4000),
        messages: trimmed
      })
    });
    if (!r.ok) return res.status(502).json({ error: "upstream", detail: (await r.text()).slice(0, 300) });
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: "proxy_failed" });
  }
});

app.get("/api/feed", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const posts = store.posts.slice(-limit).reverse();
    res.json({ posts });
  } catch (e) { res.status(500).json({ error: "feed_failed" }); }
});

app.post("/api/feed", (req, res) => {
  if (APP_SECRET && req.headers["x-app-key"] !== APP_SECRET) return res.status(401).json({ error: "unauthorized" });
  if (rateLimit(req.ip || "unknown")) return res.status(429).json({ error: "rate_limited" });
  try {
    const author = clip(req.body.author, 60), body = clip(req.body.body, 2000);
    if (!author || !body) return res.status(400).json({ error: "author and body required" });
    const post = { id: crypto.randomUUID(), author, handle: clip(req.body.handle, 30), tag: clip(req.body.tag, 30), body, likes: 0, comments: [], created: Date.now() };
    store.posts.push(post);
    if (store.posts.length > 5000) store.posts = store.posts.slice(-5000);
    persist();
    res.json({ post });
  } catch (e) { res.status(500).json({ error: "create_failed" }); }
});

app.post("/api/feed/:id/like", (req, res) => {
  if (APP_SECRET && req.headers["x-app-key"] !== APP_SECRET) return res.status(401).json({ error: "unauthorized" });
  try {
    const p = store.posts.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: "not_found" });
    p.likes++; persist();
    res.json({ ok: true, likes: p.likes });
  } catch (e) { res.status(500).json({ error: "like_failed" }); }
});

app.post("/api/feed/:id/comment", (req, res) => {
  if (APP_SECRET && req.headers["x-app-key"] !== APP_SECRET) return res.status(401).json({ error: "unauthorized" });
  if (rateLimit(req.ip || "unknown")) return res.status(429).json({ error: "rate_limited" });
  try {
    const author = clip(req.body.author, 60), body = clip(req.body.body, 1000);
    if (!author || !body) return res.status(400).json({ error: "author and body required" });
    const p = store.posts.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: "post_not_found" });
    const c = { id: crypto.randomUUID(), author, body, created: Date.now() };
    (p.comments || (p.comments = [])).push(c); persist();
    res.json({ comment: c });
  } catch (e) { res.status(500).json({ error: "comment_failed" }); }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("ryuk-api listening on " + port));
