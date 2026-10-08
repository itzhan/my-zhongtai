// 运维中台后端（由客户中台迁移而来）：在 sub2api 之上按「客户」归集渠道、分组、使用日志与报错日志，
// 管理上游账号、智能调度、账单，并提供延迟监控与供应商管理。只提供 /api，页面由 ops-center/web 负责。
// 读：日志类数据直连 sub2api 的 Postgres（只读角色）；写：一律走 sub2api 管理 API。
import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScheduler, ERROR_CLASS_SQL } from "./scheduler.js";
import { createDetector } from "./detector.js";
import { registerMonitor } from "./monitor.js";
import { registerSuppliers } from "./suppliers.js";
import { registerTraffic } from "./traffic.js";
import ExcelJS from "exceljs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d) => process.env[k] ?? d;

const PORT = Number(env("PORT", 3190));
const APP_PASSWORD = env("APP_PASSWORD");
const SESSION_SECRET = env("SESSION_SECRET", crypto.randomBytes(32).toString("hex"));
const S2_BASE = env("SUB2API_BASE", "http://sub2api-8082:8080/api/v1").replace(/\/$/, "");
const S2_KEY = env("SUB2API_ADMIN_KEY");
const DATA_DIR = env("DATA_DIR", path.join(__dirname, "data"));
const TZ = "Asia/Shanghai";

// 只读保护（默认开启，只有显式 READONLY=0 才关闭）：
// 拦截一切对 sub2api 的写请求和会产生费用的测试 / 检测；智能调度只观察、不调整，深度检测不运行。
const READONLY = env("READONLY", "1") !== "0";
// 这几个 POST 只是查询，放行
const READ_ONLY_POSTS = new Set(["/admin/accounts/today-stats/batch"]);
function guardWrite(method, p) {
  if (READONLY && method !== "GET" && !READ_ONLY_POSTS.has(p.split("?")[0])) {
    throw httpError(403, `只读模式：已拦截对线上 sub2api 的写操作（${method} ${p.split("?")[0]}）`);
  }
}

if (!APP_PASSWORD || !S2_KEY) {
  console.error("APP_PASSWORD 和 SUB2API_ADMIN_KEY 必须设置");
  process.exit(1);
}

pg.types.setTypeParser(20, (v) => Number(v)); // bigint → number（id / token 数都在安全范围内）

const pool = new pg.Pool({
  host: env("PG_HOST", "sub2api-8082-postgres"),
  port: Number(env("PG_PORT", 5432)),
  user: env("PG_USER", "zhongtai_ro"),
  password: env("PG_PASSWORD"),
  database: env("PG_DB", "sub2api"),
  max: 5,
});

// ---------- 客户存储（JSON 文件） ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const CUSTOMERS_FILE = path.join(DATA_DIR, "customers.json");
function loadCustomers() {
  try {
    return JSON.parse(fs.readFileSync(CUSTOMERS_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveCustomers(list) {
  const tmp = CUSTOMERS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, CUSTOMERS_FILE);
}
function getCustomer(id) {
  const c = loadCustomers().find((x) => x.id === id);
  if (!c) throw httpError(404, "客户不存在");
  return c;
}

// ---------- sub2api 管理 API ----------
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
async function s2(method, p, body) {
  guardWrite(method, p);
  const res = await fetch(S2_BASE + p, {
    method,
    headers: { "x-api-key": S2_KEY, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let j;
  try {
    j = await res.json();
  } catch {
    throw httpError(502, `sub2api 返回非 JSON（HTTP ${res.status}）`);
  }
  if (j.error === "mixed_channel_warning") throw httpError(409, `mixed_channel_warning: ${j.message}`);
  if (!res.ok || j.code !== 0) throw httpError(res.status >= 400 ? res.status : 502, j.message || `sub2api 错误 HTTP ${res.status}`);
  return j.data;
}

async function s2raw(method, p, body, timeoutMs = 30000) {
  guardWrite(method, p);
  return fetch(S2_BASE + p, {
    method,
    headers: { "x-api-key": S2_KEY, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + ttlMs });
  return val;
}
const bust = (prefix) => [...cache.keys()].filter((k) => k.startsWith(prefix)).forEach((k) => cache.delete(k));

const getGroups = () => cached("groups", 30000, () => s2("GET", "/admin/groups/all"));
function stripAccount(a) {
  const { credentials, extra, account_groups, groups, ...rest } = a;
  return {
    ...rest,
    group_ids: a.group_ids || [],
    group_priorities: Object.fromEntries((account_groups || []).map((g) => [g.group_id, g.priority])),
  };
}
const getAccounts = () =>
  cached("accounts", 10000, async () => {
    const d = await s2("GET", "/admin/accounts?page=1&page_size=1000&sort_by=priority&sort_order=asc");
    return d.items.map(stripAccount);
  });
async function getUserKeys(userId) {
  const d = await s2("GET", `/admin/users/${userId}/api-keys?page=1&page_size=200`);
  return d.items.map(({ key, group, ...k }) => ({ ...k, key_masked: key ? key.slice(0, 7) + "…" + key.slice(-4) : "" }));
}

// ---------- 鉴权 ----------
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${mac}`;
}
function verify(token) {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  return p.exp > Date.now() ? p : null;
}
function readCookie(req, name) {
  const m = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

const loginAttempts = new Map();
app.post("/api/login", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  const a = loginAttempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 10 * 60000) Object.assign(a, { n: 0, t: Date.now() });
  if (a.n >= 10) return res.status(429).json({ error: "尝试次数过多，请 10 分钟后再试" });
  const pw = String(req.body?.password || "");
  const ok = pw.length === APP_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(APP_PASSWORD));
  if (!ok) {
    a.n++;
    loginAttempts.set(ip, a);
    return res.status(401).json({ error: "密码错误" });
  }
  loginAttempts.delete(ip);
  const token = sign({ u: "admin", exp: Date.now() + 7 * 86400000 });
  res.setHeader("Set-Cookie", `ops_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}`);
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "ops_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});
app.use("/api", (req, res, next) => {
  if (!verify(readCookie(req, "ops_session"))) return res.status(401).json({ error: "未登录" });
  next();
});

const wrap = (fn) => (req, res) =>
  fn(req, res).then(
    (data) => res.json(data),
    (e) => {
      if (!e.status) console.error(e);
      res.status(e.status || 500).json({ error: e.message || "服务器错误" });
    }
  );

// ---------- 时间范围 ----------
function range(q) {
  const now = new Date();
  let start, end = q.end ? new Date(q.end) : now;
  switch (q.range || "24h") {
    case "today": {
      const d = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
      const offset = now.getTime() - d.getTime();
      d.setHours(0, 0, 0, 0);
      start = new Date(d.getTime() + offset);
      break;
    }
    case "1h": start = new Date(now - 3600e3); break;
    case "24h": start = new Date(now - 86400e3); break;
    case "7d": start = new Date(now - 7 * 86400e3); break;
    case "30d": start = new Date(now - 30 * 86400e3); break;
    case "custom": start = new Date(q.start); break;
    default: start = new Date(now - 86400e3);
  }
  if (isNaN(start) || isNaN(end)) throw httpError(400, "时间范围无效");
  return { start, end };
}
const pageOf = (q, def = 50) => {
  const page = Math.max(1, parseInt(q.page) || 1);
  const size = Math.min(200, Math.max(1, parseInt(q.page_size) || def));
  return { page, size, offset: (page - 1) * size };
};
const intOrNull = (v) => (v === undefined || v === "" || v === null ? null : parseInt(v));

// ---------- 基础数据 ----------
app.get("/api/meta", wrap(async () => ({ groups: await getGroups() })));
// 用户实时 RPM：直接按 usage_logs 统计近 60 秒每个用户的请求数 / token（滚动窗口，比 sub2api 的 rpm-status 准：
// 那个只算当前分钟、且只统计设了 RPM 上限的用户）。用户名 / 上限来自管理 API，缓存 60 秒
const getUsersAll = () =>
  cached("users-all", 60000, async () => {
    const d = await s2("GET", "/admin/users?page=1&page_size=1000");
    return new Map(d.items.map((u) => [u.id, u]));
  });
app.get("/api/monitor/user-rpm", wrap(async () =>
  cached("user-rpm", 3000, async () => {
    const [rows, users, groups] = await Promise.all([
      pool.query(
        `SELECT user_id, group_id, count(*)::int AS n,
                coalesce(sum(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0)::bigint AS tokens
           FROM usage_logs WHERE created_at > now() - interval '60 seconds' GROUP BY 1, 2`,
      ),
      getUsersAll().catch(() => new Map()),
      getGroups().catch(() => []),
    ]);
    const gname = new Map(groups.map((g) => [g.id, g.name]));
    const by = new Map();
    for (const r of rows.rows) {
      const u = users.get(r.user_id);
      const x = by.get(r.user_id) || {
        user_id: r.user_id,
        name: u?.username || u?.email || `用户 #${r.user_id}`,
        email: u?.email || "",
        rpm_limit: u?.rpm_limit || 0,
        concurrency: u?.current_concurrency ?? null,
        rpm: 0,
        tpm: 0,
        groups: [],
      };
      x.rpm += r.n;
      x.tpm += Number(r.tokens);
      x.groups.push({ group_id: r.group_id, name: gname.get(r.group_id) || `分组 #${r.group_id}`, rpm: r.n });
      by.set(r.user_id, x);
    }
    const list = [...by.values()].sort((a, b) => b.rpm - a.rpm);
    for (const x of list) x.groups.sort((a, b) => b.rpm - a.rpm);
    return { at: new Date().toISOString(), users: list };
  }),
));
app.get("/api/env", (req, res) => res.json({ readonly: READONLY, jobs: READONLY ? "observe" : "full" }));

app.get("/api/s2/users", wrap(async (req) => {
  const q = new URLSearchParams({ page: "1", page_size: "30" });
  if (req.query.search) q.set("search", req.query.search);
  const d = await s2("GET", `/admin/users?${q}`);
  return d.items.map((u) => ({ id: u.id, email: u.email, username: u.username, balance: u.balance, status: u.status, allowed_groups: u.allowed_groups, last_active_at: u.last_active_at }));
}));

app.post("/api/s2/users", wrap(async (req) => {
  const b = req.body || {};
  const body = {
    email: b.email,
    password: b.password,
    username: b.username || "",
    notes: b.notes || "",
    balance: b.balance === undefined || b.balance === "" ? undefined : Number(b.balance),
    concurrency: Number(b.concurrency) || 0,
    rpm_limit: Number(b.rpm_limit) || 0,
    allowed_groups: (b.allowed_groups || []).map(Number),
  };
  const u = await s2("POST", "/admin/users", body);
  return { id: u.id, email: u.email };
}));

app.put("/api/s2/users/:id", wrap(async (req) => {
  const b = req.body || {};
  const body = {};
  if (b.status) body.status = b.status;
  if (Array.isArray(b.allowed_groups)) body.allowed_groups = b.allowed_groups.map(Number);
  if (b.concurrency !== undefined) body.concurrency = Number(b.concurrency);
  if (b.rpm_limit !== undefined) body.rpm_limit = Number(b.rpm_limit);
  await s2("PUT", `/admin/users/${parseInt(req.params.id)}`, body);
  return { ok: true };
}));

app.put("/api/api-keys/:id/group", wrap(async (req) => {
  const gid = intOrNull(req.body?.group_id);
  await s2("PUT", `/admin/api-keys/${parseInt(req.params.id)}`, { group_id: gid ?? 0 });
  return { ok: true };
}));

// ---------- 客户 ----------
async function userStats(userIds, since) {
  if (!userIds.length) return {};
  const { rows } = await pool.query(
    `SELECT user_id, count(*)::int AS requests, coalesce(sum(actual_cost),0)::float AS cost
       FROM usage_logs WHERE user_id = ANY($1) AND created_at >= $2 GROUP BY user_id`,
    [userIds, since]
  );
  return Object.fromEntries(rows.map((r) => [r.user_id, r]));
}
async function userErrorCounts(userIds, since) {
  if (!userIds.length) return {};
  const { rows } = await pool.query(
    `SELECT user_id, count(*)::int AS n FROM ops_error_logs WHERE user_id = ANY($1) AND created_at >= $2 GROUP BY user_id`,
    [userIds, since]
  );
  return Object.fromEntries(rows.map((r) => [r.user_id, r.n]));
}

app.get("/api/customers", wrap(async () => {
  const list = loadCustomers();
  const ids = [...new Set(list.flatMap((c) => c.user_ids))];
  const today = range({ range: "today" }).start;
  const [stats, errs, users] = await Promise.all([
    userStats(ids, today),
    userErrorCounts(ids, new Date(Date.now() - 86400e3)),
    ids.length ? pool.query("SELECT id, email FROM users WHERE id = ANY($1)", [ids]).then((r) => r.rows) : [],
  ]);
  const emailOf = Object.fromEntries(users.map((u) => [u.id, u.email]));
  return list.map((c) => ({
    ...c,
    users: c.user_ids.map((id) => ({ id, email: emailOf[id] || `#${id}` })),
    today_requests: c.user_ids.reduce((s, id) => s + (stats[id]?.requests || 0), 0),
    today_cost: c.user_ids.reduce((s, id) => s + (stats[id]?.cost || 0), 0),
    errors_24h: c.user_ids.reduce((s, id) => s + (errs[id] || 0), 0),
  }));
}));

function customerInput(b) {
  const name = String(b.name || "").trim();
  if (!name) throw httpError(400, "客户名称必填");
  return {
    name,
    contact: String(b.contact || "").trim(),
    notes: String(b.notes || "").trim(),
    user_ids: [...new Set((b.user_ids || []).map(Number).filter(Boolean))],
  };
}
app.post("/api/customers", wrap(async (req) => {
  const list = loadCustomers();
  const c = { id: crypto.randomUUID().slice(0, 8), ...customerInput(req.body || {}), created_at: new Date().toISOString() };
  list.push(c);
  saveCustomers(list);
  return c;
}));
app.put("/api/customers/:id", wrap(async (req) => {
  const list = loadCustomers();
  const i = list.findIndex((x) => x.id === req.params.id);
  if (i < 0) throw httpError(404, "客户不存在");
  list[i] = { ...list[i], ...customerInput(req.body || {}), updated_at: new Date().toISOString() };
  saveCustomers(list);
  return list[i];
}));
app.delete("/api/customers/:id", wrap(async (req) => {
  saveCustomers(loadCustomers().filter((x) => x.id !== req.params.id));
  return { ok: true };
}));

app.get("/api/customers/:id/overview", wrap(async (req) => {
  const c = getCustomer(req.params.id);
  const ids = c.user_ids;
  const users = await Promise.all(
    ids.map(async (id) => {
      try {
        const u = await s2("GET", `/admin/users/${id}`);
        const keys = await getUserKeys(id);
        return { id: u.id, email: u.email, username: u.username, balance: u.balance, status: u.status, concurrency: u.concurrency, rpm_limit: u.rpm_limit, allowed_groups: u.allowed_groups || [], last_active_at: u.last_active_at, keys };
      } catch (e) {
        return { id, email: `#${id}`, missing: true, error: e.message, keys: [] };
      }
    })
  );
  let summary = { today: {}, d7: {}, d30: {} }, trend = [], errors = { h24: 0, d7: 0 };
  if (ids.length) {
    const sum = (since) =>
      pool
        .query(
          `SELECT count(*)::int AS requests, coalesce(sum(actual_cost),0)::float AS cost,
                  coalesce(sum(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens),0)::bigint AS tokens
             FROM usage_logs WHERE user_id = ANY($1) AND created_at >= $2`,
          [ids, since]
        )
        .then((r) => r.rows[0]);
    const [t, d7, d30, tr, e24, e7] = await Promise.all([
      sum(range({ range: "today" }).start),
      sum(new Date(Date.now() - 7 * 86400e3)),
      sum(new Date(Date.now() - 30 * 86400e3)),
      pool.query(
        `SELECT to_char(date_trunc('day', created_at AT TIME ZONE '${TZ}'), 'MM-DD') AS day,
                count(*)::int AS requests, coalesce(sum(actual_cost),0)::float AS cost
           FROM usage_logs WHERE user_id = ANY($1) AND created_at >= now() - interval '14 days'
          GROUP BY 1 ORDER BY 1`,
        [ids]
      ),
      pool.query("SELECT count(*)::int n FROM ops_error_logs WHERE user_id = ANY($1) AND created_at >= now() - interval '24 hours'", [ids]),
      pool.query("SELECT count(*)::int n FROM ops_error_logs WHERE user_id = ANY($1) AND created_at >= now() - interval '7 days'", [ids]),
    ]);
    summary = { today: t, d7, d30 };
    trend = tr.rows;
    errors = { h24: e24.rows[0].n, d7: e7.rows[0].n };
  }
  return { customer: c, users, summary, trend, errors };
}));

// 接入渠道：客户 Key 所在分组里的账号 + 近 7 天实际承接过该客户流量的账号
app.get("/api/customers/:id/channels", wrap(async (req) => {
  const c = getCustomer(req.params.id);
  const ids = c.user_ids;
  const [accounts, groups, keysPerUser] = await Promise.all([getAccounts(), getGroups(), Promise.all(ids.map((id) => getUserKeys(id).catch(() => [])))]);
  const keys = keysPerUser.flat();
  const groupIds = new Set(keys.map((k) => k.group_id).filter(Boolean));
  let usage = [], errs = [];
  if (ids.length) {
    [usage, errs] = await Promise.all([
      pool
        .query(
          `SELECT account_id, count(*)::int AS requests, coalesce(sum(actual_cost),0)::float AS cost, max(created_at) AS last_at
             FROM usage_logs WHERE user_id = ANY($1) AND created_at >= now() - interval '7 days' GROUP BY account_id`,
          [ids]
        )
        .then((r) => r.rows),
      pool
        .query(
          `SELECT account_id, count(*)::int AS n FROM ops_error_logs
            WHERE user_id = ANY($1) AND created_at >= now() - interval '7 days' AND account_id IS NOT NULL GROUP BY account_id`,
          [ids]
        )
        .then((r) => r.rows),
    ]);
  }
  const usageBy = Object.fromEntries(usage.map((r) => [r.account_id, r]));
  const errBy = Object.fromEntries(errs.map((r) => [r.account_id, r.n]));
  const list = accounts
    .filter((a) => a.group_ids.some((g) => groupIds.has(g)) || usageBy[a.id] || errBy[a.id])
    .map((a) => ({
      ...a,
      in_customer_groups: a.group_ids.filter((g) => groupIds.has(g)),
      cust_requests_7d: usageBy[a.id]?.requests || 0,
      cust_cost_7d: usageBy[a.id]?.cost || 0,
      cust_last_at: usageBy[a.id]?.last_at || null,
      cust_errors_7d: errBy[a.id] || 0,
    }));
  return {
    groups: groups.filter((g) => groupIds.has(g.id)).map((g) => ({ ...g, key_count: keys.filter((k) => k.group_id === g.id).length })),
    accounts: list,
  };
}));

function logFilters(q, ids, alias) {
  const { start, end } = range(q);
  const where = [`${alias}.user_id = ANY($1)`, `${alias}.created_at >= $2`, `${alias}.created_at < $3`];
  const params = [ids, start, end];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (q.model) add(`(${alias}.model ILIKE ? )`, `%${q.model}%`);
  if (intOrNull(q.api_key_id)) add(`${alias}.api_key_id = ?`, intOrNull(q.api_key_id));
  if (intOrNull(q.account_id)) add(`${alias}.account_id = ?`, intOrNull(q.account_id));
  if (intOrNull(q.group_id)) add(`${alias}.group_id = ?`, intOrNull(q.group_id));
  if (intOrNull(q.user_id)) add(`${alias}.user_id = ?`, intOrNull(q.user_id));
  return { where: where.join(" AND "), params };
}

app.get("/api/customers/:id/usage", wrap(async (req) => {
  const c = getCustomer(req.params.id);
  if (!c.user_ids.length) return { items: [], total: 0, sum: {} };
  const { page, size, offset } = pageOf(req.query);
  const { where, params } = logFilters(req.query, c.user_ids, "u");
  const [items, agg] = await Promise.all([
    pool.query(
      `SELECT u.id, u.created_at, u.user_id, us.email, u.api_key_id, k.name AS key_name, u.account_id, a.name AS account_name,
              u.group_id, g.name AS group_name, u.model, u.requested_model, u.upstream_model, u.input_tokens, u.output_tokens,
              u.cache_creation_tokens, u.cache_read_tokens, u.actual_cost::float, u.total_cost::float, u.rate_multiplier::float,
              u.duration_ms, u.first_token_ms, u.stream, u.inbound_endpoint, u.ip_address AS ip, u.user_agent
         FROM usage_logs u
         LEFT JOIN api_keys k ON k.id = u.api_key_id
         LEFT JOIN accounts a ON a.id = u.account_id
         LEFT JOIN groups g ON g.id = u.group_id
         LEFT JOIN users us ON us.id = u.user_id
        WHERE ${where} ORDER BY u.created_at DESC LIMIT ${size} OFFSET ${offset}`,
      params
    ),
    pool.query(
      `SELECT count(*)::int AS total, coalesce(sum(actual_cost),0)::float AS cost,
              coalesce(sum(input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens),0)::bigint AS tokens,
              coalesce(avg(duration_ms),0)::int AS avg_ms
         FROM usage_logs u WHERE ${where}`,
      params
    ),
  ]);
  return { items: items.rows, total: agg.rows[0].total, sum: agg.rows[0], page, page_size: size };
}));

app.get("/api/customers/:id/errors", wrap(async (req) => {
  const c = getCustomer(req.params.id);
  if (!c.user_ids.length) return { items: [], total: 0, by_status: [] };
  const { page, size, offset } = pageOf(req.query);
  const f = logFilters(req.query, c.user_ids, "e");
  let { where, params } = f;
  if (intOrNull(req.query.status_code)) {
    params = [...params, intOrNull(req.query.status_code)];
    where += ` AND e.status_code = $${params.length}`;
  }
  if (req.query.owner) {
    params = [...params, req.query.owner];
    where += ` AND e.error_owner = $${params.length}`;
  }
  const [items, total, byStatus, byAccount] = await Promise.all([
    pool.query(
      `SELECT e.id, e.created_at, e.user_id, us.email, e.api_key_id, k.name AS key_name, e.account_id, a.name AS account_name,
              e.group_id, g.name AS group_name, e.platform, e.model, e.requested_model, e.status_code, e.upstream_status_code,
              e.error_phase, e.error_type, e.error_owner, e.error_source, e.severity, left(e.error_message, 600) AS error_message,
              left(e.upstream_error_message, 600) AS upstream_error_message, e.duration_ms, e.request_path, e.stream,
              host(e.client_ip) AS client_ip, e.resolved
         FROM ops_error_logs e
         LEFT JOIN api_keys k ON k.id = e.api_key_id
         LEFT JOIN accounts a ON a.id = e.account_id
         LEFT JOIN groups g ON g.id = e.group_id
         LEFT JOIN users us ON us.id = e.user_id
        WHERE ${where} ORDER BY e.created_at DESC LIMIT ${size} OFFSET ${offset}`,
      params
    ),
    pool.query(`SELECT count(*)::int AS n FROM ops_error_logs e WHERE ${where}`, params),
    pool.query(`SELECT e.status_code, count(*)::int AS n FROM ops_error_logs e WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, params),
    pool.query(
      `SELECT e.account_id, a.name AS account_name, count(*)::int AS n FROM ops_error_logs e LEFT JOIN accounts a ON a.id = e.account_id
        WHERE ${where} GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`,
      params
    ),
  ]);
  return { items: items.rows, total: total.rows[0].n, by_status: byStatus.rows, by_account: byAccount.rows, page, page_size: size };
}));

app.get("/api/errors/:id", wrap(async (req) => {
  const { rows } = await pool.query(
    `SELECT id, created_at, request_id, client_request_id, error_message, error_body, upstream_error_message,
            upstream_error_detail, upstream_errors, provider_error_code, provider_error_type, network_error_type,
            request_path, inbound_endpoint, upstream_endpoint, requested_model, upstream_model, user_agent
       FROM ops_error_logs WHERE id = $1`,
    [parseInt(req.params.id)]
  );
  if (!rows[0]) throw httpError(404, "记录不存在");
  return rows[0];
}));

// ---------- 账号管理 ----------
app.get("/api/accounts", wrap(async () => {
  const accounts = await getAccounts();
  const { rows } = await pool.query(
    `SELECT account_id, count(*)::int AS n FROM ops_error_logs
      WHERE created_at >= now() - interval '24 hours' AND account_id IS NOT NULL GROUP BY account_id`
  );
  const errBy = Object.fromEntries(rows.map((r) => [r.account_id, r.n]));
  let today = {};
  try {
    const d = await cached("today-stats", 15000, () => s2("POST", "/admin/accounts/today-stats/batch", { account_ids: accounts.map((a) => a.id) }));
    today = d?.stats || d || {};
  } catch {}
  return accounts.map((a) => ({ ...a, errors_24h: errBy[a.id] || 0, today: today[a.id] || today[String(a.id)] || null }));
}));

app.post("/api/accounts/bulk", wrap(async (req) => {
  const b = req.body || {};
  const ids = (b.account_ids || []).map(Number).filter(Boolean);
  if (!ids.length) throw httpError(400, "未选择账号");
  const body = { account_ids: ids };
  if (b.priority !== undefined && b.priority !== "") body.priority = parseInt(b.priority);
  if (b.concurrency !== undefined && b.concurrency !== "") body.concurrency = parseInt(b.concurrency);
  if (b.status) {
    if (!["active", "inactive"].includes(b.status)) throw httpError(400, "状态只能是启用或禁用");
    body.status = b.status;
  }
  if (typeof b.schedulable === "boolean") body.schedulable = b.schedulable;
  if (Array.isArray(b.group_ids)) {
    body.group_ids = b.group_ids.map(Number);
    body.confirm_mixed_channel_risk = !!b.confirm_mixed_channel_risk;
  }
  if (Object.keys(body).length === 1) throw httpError(400, "没有要修改的字段");
  const r = await s2("POST", "/admin/accounts/bulk-update", body);
  bust("accounts");
  bust("groups");
  // 写完立刻从 sub2api 读回核对，确认真的生效
  const fields = ["priority", "concurrency", "status", "schedulable", "group_ids"].filter((k) => k in body);
  const verified = await Promise.all(
    ids.map(async (id) => {
      try {
        const a = await s2("GET", `/admin/accounts/${id}`);
        const got = { ...a, group_ids: a.group_ids || [] };
        const mismatch = fields.filter((k) => JSON.stringify(k === "group_ids" ? [...got[k]].sort() : got[k]) !== JSON.stringify(k === "group_ids" ? [...body[k]].sort() : body[k]));
        const live = sched.rt.accounts.find((x) => x.id === id);
        if (live) Object.assign(live, Object.fromEntries(fields.map((k) => [k, got[k]])));
        return { id, ok: !mismatch.length, mismatch: mismatch.map((k) => `${k}=${JSON.stringify(got[k])}`) };
      } catch (e) {
        return { id, ok: false, mismatch: [`读回失败：${e.message}`] };
      }
    })
  );
  return { ...r, verified };
}));

app.post("/api/accounts/:id/clear-error", wrap(async (req) => {
  await s2("POST", `/admin/accounts/${parseInt(req.params.id)}/clear-error`);
  bust("accounts");
  return { ok: true };
}));
app.post("/api/accounts/:id/clear-rate-limit", wrap(async (req) => {
  await s2("POST", `/admin/accounts/${parseInt(req.params.id)}/clear-rate-limit`);
  bust("accounts");
  return { ok: true };
}));

app.get("/api/accounts/:id/errors", wrap(async (req) => {
  const { page, size, offset } = pageOf(req.query, 30);
  const { start, end } = range(req.query);
  const id = parseInt(req.params.id);
  const [items, total] = await Promise.all([
    pool.query(
      `SELECT e.id, e.created_at, us.email, e.model, e.status_code, e.error_owner, e.error_type, left(e.error_message, 600) AS error_message
         FROM ops_error_logs e LEFT JOIN users us ON us.id = e.user_id
        WHERE e.account_id = $1 AND e.created_at >= $2 AND e.created_at < $3 ORDER BY e.created_at DESC LIMIT ${size} OFFSET ${offset}`,
      [id, start, end]
    ),
    pool.query("SELECT count(*)::int n FROM ops_error_logs WHERE account_id = $1 AND created_at >= $2 AND created_at < $3", [id, start, end]),
  ]);
  return { items: items.rows, total: total.rows[0].n, page, page_size: size };
}));


// ---------- 智能调度 ----------
const sched = createScheduler({ s2, s2raw, pool, dataDir: DATA_DIR, onAccountsChanged: () => bust("accounts"), observeOnly: READONLY });
sched.start(); // 只读模式下只观察（读指标、算评分），不做任何调整

async function schedAccounts() {
  return getAccounts(); // 10 秒缓存，写操作后立即失效
}
// 某分组内账号的聚合指标（来自最近一次评分）
function groupAccountStats(gid) {
  const out = {};
  for (const [k, list] of Object.entries(sched.rt.cells)) {
    if (k.slice(0, k.indexOf("|")) !== String(gid)) continue;
    for (const c of list) {
      const o = (out[c.account_id] ||= { n: 0, errors: 0, p50w: 0, p90w: 0, tw: 0, cr: 0, tin: 0, scoreW: 0, sw: 0 });
      o.n += c.n;
      o.errors += c.errors;
      if (c.p50 > 0) { o.p50w += c.p50 * c.n; o.p90w += (c.p90 || c.p50) * c.n; o.tw += c.n; }
      o.cr += c.cr || 0; // 缓存命中率按 token 加权，与 sub2api 一致：Σ缓存读 / Σ(输入+缓存读+缓存写)
      o.tin += c.tin || 0;
      if (c.score != null) { o.scoreW += c.score * (c.n + c.errors); o.sw += c.n + c.errors; }
    }
  }
  for (const o of Object.values(out)) {
    o.p50 = o.tw ? Math.round(o.p50w / o.tw) : null;
    o.p90 = o.tw ? Math.round(o.p90w / o.tw) : null;
    o.cache = o.tin ? o.cr / o.tin : null;
    o.err = o.n + o.errors ? o.errors / (o.n + o.errors) : 0;
    o.score = o.sw ? +(o.scoreW / o.sw).toFixed(3) : null;
  }
  return out;
}

const detector = createDetector({
  s2,
  pool,
  dataDir: DATA_DIR,
  getAccounts,
  getGroupCfg: (gid) => sched.getGroupCfg(gid),
  allGroupCfgs: () => ({ groups: sched.state.groups, defaultModel: sched.state.config.probeModel }),
  log: sched.log,
});
// 深度检测会直接请求上游并产生费用，只读模式下不运行
if (!READONLY) detector.start();
const blockInReadonly = (what) => {
  if (READONLY) throw httpError(403, `只读模式：${what}已禁用`);
};
// 只读模式下调度 / 检测的所有修改一律拦截：避免本地调度状态与线上不一致
app.use(["/api/sched", "/api/detect"], (req, res, next) => {
  if (READONLY && req.method !== "GET") return res.status(403).json({ error: "只读模式：调度与检测设置不可修改" });
  next();
});

app.get("/api/alerts", wrap(async () => ({ alerts: [...detector.alerts, ...sched.rt.alerts], lastError: sched.rt.lastError })));
app.put("/api/detect/accounts/:id/key", wrap(async (req) => {
  detector.setKey(parseInt(req.params.id), req.body?.key);
  return detector.keyInfo(parseInt(req.params.id));
}));
app.post("/api/detect/accounts/:id/run", wrap(async (req) => {
  blockInReadonly("深度检测（会直接请求上游并产生费用）");
  return detector.run(parseInt(req.params.id), "手动");
}));
app.get("/api/detect/accounts/:id", wrap(async (req) => {
  const id = parseInt(req.params.id);
  return { ...detector.keyInfo(id), running: detector.isRunning(id), history: detector.history(id) };
}));

app.get("/api/sched/overview", wrap(async () => {
  const [groups, accounts] = await Promise.all([getGroups(), schedAccounts()]);
  const st = sched.state;
  return {
    enabled: st.enabled, config: st.config, lastFast: sched.rt.lastFast, lastScore: sched.rt.lastScore, lastError: sched.rt.lastError, alerts: [...detector.alerts, ...sched.rt.alerts],
    groups: groups.map((g) => {
      const cfg = st.groups[g.id] || {};
      const members = accounts.filter((a) => a.group_ids.includes(g.id));
      const enrolled = (cfg.accounts || []).filter((id) => members.some((a) => a.id === id));
      return {
        id: g.id, name: g.name, platform: g.platform, is_exclusive: g.is_exclusive, status: g.status,
        member_count: members.length, member_available: members.filter(sched.isAvailable).length,
        enrolled_count: enrolled.length, alive: enrolled.length ? sched.aliveIn(g.id).length : null,
        min_alive: cfg.minAlive ?? st.config.minAlive, auto: !!cfg.auto, routing: !!cfg.routing,
        model_routing_enabled: !!g.model_routing_enabled, routing_rules: Object.keys(g.model_routing || {}).length,
      };
    }),
  };
}));

app.get("/api/sched/groups/:id", wrap(async (req) => {
  const gid = parseInt(req.params.id);
  bust("groups");
  const [groups, accounts] = await Promise.all([getGroups(), schedAccounts()]);
  const g = groups.find((x) => x.id === gid);
  if (!g) throw httpError(404, "分组不存在");
  const cfg = sched.state.groups[gid] || { accounts: [] };
  const stats = groupAccountStats(gid);
  const members = accounts.filter((a) => a.group_ids.includes(gid));
  // 已关联但被移出分组的账号也列出来，方便取消关联
  const orphan = cfg.accounts.filter((id) => !members.some((a) => a.id === id)).map((id) => accounts.find((a) => a.id === id)).filter(Boolean);
  const nameOf = (id) => accounts.find((a) => a.id === id)?.name || `#${id}`;
  const cells = Object.entries(sched.rt.cells)
    .filter(([k]) => k.slice(0, k.indexOf("|")) === String(gid))
    .map(([k, list]) => ({ model: k.slice(k.indexOf("|") + 1), accounts: list.map((c) => ({ ...c, name: nameOf(c.account_id) })).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) }))
    .sort((a, b) => b.accounts.reduce((s, c) => s + c.n, 0) - a.accounts.reduce((s, c) => s + c.n, 0));
  return {
    group: { id: g.id, name: g.name, platform: g.platform, model_routing_enabled: g.model_routing_enabled, model_routing: Object.fromEntries(Object.entries(g.model_routing || {}).map(([m, ids]) => [m, ids.map((id) => ({ id, name: nameOf(id) }))])) },
    cfg: { auto: !!cfg.auto, routing: !!cfg.routing, min_alive: cfg.minAlive ?? sched.state.config.minAlive, has_original_routing: !!cfg.originalRouting, probe_model: cfg.probeModel || "", default_probe_model: sched.state.config.probeModel, min_samples: sched.state.config.minSamples, detect: !!cfg.detect, detect_expect: cfg.detectExpect || "any" },
    enabled: sched.state.enabled,
    alive: cfg.accounts.length ? sched.aliveIn(gid).length : null,
    accounts: [...members, ...orphan].map((a) => {
      const st = sched.state.accounts[a.id] || {};
      return {
        ...a, in_group: a.group_ids.includes(gid), enrolled: cfg.accounts.includes(a.id), other_sched_groups: sched.groupsOfAccount(a.id).filter((x) => x !== gid),
        breaker: st.breaker || "closed", breaker_reason: st.reason, probe_fails: st.probeFails || 0, last_probe: st.lastProbe, probation_until: st.probationUntil,
        original: st.original, live: sched.rt.live[a.id] || null, detect: { ...detector.keyInfo(a.id), latest: detector.latest(a.id), running: detector.isRunning(a.id) }, stats: stats[a.id] || null, overall: sched.rt.scores[a.id] ? { score: sched.rt.scores[a.id].score, suggested: sched.rt.scores[a.id].suggested } : null,
      };
    }),
    cells,
  };
}));

app.put("/api/sched/groups/:id", wrap(async (req) => {
  await sched.setGroup(parseInt(req.params.id), req.body || {});
  return { ok: true };
}));
app.post("/api/sched/groups/:id/enroll", wrap(async (req) => {
  const ids = (req.body?.account_ids || []).map(Number).filter(Boolean);
  if (!ids.length) throw httpError(400, "未选择账号");
  await sched.enroll(parseInt(req.params.id), ids, req.body.enrolled !== false);
  return { ok: true };
}));
// 调整 sub2api 里分组的账号成员
app.post("/api/sched/groups/:id/members", wrap(async (req) => {
  const gid = parseInt(req.params.id);
  const { add = [], remove = [], confirm_mixed_channel_risk } = req.body || {};
  bust("accounts");
  const accounts = await getAccounts();
  const results = [];
  for (const [ids, adding] of [[add, true], [remove, false]]) {
    for (const aid of ids.map(Number)) {
      const a = accounts.find((x) => x.id === aid);
      if (!a) continue;
      const next = adding ? [...new Set([...a.group_ids, gid])] : a.group_ids.filter((x) => x !== gid);
      try {
        await s2("POST", "/admin/accounts/bulk-update", { account_ids: [aid], group_ids: next, confirm_mixed_channel_risk: !!confirm_mixed_channel_risk });
        if (!adding) await sched.enroll(gid, [aid], false);
        results.push({ id: aid, ok: true });
      } catch (e) {
        results.push({ id: aid, ok: false, error: e.message });
      }
    }
  }
  bust("accounts");
  bust("groups");
  sched.fastTick();
  return { results };
}));
app.post("/api/sched/accounts/:id/probe", wrap(async (req) => sched.probeNow(parseInt(req.params.id))));
app.put("/api/sched/config", wrap(async (req) => {
  sched.setGlobal(req.body || {});
  return { ok: true };
}));
app.get("/api/sched/audit", wrap(async (req) => sched.audit(Math.min(1000, parseInt(req.query.limit) || 300), req.query)));
app.post("/api/sched/restore", wrap(async () => {
  blockInReadonly("一键还原");
  await sched.restoreAll();
  bust("accounts");
  bust("groups");
  return { ok: true };
}));
app.post("/api/sched/run", wrap(async () => {
  blockInReadonly("立即运行调度");
  await sched.fastTick();
  await sched.scoreTick();
  return { ok: true, lastError: sched.rt.lastError };
}));


// ---------- 账号详情 / 新建 / 编辑 ----------
app.get("/api/proxies", wrap(async () => (await s2("GET", "/admin/proxies/all")).map(({ password, ...p }) => p)));

app.get("/api/accounts/:id/full", wrap(async (req) => {
  const id = parseInt(req.params.id);
  const a = await s2("GET", `/admin/accounts/${id}`);
  const { account_groups, groups, ...acc } = a;
  const [stats, errs, perf] = await Promise.all([
    pool.query(
      `SELECT count(*) FILTER (WHERE created_at >= $2)::int AS today_n, coalesce(sum(actual_cost) FILTER (WHERE created_at >= $2), 0)::float AS today_cost,
              coalesce(sum(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) FILTER (WHERE created_at >= $2), 0)::bigint AS today_tokens,
              count(*)::int AS d7_n, coalesce(sum(actual_cost), 0)::float AS d7_cost,
              coalesce(sum(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens), 0)::bigint AS d7_tokens
         FROM usage_logs WHERE account_id = $1 AND created_at >= now() - interval '7 days'`,
      [id, range({ range: "today" }).start]
    ),
    pool.query(
      `SELECT ${ERROR_CLASS_SQL} AS cls, count(*)::int AS n FROM ops_error_logs e
        WHERE e.account_id = $1 AND e.created_at >= now() - interval '24 hours' GROUP BY 1`,
      [id]
    ),
    pool.query(
      `SELECT count(*)::int AS n,
              (SELECT coalesce(sum(cache_read_tokens), 0)::float / nullif(sum(input_tokens + cache_read_tokens + cache_creation_tokens), 0)
                 FROM usage_logs WHERE account_id = $1 AND created_at >= $2) AS cache_today,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL) AS p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL) AS p90,
              coalesce(sum(cache_read_tokens), 0)::float AS rd, coalesce(sum(input_tokens + cache_read_tokens + cache_creation_tokens), 0)::float AS tin
         FROM usage_logs WHERE account_id = $1 AND created_at >= now() - interval '1 hour'`,
      [id, range({ range: "today" }).start]
    ),
  ]);
  const st = sched.state.accounts[id] || {};
  const p = perf.rows[0];
  return {
    account: acc,
    stats: stats.rows[0],
    errors_24h: Object.fromEntries(errs.rows.map((r) => [r.cls, r.n])),
    perf_1h: { n: p.n, p50: p.p50 == null ? null : Math.round(p.p50), p90: p.p90 == null ? null : Math.round(p.p90), cache: p.tin ? p.rd / p.tin : null, cache_today: p.cache_today },
    sched: { groups: sched.groupsOfAccount(id), breaker: st.breaker || null, reason: st.reason, probe_fails: st.probeFails || 0, last_probe: st.lastProbe, original: st.original },
    detect: { ...detector.keyInfo(id), latest: detector.latest(id), running: detector.isRunning(id) },
  };
}));

// 表单 → sub2api 请求体。credentials 由前端带上完整的非敏感配置；api_key 只有填了才提交（sub2api 不传敏感键 = 保留原值）
function accountPayload(b, creating) {
  const credentials = { ...(b.credentials && typeof b.credentials === "object" ? b.credentials : {}) };
  for (const k of ["api_key", "access_token", "refresh_token", "session_key", "cookie"]) delete credentials[k];
  credentials.base_url = String(b.base_url || "").trim().replace(/\/+$/, "");
  if (!credentials.base_url) throw httpError(400, "base_url 必填");
  credentials.model_mapping = b.model_mapping && typeof b.model_mapping === "object" ? b.model_mapping : {};
  credentials.pool_mode = !!b.pool_mode;
  if (b.pool_mode) {
    credentials.pool_mode_retry_count = parseInt(b.pool_mode_retry_count) || 0;
    const codes = String(b.pool_mode_retry_status_codes ?? "").split(/[,\s，]+/).map(Number).filter(Boolean);
    if (codes.length) credentials.pool_mode_retry_status_codes = codes;
    else delete credentials.pool_mode_retry_status_codes;
  } else {
    delete credentials.pool_mode_retry_count;
    delete credentials.pool_mode_retry_status_codes;
  }
  const key = String(b.api_key || "").trim();
  if (key) credentials.api_key = key;
  if (creating && !key) throw httpError(400, "新建账号必须填写 API Key");
  const name = String(b.name || "").trim();
  if (!name) throw httpError(400, "账号名称必填");
  const num = (v, d) => (v === "" || v === undefined || v === null ? d : Number(v));
  const body = {
    name,
    notes: String(b.notes || ""),
    credentials,
    concurrency: num(b.concurrency, 10),
    priority: num(b.priority, 1),
    rate_multiplier: num(b.rate_multiplier, 1),
    load_factor: num(b.load_factor, 0),
    proxy_id: num(b.proxy_id, 0),
    group_ids: (b.group_ids || []).map(Number),
    expires_at: b.expires_at ? Math.floor(new Date(b.expires_at).getTime() / 1000) : 0,
    auto_pause_on_expired: !!b.auto_pause_on_expired,
    upstream_billing_probe_enabled: !!b.upstream_billing_probe_enabled,
    confirm_mixed_channel_risk: !!b.confirm_mixed_channel_risk,
  };
  if (b.extra && typeof b.extra === "object") body.extra = b.extra;
  if (creating) {
    body.platform = b.platform || "anthropic";
    body.type = "apikey";
    if (!body.proxy_id) delete body.proxy_id;
    if (!body.load_factor) delete body.load_factor;
    if (!body.expires_at) delete body.expires_at;
  } else if (["active", "inactive"].includes(b.status)) body.status = b.status;
  return body;
}

app.post("/api/accounts", wrap(async (req) => {
  const b = req.body || {};
  const a = await s2("POST", "/admin/accounts", accountPayload(b, true));
  if (b.schedulable === false) await s2("POST", "/admin/accounts/bulk-update", { account_ids: [a.id], schedulable: false });
  if (b.use_as_detect_key) detector.setKey(a.id, b.api_key);
  bust("accounts");
  bust("groups");
  return { id: a.id };
}));

app.put("/api/accounts/:id", wrap(async (req) => {
  const id = parseInt(req.params.id);
  const b = req.body || {};
  await s2("PUT", `/admin/accounts/${id}`, accountPayload(b, false));
  if (typeof b.schedulable === "boolean") await s2("POST", "/admin/accounts/bulk-update", { account_ids: [id], schedulable: b.schedulable });
  if (b.use_as_detect_key && b.api_key) detector.setKey(id, b.api_key);
  bust("accounts");
  bust("groups");
  return { ok: true };
}));

app.delete("/api/accounts/:id", wrap(async (req) => {
  const id = parseInt(req.params.id);
  await s2("DELETE", `/admin/accounts/${id}`);
  for (const gid of sched.groupsOfAccount(id)) await sched.enroll(gid, [id], false).catch(() => {});
  detector.setKey(id, "");
  bust("accounts");
  bust("groups");
  return { ok: true };
}));

// 调 sub2api 自带的账号测试（流式），收集结果一次性返回
app.post("/api/accounts/:id/test", wrap(async (req) => {
  const id = parseInt(req.params.id);
  const started = Date.now();
  const res = await s2raw("POST", `/admin/accounts/${id}/test`, req.body?.model_id ? { model_id: req.body.model_id } : {}, 120000);
  const text = await res.text();
  let ok = false, out = "", error = "", model = "";
  for (const line of text.split("\n")) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m) continue;
    try {
      const ev = JSON.parse(m[1]);
      if (ev.type === "test_start") model = ev.model || "";
      if (ev.type === "content") out += ev.text || "";
      if (ev.type === "test_complete") ok = !!ev.success;
      if (ev.type === "error") error = ev.error || ev.text || "error";
    } catch {}
  }
  if (!ok && !error) error = `测试未返回成功（HTTP ${res.status}）${text.slice(0, 200)}`;
  return { ok, model, output: out.slice(0, 2000), error, ms: Date.now() - started };
}));

app.get("/api/accounts/:id/usage", wrap(async (req) => {
  const id = parseInt(req.params.id);
  const { page, size, offset } = pageOf(req.query, 30);
  const { start, end } = range(req.query);
  const [items, agg] = await Promise.all([
    pool.query(
      `SELECT u.id, u.created_at, us.email, k.name AS key_name, g.name AS group_name, u.model, u.upstream_model, u.input_tokens, u.output_tokens,
              u.cache_creation_tokens, u.cache_read_tokens, u.actual_cost::float, u.duration_ms, u.first_token_ms, u.stream
         FROM usage_logs u LEFT JOIN users us ON us.id = u.user_id LEFT JOIN api_keys k ON k.id = u.api_key_id LEFT JOIN groups g ON g.id = u.group_id
        WHERE u.account_id = $1 AND u.created_at >= $2 AND u.created_at < $3 ORDER BY u.created_at DESC LIMIT ${size} OFFSET ${offset}`,
      [id, start, end]
    ),
    pool.query("SELECT count(*)::int n FROM usage_logs WHERE account_id = $1 AND created_at >= $2 AND created_at < $3", [id, start, end]),
  ]);
  return { items: items.rows, total: agg.rows[0].n, page, page_size: size };
}));


// ---------- 账单 ----------
// 结算金额 = usage_logs.actual_cost（按用户倍率计算后实际扣费，与余额扣减一致）；日期按北京时间整天
function billingParams(q) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(q.start || "") || !re.test(q.end || "")) throw httpError(400, "请选择起止日期");
  const start = new Date(`${q.start}T00:00:00+08:00`);
  const end = new Date(new Date(`${q.end}T00:00:00+08:00`).getTime() + 86400e3);
  if (end <= start) throw httpError(400, "结束日期不能早于开始日期");
  if (end - start > 370 * 86400e3) throw httpError(400, "单次最多拉取一年");
  const userIds = String(q.user_ids || "").split(",").map(Number).filter(Boolean);
  if (!userIds.length) throw httpError(400, "请至少选择一个用户");
  const discount = q.discount === undefined || q.discount === "" ? 1 : Number(q.discount);
  if (!(discount > 0 && discount <= 10)) throw httpError(400, "折扣系数无效（例：0.85 表示 85 折）");
  return { start, end, userIds, discount };
}

async function billingSummary({ start, end, userIds }) {
  const args = [userIds, start, end];
  const where = "u.user_id = ANY($1) AND u.created_at >= $2 AND u.created_at < $3";
  const sums = `count(*)::int AS requests, coalesce(sum(u.actual_cost),0)::float AS cost, coalesce(sum(u.total_cost),0)::float AS std_cost,
    coalesce(sum(u.input_tokens),0)::bigint AS input, coalesce(sum(u.output_tokens),0)::bigint AS output,
    coalesce(sum(u.cache_creation_tokens),0)::bigint AS cache_write, coalesce(sum(u.cache_read_tokens),0)::bigint AS cache_read`;
  const [total, byUser, byModel, daily] = await Promise.all([
    pool.query(`SELECT ${sums} FROM usage_logs u WHERE ${where}`, args),
    pool.query(`SELECT u.user_id, us.email, ${sums} FROM usage_logs u LEFT JOIN users us ON us.id = u.user_id WHERE ${where} GROUP BY 1, 2 ORDER BY cost DESC`, args),
    pool.query(`SELECT u.model, ${sums} FROM usage_logs u WHERE ${where} GROUP BY 1 ORDER BY cost DESC`, args),
    pool.query(
      `SELECT to_char(date_trunc('day', u.created_at AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') AS day, u.user_id, ${sums}
         FROM usage_logs u WHERE ${where} GROUP BY 1, 2 ORDER BY 1, 2`,
      args
    ),
  ]);
  // 选中但没有用量的用户也列出来
  const { rows: users } = await pool.query("SELECT id, email FROM users WHERE id = ANY($1)", [userIds]);
  const seen = new Set(byUser.rows.map((r) => r.user_id));
  for (const u of users) if (!seen.has(u.id)) byUser.rows.push({ user_id: u.id, email: u.email, requests: 0, cost: 0, std_cost: 0, input: 0, output: 0, cache_write: 0, cache_read: 0 });
  return { total: total.rows[0], by_user: byUser.rows, by_model: byModel.rows, daily: daily.rows };
}

app.get("/api/billing/summary", wrap(async (req) => {
  const p = billingParams(req.query);
  const sum = await billingSummary(p);
  // 每天合计（缩略图用）；没有用量的日期补 0
  const days = [];
  for (let t = p.start.getTime(); t < p.end.getTime(); t += 86400e3) days.push(new Date(t + 8 * 3600e3).toISOString().slice(0, 10));
  const byDay = {};
  for (const r of sum.daily) {
    const d = (byDay[r.day] ||= { day: r.day, cost: 0, requests: 0 });
    d.cost += r.cost;
    d.requests += r.requests;
  }
  return { ...sum, discount: p.discount, final_cost: sum.total.cost * p.discount, daily: days.map((day) => byDay[day] || { day, cost: 0, requests: 0 }) };
}));

app.get("/api/billing/export", async (req, res) => {
  try {
    const p = billingParams(req.query);
    const sum = await billingSummary(p);
    const tag = `${req.query.start}_${req.query.end}`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`账单_${tag}${p.discount !== 1 ? `_${+(p.discount * 10).toFixed(2)}折` : ""}.xlsx`)}`);
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    const head = (ws) => { ws.getRow(1).font = { bold: true }; ws.getRow(1).commit(); };
    const money = "$#,##0.000000";
    const tokenCols = [
      { header: "请求数", key: "requests", width: 10 },
      { header: "输入 tokens", key: "input", width: 14 },
      { header: "输出 tokens", key: "output", width: 14 },
      { header: "缓存写 tokens", key: "cache_write", width: 14 },
      { header: "缓存读 tokens", key: "cache_read", width: 14 },
      { header: "标准费用($)", key: "std_cost", width: 14, style: { numFmt: money } },
      { header: "结算金额($)", key: "cost", width: 14, style: { numFmt: money } },
      { header: `折后金额($)×${p.discount}`, key: "final", width: 16, style: { numFmt: money } },
    ];
    const num = (r) => ({ ...r, input: Number(r.input), output: Number(r.output), cache_write: Number(r.cache_write), cache_read: Number(r.cache_read), final: (r.cost || 0) * p.discount });

    // 1. 汇总
    const s1 = wb.addWorksheet("汇总");
    s1.columns = [{ header: "用户ID", key: "user_id", width: 10 }, { header: "用户邮箱", key: "email", width: 28 }, ...tokenCols];
    head(s1);
    for (const r of sum.by_user) s1.addRow(num(r)).commit();
    const totalRow = s1.addRow({ email: "合计", ...num(sum.total) });
    totalRow.font = { bold: true };
    totalRow.commit();
    s1.addRow({}).commit();
    const discTxt = p.discount === 1 ? "无折扣" : `${+(p.discount * 10).toFixed(2)} 折（系数 ${p.discount}）`;
    for (const [k, v, bold] of [
      ["账单区间", `${req.query.start} 00:00 至 ${req.query.end} 24:00（北京时间）`],
      ["原结算合计", `$${sum.total.cost.toFixed(6)}`],
      ["折扣", discTxt],
      ["折后应付合计", `$${(sum.total.cost * p.discount).toFixed(2)}`, true],
      ["说明", "结算金额 = 按用户倍率计算后的实际用量费用；折后金额 = 结算金额 × 折扣系数；标准费用 = 倍率前的原价"],
    ]) {
      const r = s1.addRow({ user_id: k, email: v });
      if (bold) r.font = { bold: true, size: 13 };
      r.commit();
    }
    s1.commit();

    // 2. 每日明细
    const emailOf = Object.fromEntries(sum.by_user.map((u) => [u.user_id, u.email]));
    const s2 = wb.addWorksheet("每日明细");
    s2.columns = [{ header: "日期", key: "day", width: 12 }, { header: "用户ID", key: "user_id", width: 10 }, { header: "用户邮箱", key: "email", width: 28 }, ...tokenCols];
    head(s2);
    for (const r of sum.daily) s2.addRow(num({ ...r, email: emailOf[r.user_id] })).commit();
    s2.commit();

    // 3. 按模型
    const s3 = wb.addWorksheet("按模型");
    s3.columns = [{ header: "模型", key: "model", width: 30 }, ...tokenCols];
    head(s3);
    for (const r of sum.by_model) s3.addRow(num(r)).commit();
    s3.commit();

    // 4. 请求明细：分批读，流式写出
    const s4 = wb.addWorksheet("请求明细");
    s4.columns = [
      { header: "时间(北京)", key: "t", width: 20 }, { header: "用户ID", key: "user_id", width: 9 }, { header: "用户邮箱", key: "email", width: 26 },
      { header: "API Key", key: "key_name", width: 18 }, { header: "分组", key: "group_name", width: 16 }, { header: "模型", key: "model", width: 26 },
      { header: "输入", key: "input_tokens", width: 10 }, { header: "输出", key: "output_tokens", width: 10 }, { header: "缓存写", key: "cache_creation_tokens", width: 10 },
      { header: "缓存读", key: "cache_read_tokens", width: 11 }, { header: "标准费用($)", key: "total_cost", width: 13, style: { numFmt: money } },
      { header: "倍率", key: "rate_multiplier", width: 7 }, { header: "结算金额($)", key: "actual_cost", width: 13, style: { numFmt: money } },
      { header: `折后金额($)×${p.discount}`, key: "final", width: 16, style: { numFmt: money } },
      { header: "流式", key: "stream", width: 6 }, { header: "耗时(ms)", key: "duration_ms", width: 10 }, { header: "请求ID", key: "request_id", width: 40 },
    ];
    head(s4);
    // 逐个用户按 (created_at, id) 游标分页，走 (user_id, created_at) 索引；按 id 分页会沿主键扫全表，大表下极慢
    // 游标时间用文本传回，避免 JS Date 丢掉微秒导致漏行/重行
    for (const userId of p.userIds) {
      let lastAt = p.start, lastId = 0;
      for (;;) {
        const { rows } = await pool.query(
          `SELECT u.id, u.created_at::text AS cursor_at, to_char(u.created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD HH24:MI:SS') AS t, u.user_id, us.email, k.name AS key_name, g.name AS group_name, u.model,
                  u.input_tokens, u.output_tokens, u.cache_creation_tokens, u.cache_read_tokens, u.total_cost::float, u.rate_multiplier::float, u.actual_cost::float,
                  u.stream, u.duration_ms, u.request_id
             FROM usage_logs u LEFT JOIN users us ON us.id = u.user_id LEFT JOIN api_keys k ON k.id = u.api_key_id LEFT JOIN groups g ON g.id = u.group_id
            WHERE u.user_id = $1 AND u.created_at >= $2 AND u.created_at < $3 AND (u.created_at, u.id) > ($4::timestamptz, $5)
            ORDER BY u.user_id, u.created_at, u.id LIMIT 5000`,
          [userId, p.start, p.end, lastAt, lastId]
        );
        if (!rows.length) break;
        for (const r of rows) s4.addRow({ ...r, final: (r.actual_cost || 0) * p.discount, stream: r.stream ? "是" : "否" }).commit();
        ({ cursor_at: lastAt, id: lastId } = rows[rows.length - 1]);
      }
    }
    s4.commit();
    await wb.commit();
  } catch (e) {
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
    else res.destroy(e);
  }
});

registerMonitor({ app, wrap, pool, getAccounts, httpError, ERROR_CLASS_SQL });
registerSuppliers({ app, wrap, httpError, dataDir: DATA_DIR, jobs: !READONLY });
registerTraffic({ app, wrap, httpError, dataDir: DATA_DIR, readonly: READONLY, mainKey: S2_KEY });

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () =>
  console.log(`运维中台后端 listening on :${PORT}${READONLY ? "（只读模式：不写线上 sub2api，调度只观察）" : ""}`),
);
