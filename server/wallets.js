// 供应商余额：用我们在供应商站点（new-api / sub2api）的 API Key 抓「钱包额度」和「这把 Key 的倍率」。
// - 普通模式：倍率从供应商接口抓取，实际余额 = 钱包额度
// - 自定义倍率：有的供应商倍率永远显示 1、充值时按倍率折算额度（充 9000、3 倍率 → 给 3000 额度），
//   这时倍率由我们手填、不抓取，实际余额 = 钱包额度 × 自定义倍率
// 只对供应商站点发 GET 请求，与 sub2api（我们自己的）无关。
const TIMEOUT_MS = 15_000;
const LOOP_MS = 30 * 60_000;
export const PLATFORMS = ["newapi", "sub2api"];

const nowIso = () => new Date().toISOString();
const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (n, d = 6) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

export function migrateWallets(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS supplier_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '默认',
      platform TEXT NOT NULL DEFAULT 'newapi',   -- newapi / sub2api
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      custom INTEGER NOT NULL DEFAULT 0,         -- 1 = 自定义倍率（不抓倍率，实际余额 = 钱包 × 倍率）
      custom_ratio REAL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_wallet REAL,                          -- 供应商站点上的钱包额度（站点显示单位，一般是 $）
      last_wallet_kind TEXT NOT NULL DEFAULT '', -- wallet 钱包 / token 令牌剩余 / quota Key 限额剩余 / subscription 订阅剩余
      last_ratio REAL,
      last_ratio_source TEXT NOT NULL DEFAULT '',
      last_actual REAL,
      last_error TEXT NOT NULL DEFAULT '',
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_supplier ON supplier_wallets(supplier_id);
  `);
}

// ---------- 抓取 ----------
const baseOf = (u) => String(u || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
const redact = (text, key) => (key && key.length >= 8 ? String(text).split(key).join("<api-key>") : String(text)).slice(0, 200);

async function getJson(url, key) {
  const headers = { Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const aborted = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { ok: false, status: 0, error: aborted ? "请求超时" : redact(e?.cause?.message || e?.message || e, key) };
  }
  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  if (!res.ok || !json) {
    const err = json?.error;
    const msg = typeof err === "string" ? err : err?.message || json?.message || (json ? "" : "返回的不是 JSON（地址或平台选错了？）");
    return { ok: false, status: res.status, json, error: redact(`HTTP ${res.status}${msg ? `：${msg}` : ""}`, key) };
  }
  return { ok: true, status: res.status, json };
}

// sub2api：/v1/usage 拿钱包（balance），/v1/sub2api/billing 拿倍率；老版本没有 billing 接口时用 实际扣费 / 标准费用 反推
async function fetchSub2api(base, key, wantRatio) {
  const u = await getJson(`${base}/v1/usage`, key);
  if (!u.ok) throw new Error(`读取余额失败：${u.status === 401 ? "Key 无效或已禁用" : u.error}`);
  const d = u.json;
  let wallet = null;
  let kind = "";
  if (num(d.balance) !== null) {
    wallet = num(d.balance);
    kind = "wallet";
  } else if (d.subscription) {
    wallet = num(d.remaining) === -1 ? null : num(d.remaining);
    kind = "subscription";
  } else if (d.mode === "quota_limited") {
    wallet = num(d.remaining) ?? num(d.quota?.remaining);
    kind = "quota";
  } else {
    wallet = num(d.remaining);
    kind = "wallet";
  }
  if (!wantRatio) return { wallet, kind };

  let ratio = null;
  let source = "";
  const b = await getJson(`${base}/v1/sub2api/billing`, key);
  if (b.ok && num(b.json.resolved_rate_multiplier) !== null) {
    ratio = num(b.json.resolved_rate_multiplier);
    source = "billing";
  } else {
    const t = d.usage?.total;
    if (t && num(t.cost) > 0 && num(t.actual_cost) !== null) {
      ratio = round(num(t.actual_cost) / num(t.cost), 4);
      source = "usage";
    } else source = b.status === 403 ? "Key 没有分组，读不到倍率" : "读不到倍率（这把 Key 还没有消费记录）";
  }
  return { wallet, kind, ratio, source };
}

// new-api：
// - 余额：令牌有额度上限 → 令牌剩余额度（/api/usage/token）；令牌无限额度 → 用户钱包（/v1/dashboard/billing/subscription − usage，
//   站点开着「按令牌统计」时这里拿不到钱包，只能提示）
// - 倍率：最近一条消费日志里的分组倍率（/api/log/token），没有消费记录时退回 /api/pricing 的 default 分组倍率
async function fetchNewapi(base, key, wantRatio) {
  const st = await getJson(`${base}/api/status`);
  const s = st.ok ? st.json.data || {} : {};
  const qpu = num(s.quota_per_unit) || 500000;
  const display = s.quota_display_type || (s.display_in_currency === false ? "TOKENS" : "USD");
  const usdRate = num(s.usd_exchange_rate) || 1;

  let wallet = null;
  let kind = "";
  const tok = await getJson(`${base}/api/usage/token/`, key);
  const td = tok.ok ? tok.json.data : null;
  if (tok.ok && tok.json.code === false) throw new Error(`读取余额失败：${tok.json.message || "Key 无效"}`);
  if (td && !td.unlimited_quota && num(td.total_available) !== null) {
    wallet = num(td.total_available) / qpu;
    kind = "token";
  } else {
    const [sub, use] = await Promise.all([
      getJson(`${base}/v1/dashboard/billing/subscription`, key),
      getJson(`${base}/v1/dashboard/billing/usage`, key),
    ]);
    if (!sub.ok) throw new Error(`读取余额失败：${sub.status === 401 ? "Key 无效、已过期或额度用尽" : sub.error}`);
    if (sub.json.error) throw new Error(`读取余额失败：${sub.json.error.message || "未知错误"}`);
    const hard = num(sub.json.hard_limit_usd);
    if (hard === null) throw new Error("读取余额失败：返回里没有 hard_limit_usd");
    if (hard >= 1e8 - 1)
      throw new Error("这把 Key 是无限额度，而供应商站点按「令牌」统计额度，读不到钱包余额。请在供应商站点给这把 Key 设一个额度上限（如钱包全部额度），或换成有额度上限的 Key");
    let remaining = hard - (num(use.ok ? use.json.total_usage : 0) || 0) / 100;
    if (display === "CNY") remaining /= usdRate;
    else if (display === "TOKENS") remaining /= qpu;
    wallet = remaining;
    kind = "wallet";
  }
  if (!wantRatio) return { wallet, kind };

  let ratio = null;
  let source = "";
  const logs = await getJson(`${base}/api/log/token`, key);
  const list = logs.ok && Array.isArray(logs.json.data) ? logs.json.data : Array.isArray(logs.json?.data?.items) ? logs.json.data.items : [];
  for (const l of [...list].sort((a, b) => (b.created_at || 0) - (a.created_at || 0))) {
    let o = l.other;
    if (typeof o === "string") {
      try {
        o = JSON.parse(o);
      } catch {
        o = null;
      }
    }
    const g = num(o?.group_ratio);
    if (g === null) continue;
    const ug = num(o?.user_group_ratio);
    ratio = ug !== null && ug >= 0 ? ug : g;
    source = `log${l.group ? `:${l.group}` : ""}`;
    break;
  }
  if (ratio === null) {
    const p = await getJson(`${base}/api/pricing`);
    const gr = p.ok ? p.json.group_ratio : null;
    if (gr && num(gr.default) !== null) {
      ratio = num(gr.default);
      source = "pricing-default";
    } else source = "读不到倍率（这把 Key 还没有消费记录，且站点没公开分组倍率）";
  }
  return { wallet, kind, ratio, source };
}

export async function fetchWallet(w) {
  const base = baseOf(w.base_url);
  const wantRatio = !w.custom;
  const r = w.platform === "sub2api" ? await fetchSub2api(base, w.api_key, wantRatio) : await fetchNewapi(base, w.api_key, wantRatio);
  const ratio = w.custom ? num(w.custom_ratio) : r.ratio ?? null;
  const wallet = r.wallet === null ? null : round(r.wallet, 4);
  // 自定义倍率：实际余额 = 钱包 × 倍率；普通模式：实际余额 = 钱包
  const actual = wallet === null ? null : w.custom ? (ratio === null ? null : round(wallet * ratio, 4)) : wallet;
  return { wallet, kind: r.kind, ratio, source: w.custom ? "custom" : r.source || "", actual };
}

// ---------- 路由 ----------
export function registerSupplierWallets({ app, wrap, httpError, db, jobs, mustSupplier }) {
  migrateWallets(db);
  const getOne = db.prepare("SELECT * FROM supplier_wallets WHERE id = ?");

  // Key 不回传，只给脱敏后的前后几位
  const view = (w) => {
    const { api_key, ...rest } = w;
    return {
      ...rest,
      custom: !!w.custom,
      enabled: !!w.enabled,
      has_key: !!api_key,
      key_masked: api_key ? `${api_key.slice(0, 5)}…${api_key.slice(-4)}` : "",
    };
  };

  function input(b, partial) {
    const out = {};
    if (!partial || "name" in b) out.name = str(b.name, 60) || "默认";
    if (!partial || "platform" in b) {
      if (!PLATFORMS.includes(b.platform)) throw httpError(400, "平台只能是 new-api 或 sub2api");
      out.platform = b.platform;
    }
    if (!partial || "base_url" in b) {
      out.base_url = str(b.base_url, 300).replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(out.base_url)) throw httpError(400, "站点地址需以 http:// 或 https:// 开头");
    }
    if (!partial || "custom" in b) out.custom = b.custom ? 1 : 0;
    if (!partial || "custom_ratio" in b) out.custom_ratio = num(b.custom_ratio);
    if (!partial || "enabled" in b) out.enabled = b.enabled === false ? 0 : 1;
    // Key：只有填了才更新（留空 = 保持原值）
    if (str(b.api_key, 500)) out.api_key = str(b.api_key, 500);
    return out;
  }
  const checkCustom = (w) => {
    if (w.custom && !(num(w.custom_ratio) > 0)) throw httpError(400, "自定义倍率必须大于 0");
  };

  async function refresh(id) {
    const w = getOne.get(id);
    if (!w) throw httpError(404, "余额监控项不存在");
    const t = nowIso();
    try {
      if (!w.api_key) throw new Error("还没有填 API Key");
      const r = await fetchWallet(w);
      db.prepare(
        "UPDATE supplier_wallets SET last_wallet = ?, last_wallet_kind = ?, last_ratio = ?, last_ratio_source = ?, last_actual = ?, last_error = '', last_checked_at = ? WHERE id = ?",
      ).run(r.wallet, r.kind, r.ratio, r.source, r.actual, t, id);
    } catch (e) {
      db.prepare("UPDATE supplier_wallets SET last_error = ?, last_checked_at = ? WHERE id = ?").run(redact(e.message, w.api_key), t, id);
    }
    return view(getOne.get(id));
  }

  app.get(
    "/api/supplier-wallets",
    wrap(async (req) => {
      const sid = parseInt(req.query.supplier_id);
      const rows = db
        .prepare(
          `SELECT w.*, s.name AS supplier_name FROM supplier_wallets w JOIN suppliers s ON s.id = w.supplier_id
             WHERE s.deleted_at IS NULL ${sid ? "AND w.supplier_id = ?" : ""} ORDER BY s.name, w.id`,
        )
        .all(...(sid ? [sid] : []));
      return rows.map(view);
    }),
  );

  app.post(
    "/api/supplier-wallets",
    wrap(async (req) => {
      const b = req.body || {};
      const s = mustSupplier(b.supplier_id);
      const v = input({ ...b, base_url: b.base_url || s.base_url }, false);
      if (!v.api_key) throw httpError(400, "API Key 必填");
      checkCustom(v);
      const t = nowIso();
      const r = db
        .prepare(
          "INSERT INTO supplier_wallets (supplier_id, name, platform, base_url, api_key, custom, custom_ratio, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(s.id, v.name, v.platform, v.base_url, v.api_key, v.custom, v.custom_ratio, v.enabled, t, t);
      return refresh(Number(r.lastInsertRowid)); // 加完立即抓一次
    }),
  );

  app.patch(
    "/api/supplier-wallets/:id",
    wrap(async (req) => {
      const w = getOne.get(Number(req.params.id));
      if (!w) throw httpError(404, "余额监控项不存在");
      const v = input(req.body || {}, true);
      checkCustom({ ...w, ...v });
      const keys = Object.keys(v);
      if (keys.length)
        db.prepare(`UPDATE supplier_wallets SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
          ...keys.map((k) => v[k]),
          nowIso(),
          w.id,
        );
      return refresh(w.id); // 改了平台 / Key / 倍率后按新参数重抓
    }),
  );

  app.delete(
    "/api/supplier-wallets/:id",
    wrap(async (req) => {
      db.prepare("DELETE FROM supplier_wallets WHERE id = ?").run(Number(req.params.id));
      return { ok: true };
    }),
  );

  const enabledIds = (sid) =>
    db
      .prepare(
        `SELECT w.id FROM supplier_wallets w JOIN suppliers s ON s.id = w.supplier_id
           WHERE w.enabled = 1 AND s.deleted_at IS NULL ${sid ? "AND w.supplier_id = ?" : ""} ORDER BY w.id`,
      )
      .all(...(sid ? [sid] : []))
      .map((r) => r.id);

  app.post("/api/supplier-wallets/:id/refresh", wrap(async (req) => refresh(Number(req.params.id))));
  // 批量刷新：body { supplier_id? }，不带 = 全部
  app.post(
    "/api/supplier-wallets/refresh",
    wrap(async (req) => {
      const out = [];
      for (const id of enabledIds(parseInt(req.body?.supplier_id))) out.push(await refresh(id));
      return out;
    }),
  );

  // 定时刷新：每 30 分钟串行抓一遍（只读 / 本地模式不跑，可手动刷新）
  if (jobs) {
    const loop = async () => {
      for (const id of enabledIds()) await refresh(id).catch((e) => console.error("[supplier-wallet]", e.message));
      setTimeout(loop, LOOP_MS);
    };
    setTimeout(loop, 30_000);
  }

  // 供应商列表用：每家的余额汇总
  return {
    summaryBySupplier() {
      const rows = db
        .prepare(
          "SELECT supplier_id, count(*) AS n, sum(last_actual) AS actual, sum(CASE WHEN last_error != '' THEN 1 ELSE 0 END) AS errors FROM supplier_wallets WHERE enabled = 1 GROUP BY supplier_id",
        )
        .all();
      return Object.fromEntries(rows.map((r) => [r.supplier_id, { count: r.n, actual: r.actual, errors: r.errors }]));
    },
  };
}
