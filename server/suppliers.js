// 供应商管理（参考 zhongtai）：供应商 + 可提供的货（倍率），方便找到对应的人；
// 另有供应商接口的延迟监测：定时对供应商的 API 地址发一次 "ping"，记录状态与延迟，展示为延迟监控条。
// 存储：DATA_DIR/ops.db（node:sqlite），与 sub2api 无关。
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { scoreOf } from "./monitor.js";

export const CATEGORIES = ["gpt", "claude", "aws", "cardshop"];
const STATUSES = ["active", "paused", "closed"];
const KINDS = ["openai", "openai_response", "claude"];
const DEFAULT_MODEL = { openai: "gpt-5.5", openai_response: "gpt-5.5", claude: "claude-sonnet-4-6" };
const TIMEOUT_MS = 10_000;
const KEEP_SAMPLES = 48;
const SHOW_SAMPLES = 24;
const LOOP_MS = 60_000;

const nowIso = () => new Date().toISOString();
const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);
export const normalizeRate = (raw) => str(raw, 60).replace(/\s*[~\-～—–]\s*/g, "-");
const normCategory = (v) =>
  [...new Set((Array.isArray(v) ? v : String(v || "").split(",")).map((x) => String(x).trim()).filter((x) => CATEGORIES.includes(x)))].join(",");

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "ops.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      wechat TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',      -- Telegram
      base_url TEXT NOT NULL DEFAULT '',     -- 网站 / 对接地址
      category TEXT NOT NULL DEFAULT '',     -- 逗号分隔 gpt/claude/aws/cardshop
      channel TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active', -- active 合作中 / paused 暂停 / closed 已终止
      notes TEXT NOT NULL DEFAULT '',
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS supplier_goods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      rate TEXT NOT NULL DEFAULT '',         -- 倍率，允许区间 "0.8-1.2"
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goods_supplier ON supplier_goods(supplier_id);
    CREATE TABLE IF NOT EXISTS supplier_monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '默认',
      kind TEXT NOT NULL DEFAULT 'openai',   -- openai / openai_response / claude
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      slow_ms INTEGER NOT NULL DEFAULT 5000,
      last_status TEXT NOT NULL DEFAULT 'unknown',
      last_latency_ms INTEGER,
      last_error TEXT NOT NULL DEFAULT '',
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_monitor_supplier ON supplier_monitors(supplier_id);
    CREATE TABLE IF NOT EXISTS supplier_monitor_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL REFERENCES supplier_monitors(id) ON DELETE CASCADE,
      status TEXT NOT NULL,                  -- up / slow / down / limited
      latency_ms INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,
      error TEXT NOT NULL DEFAULT '',
      checked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sample_monitor ON supplier_monitor_samples(monitor_id, checked_at);
  `);
  return db;
}

// ---------- 探测（移植自 zhongtai src/lib/supplier-probe.ts） ----------
function probeUrl(baseUrl, kind) {
  const t = baseUrl.trim().replace(/\/+$/, "");
  if (kind === "claude") return /\/messages$/i.test(t) ? t : /\/v1$/i.test(t) ? `${t}/messages` : `${t}/v1/messages`;
  if (kind === "openai_response") return /\/responses$/i.test(t) ? t : /\/v1$/i.test(t) ? `${t}/responses` : `${t}/v1/responses`;
  return /\/chat\/completions$/i.test(t) ? t : /\/v1$/i.test(t) ? `${t}/chat/completions` : `${t}/v1/chat/completions`;
}
const redact = (text, key) => (key && key.length >= 8 ? String(text).split(key).join("<api-key>") : String(text)).slice(0, 240);
const textOf = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (typeof b === "string" ? b : b && typeof b === "object" ? String(b.text ?? "") : "")).join("") : "";
function hasContent(p, kind) {
  if (!p || typeof p !== "object") return false;
  if (kind === "claude") return textOf(p.content).trim().length > 0;
  if (kind === "openai_response") {
    if (typeof p.output_text === "string" && p.output_text.trim()) return true;
    return Array.isArray(p.output) && p.output.some((i) => (typeof i === "string" ? i.trim() : i && (String(i.text ?? "").trim() || textOf(i.content).trim())));
  }
  return textOf(p.choices?.[0]?.message?.content).trim().length > 0;
}
function buildRequest(kind, apiKey, model) {
  const headers = { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  if (kind === "claude")
    return {
      headers: { ...headers, "anthropic-version": "2023-06-01", ...(apiKey ? { "x-api-key": apiKey } : {}) },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }),
    };
  if (kind === "openai_response") return { headers, body: JSON.stringify({ model, input: "ping", max_output_tokens: 16, stream: false }) };
  return { headers, body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }) };
}
async function probeOnce({ kind, url, apiKey, model, slowMs }) {
  const started = Date.now();
  const req = buildRequest(kind, apiKey, model);
  try {
    const res = await fetch(url, { method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const latencyMs = Date.now() - started;
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    if (res.status === 401 || res.status === 403) return { status: "down", latencyMs, httpStatus: res.status, error: "认证失败" };
    if (res.status === 429) return { status: "limited", latencyMs, httpStatus: res.status, error: "被限流" };
    if (res.status === 451) return { status: "down", latencyMs, httpStatus: res.status, error: "地区访问受限，探测需要代理" };
    if (!res.ok) {
      let msg = raw || `HTTP ${res.status}`;
      const err = json && typeof json === "object" ? json.error : null;
      if (typeof err === "string" && err.trim()) msg = err;
      else if (err && typeof err === "object" && err.message) msg = err.message;
      return { status: "down", latencyMs, httpStatus: res.status, error: redact(msg, apiKey) || `HTTP ${res.status}` };
    }
    if (!hasContent(json, kind)) return { status: "down", latencyMs, httpStatus: res.status, error: "HTTP 200 但响应无内容" };
    return { status: latencyMs >= slowMs ? "slow" : "up", latencyMs, httpStatus: res.status, error: "" };
  } catch (e) {
    const aborted = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { status: "down", latencyMs: Date.now() - started, httpStatus: null, error: aborted ? "探测超时" : redact(e?.message || e, apiKey) };
  }
}
// 429 隔 1 秒再打，最多 3 次；仍限流记为 limited（不算异常）
async function probeEndpoint(m) {
  const kind = KINDS.includes(m.kind) ? m.kind : "openai";
  const input = { kind, url: probeUrl(m.base_url, kind), apiKey: m.api_key, model: m.model.trim() || DEFAULT_MODEL[kind], slowMs: m.slow_ms };
  let last = null;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000));
    last = await probeOnce(input);
    if (last.status !== "limited") return last;
  }
  return last;
}

export function registerSuppliers({ app, wrap, httpError, dataDir, jobs }) {
  const db = openDb(dataDir);
  const q = {
    goodsOf: db.prepare("SELECT id, name, rate FROM supplier_goods WHERE supplier_id = ? ORDER BY id"),
    supplier: db.prepare("SELECT * FROM suppliers WHERE id = ? AND deleted_at IS NULL"),
    monitor: db.prepare("SELECT * FROM supplier_monitors WHERE id = ?"),
    samplesOf: db.prepare(
      `SELECT id, status, latency_ms, http_status, error, checked_at FROM
         (SELECT * FROM supplier_monitor_samples WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ${SHOW_SAMPLES}) ORDER BY checked_at`,
    ),
  };
  const mustSupplier = (id) => {
    const s = q.supplier.get(Number(id));
    if (!s) throw httpError(404, "供应商不存在");
    return s;
  };
  const supplierView = (s) => ({
    ...s,
    category: s.category ? s.category.split(",") : [],
    goods: q.goodsOf.all(s.id),
  });
  // apiKey 不回传，只给脱敏后缀
  const monitorView = (m) => {
    const { api_key, ...rest } = m;
    const samples = q.samplesOf.all(m.id);
    return {
      ...rest,
      enabled: !!m.enabled,
      has_key: !!api_key,
      key_masked: api_key ? `${api_key.slice(0, 4)}…${api_key.slice(-4)}` : "",
      samples,
      score: scoreOf(samples),
    };
  };

  // ---------- 供应商 ----------
  app.get(
    "/api/suppliers",
    wrap(async (req) => {
      const where = ["deleted_at IS NULL"];
      const params = [];
      if (req.query.q) {
        where.push("(name LIKE ? OR wechat LIKE ? OR contact LIKE ? OR notes LIKE ? OR id IN (SELECT supplier_id FROM supplier_goods WHERE name LIKE ?))");
        const like = `%${String(req.query.q).trim()}%`;
        params.push(like, like, like, like, like);
      }
      if (CATEGORIES.includes(req.query.category)) {
        where.push("(',' || category || ',') LIKE ?");
        params.push(`%,${req.query.category},%`);
      }
      const rows = db.prepare(`SELECT * FROM suppliers WHERE ${where.join(" AND ")} ORDER BY status = 'active' DESC, updated_at DESC`).all(...params);
      const monCount = Object.fromEntries(
        db.prepare("SELECT supplier_id, count(*) AS n FROM supplier_monitors GROUP BY supplier_id").all().map((r) => [r.supplier_id, r.n]),
      );
      return rows.map((s) => ({ ...supplierView(s), monitor_count: monCount[s.id] || 0 }));
    }),
  );

  function supplierInput(b, partial) {
    const out = {};
    if (!partial || "name" in b) {
      out.name = str(b.name, 80);
      if (!out.name) throw httpError(400, "供应商名称必填");
    }
    for (const k of ["wechat", "contact", "base_url", "channel", "notes"]) if (!partial || k in b) out[k] = str(b[k], k === "notes" ? 2000 : 300);
    if (!partial || "category" in b) out.category = normCategory(b.category);
    if (!partial || "status" in b) out.status = STATUSES.includes(b.status) ? b.status : "active";
    return out;
  }
  const insertGoods = db.prepare("INSERT INTO supplier_goods (supplier_id, name, rate, created_at) VALUES (?, ?, ?, ?)");

  app.post(
    "/api/suppliers",
    wrap(async (req) => {
      const b = req.body || {};
      const v = supplierInput(b, false);
      const t = nowIso();
      const r = db
        .prepare(
          "INSERT INTO suppliers (name, wechat, contact, base_url, category, channel, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(v.name, v.wechat, v.contact, v.base_url, v.category, v.channel, v.status, v.notes, t, t);
      for (const g of Array.isArray(b.goods) ? b.goods : []) {
        const name = str(g.name, 80);
        if (name) insertGoods.run(r.lastInsertRowid, name, normalizeRate(g.rate), t);
      }
      return supplierView(q.supplier.get(r.lastInsertRowid));
    }),
  );

  app.get(
    "/api/suppliers/:id",
    wrap(async (req) => {
      const s = mustSupplier(req.params.id);
      const monitors = db.prepare("SELECT * FROM supplier_monitors WHERE supplier_id = ? ORDER BY id").all(s.id).map(monitorView);
      return { ...supplierView(s), monitors };
    }),
  );

  app.patch(
    "/api/suppliers/:id",
    wrap(async (req) => {
      const s = mustSupplier(req.params.id);
      const v = supplierInput(req.body || {}, true);
      const keys = Object.keys(v);
      if (keys.length) db.prepare(`UPDATE suppliers SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => v[k]), nowIso(), s.id);
      return supplierView(q.supplier.get(s.id));
    }),
  );

  // 软删除：保留记录，列表里不再出现
  app.delete(
    "/api/suppliers/:id",
    wrap(async (req) => {
      const s = mustSupplier(req.params.id);
      db.prepare("UPDATE suppliers SET deleted_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), s.id);
      db.prepare("UPDATE supplier_monitors SET enabled = 0 WHERE supplier_id = ?").run(s.id);
      return { ok: true };
    }),
  );

  app.post(
    "/api/suppliers/:id/goods",
    wrap(async (req) => {
      const s = mustSupplier(req.params.id);
      const name = str(req.body?.name, 80);
      if (!name) throw httpError(400, "货物名称必填");
      insertGoods.run(s.id, name, normalizeRate(req.body?.rate), nowIso());
      db.prepare("UPDATE suppliers SET updated_at = ? WHERE id = ?").run(nowIso(), s.id);
      return supplierView(q.supplier.get(s.id));
    }),
  );
  app.patch(
    "/api/suppliers/:id/goods/:gid",
    wrap(async (req) => {
      const s = mustSupplier(req.params.id);
      const name = str(req.body?.name, 80);
      if (!name) throw httpError(400, "货物名称必填");
      db.prepare("UPDATE supplier_goods SET name = ?, rate = ? WHERE id = ? AND supplier_id = ?").run(name, normalizeRate(req.body?.rate), Number(req.params.gid), s.id);
      return supplierView(q.supplier.get(s.id));
    }),
  );
  app.delete(
    "/api/suppliers/:id/goods/:gid",
    wrap(async (req) => {
      const s = mustSupplier(req.params.id);
      db.prepare("DELETE FROM supplier_goods WHERE id = ? AND supplier_id = ?").run(Number(req.params.gid), s.id);
      return supplierView(q.supplier.get(s.id));
    }),
  );

  // ---------- 供应商接口延迟监测 ----------
  app.get(
    "/api/supplier-monitors",
    wrap(async () => {
      const rows = db
        .prepare(
          `SELECT m.*, s.name AS supplier_name, s.category AS supplier_category FROM supplier_monitors m
             JOIN suppliers s ON s.id = m.supplier_id WHERE s.deleted_at IS NULL ORDER BY s.name, m.id`,
        )
        .all();
      return rows.map((m) => ({ ...monitorView(m), supplier_category: m.supplier_category ? m.supplier_category.split(",") : [] }));
    }),
  );

  function monitorInput(b, partial) {
    const out = {};
    if (!partial || "name" in b) out.name = str(b.name, 60) || "默认";
    if (!partial || "kind" in b) out.kind = KINDS.includes(b.kind) ? b.kind : "openai";
    if (!partial || "base_url" in b) {
      out.base_url = str(b.base_url, 300);
      if (!/^https?:\/\//i.test(out.base_url)) throw httpError(400, "接口地址需以 http:// 或 https:// 开头");
    }
    if (!partial || "model" in b) out.model = str(b.model, 100);
    if (!partial || "slow_ms" in b) {
      out.slow_ms = parseInt(b.slow_ms) || 5000;
      if (out.slow_ms < 200) throw httpError(400, "偏慢阈值至少 200ms");
    }
    if (!partial || "enabled" in b) out.enabled = b.enabled === false ? 0 : 1;
    // apiKey：只有填了才更新（留空 = 保持原值）
    if (str(b.api_key, 500)) out.api_key = str(b.api_key, 500);
    return out;
  }

  app.post(
    "/api/supplier-monitors",
    wrap(async (req) => {
      const b = req.body || {};
      const s = mustSupplier(b.supplier_id);
      const v = monitorInput({ ...b, base_url: b.base_url || s.base_url }, false);
      const t = nowIso();
      const r = db
        .prepare(
          "INSERT INTO supplier_monitors (supplier_id, name, kind, base_url, api_key, model, enabled, slow_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(s.id, v.name, v.kind, v.base_url, v.api_key || "", v.model, v.enabled, v.slow_ms, t, t);
      return monitorView(q.monitor.get(r.lastInsertRowid));
    }),
  );
  app.patch(
    "/api/supplier-monitors/:id",
    wrap(async (req) => {
      const m = q.monitor.get(Number(req.params.id));
      if (!m) throw httpError(404, "监测项不存在");
      const v = monitorInput(req.body || {}, true);
      const keys = Object.keys(v);
      if (keys.length) db.prepare(`UPDATE supplier_monitors SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => v[k]), nowIso(), m.id);
      return monitorView(q.monitor.get(m.id));
    }),
  );
  app.delete(
    "/api/supplier-monitors/:id",
    wrap(async (req) => {
      db.prepare("DELETE FROM supplier_monitors WHERE id = ?").run(Number(req.params.id));
      return { ok: true };
    }),
  );

  async function runAndStore(id) {
    const m = q.monitor.get(id);
    if (!m) throw httpError(404, "监测项不存在");
    const o = await probeEndpoint(m);
    const t = nowIso();
    db.prepare("INSERT INTO supplier_monitor_samples (monitor_id, status, latency_ms, http_status, error, checked_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      o.status,
      o.latencyMs,
      o.httpStatus,
      o.error,
      t,
    );
    db.prepare("UPDATE supplier_monitors SET last_status = ?, last_latency_ms = ?, last_error = ?, last_checked_at = ? WHERE id = ?").run(o.status, o.latencyMs, o.error, t, id);
    db.prepare(
      `DELETE FROM supplier_monitor_samples WHERE monitor_id = ? AND id NOT IN
         (SELECT id FROM supplier_monitor_samples WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ${KEEP_SAMPLES})`,
    ).run(id, id);
    return monitorView(q.monitor.get(id));
  }
  const enabledIds = () =>
    db
      .prepare("SELECT m.id FROM supplier_monitors m JOIN suppliers s ON s.id = m.supplier_id WHERE m.enabled = 1 AND s.deleted_at IS NULL ORDER BY m.id")
      .all()
      .map((r) => r.id);

  app.post("/api/supplier-monitors/:id/probe", wrap(async (req) => runAndStore(Number(req.params.id))));
  app.post(
    "/api/supplier-monitors/probe",
    wrap(async () => {
      const out = [];
      for (const id of enabledIds()) out.push(await runAndStore(id).catch((e) => ({ id, last_error: e.message })));
      return out;
    }),
  );

  // 定时探测：每 60 秒把启用的监测项串行跑一遍（只读 / 本地模式不跑）
  if (jobs) {
    let running = false;
    const loop = async () => {
      if (!running) {
        running = true;
        for (const id of enabledIds()) await runAndStore(id).catch((e) => console.error("[supplier-monitor]", e.message));
        running = false;
      }
      setTimeout(loop, LOOP_MS);
    };
    setTimeout(loop, 15_000);
  }
}
