// 流量监控（移植自 bill-manage 的 /scheduling）：可配置多台 sub2api 服务器（URL + Admin Key），
// 看实时 RPM / TPM、渠道调度（按分组看渠道并发与今日消费，可改渠道）、分组使用、错误排行。
// 所有对 sub2api 的请求都在后端发出，Admin Key 不下发前端；改渠道 / 测试渠道受只读保护（READONLY）。
// 存储：DATA_DIR/ops.db 的 traffic_sites 表。
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const TZ = "Asia/Shanghai";
const TIMEOUT_MS = 30_000;
const ERROR_RANGES = new Set(["1h", "6h", "24h", "7d", "30d"]);
const ERR_PAGE_SIZE = 500;
const ERR_MAX_PAGES = 100;
const ERR_PAGE_CONCURRENCY = 8;
const RECENT_PER_ACCOUNT = 200;
// 这几个 POST 只是查询，只读模式下放行
const READ_ONLY_POSTS = new Set(["/admin/accounts/today-stats/batch"]);

const nowIso = () => new Date().toISOString();
const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);
const todayShanghai = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
// 用户可能填 https://x.com、https://x.com/ 或 https://x.com/api/v1，统一成站点根地址
const normBase = (u) => str(u, 300).replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
const masked = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : "");
const ids = (v, max = 1000) =>
  [...new Set((Array.isArray(v) ? v : String(v ?? "").split(",")).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, max);

// 固定并发跑一批异步任务
async function runWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// 账号：去掉 credentials / extra（含上游 Key），只留调度页用得到的字段
function accountView(a) {
  return {
    id: a.id,
    name: a.name,
    platform: a.platform,
    type: a.type,
    status: a.status,
    schedulable: a.schedulable !== false,
    priority: a.priority ?? 0,
    concurrency: a.concurrency ?? 0,
    rate_multiplier: a.rate_multiplier,
    group_ids: a.group_ids ?? (a.groups ?? []).map((g) => g.id),
    error_message: a.error_message || null,
    notes: a.notes || null,
    last_used_at: a.last_used_at || null,
  };
}

export function registerTraffic({ app, wrap, httpError, dataDir, readonly }) {
  const db = new DatabaseSync(path.join(dataDir, "ops.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS traffic_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const q = {
    all: db.prepare("SELECT * FROM traffic_sites ORDER BY is_default DESC, id"),
    one: db.prepare("SELECT * FROM traffic_sites WHERE id = ?"),
  };
  const siteView = (s) => ({ id: s.id, name: s.name, base_url: s.base_url, key_masked: masked(s.api_key), is_default: !!s.is_default });
  const mustSite = (id) => {
    const s = q.one.get(Number(id));
    if (!s) throw httpError(404, "监控服务器不存在");
    return s;
  };

  // ---------- sub2api 管理 API ----------
  async function call(site, method, p, body) {
    if (readonly && method !== "GET" && !READ_ONLY_POSTS.has(p)) throw httpError(403, `只读模式：已拦截对 sub2api 的写操作（${method} ${p.split("?")[0]}）`);
    let res;
    try {
      res = await fetch(`${site.base_url}/api/v1${p}`, {
        method,
        headers: { "x-api-key": site.api_key, "content-type": "application/json", accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw httpError(502, `连不上 ${site.name}：${e?.name === "TimeoutError" ? "超时" : e?.message || e}`);
    }
    if (res.status === 401 || res.status === 403) throw httpError(502, `${site.name} 的 Admin Key 无效（HTTP ${res.status}）`);
    let j;
    try {
      j = await res.json();
    } catch {
      throw httpError(502, `${site.name} 返回非 JSON（HTTP ${res.status}）`);
    }
    if (!res.ok || j.code !== 0) throw httpError(res.status >= 400 && res.status < 500 ? 400 : 502, j.message || `${site.name} 错误 HTTP ${res.status}`);
    return j.data;
  }

  // 同一台服务器的同类数据短时间内复用（多人同时看、或前端轮询时不重复打 sub2api）
  const cache = new Map();
  async function cached(key, ttlMs, fn) {
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.val;
    if (hit?.pending) return hit.pending;
    const pending = fn();
    cache.set(key, { ...hit, pending });
    try {
      const val = await pending;
      cache.set(key, { val, exp: Date.now() + ttlMs });
      return val;
    } catch (e) {
      cache.delete(key);
      throw e;
    }
  }
  const bust = (siteId) => [...cache.keys()].filter((k) => k.startsWith(`${siteId}:`)).forEach((k) => cache.delete(k));

  const groupsOf = (site) => cached(`${site.id}:groups`, 30_000, () => call(site, "GET", "/admin/groups/all"));
  const accountsOf = (site) =>
    cached(`${site.id}:accounts`, 10_000, async () => {
      const d = await call(site, "GET", `/admin/accounts?page=1&page_size=1000&timezone=${encodeURIComponent(TZ)}`);
      return (d.items ?? []).map(accountView);
    });

  // ---------- 监控服务器设置 ----------
  app.get(
    "/api/traffic/sites",
    wrap(async () => q.all.all().map(siteView)),
  );
  function siteInput(b, partial) {
    const out = {};
    if (!partial || "name" in b) {
      out.name = str(b.name, 60);
      if (!out.name) throw httpError(400, "名称必填");
    }
    if (!partial || "base_url" in b) {
      out.base_url = normBase(b.base_url);
      if (!/^https?:\/\/[^/]+/i.test(out.base_url)) throw httpError(400, "URL 需以 http:// 或 https:// 开头");
    }
    // Admin Key：新建必填；编辑时留空 = 保持原值
    const key = str(b.api_key, 300);
    if (key) out.api_key = key;
    else if (!partial) throw httpError(400, "Admin Key 必填");
    return out;
  }
  app.post(
    "/api/traffic/sites",
    wrap(async (req) => {
      const v = siteInput(req.body || {}, false);
      const t = nowIso();
      const first = !q.all.all().length;
      const r = db
        .prepare("INSERT INTO traffic_sites (name, base_url, api_key, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(v.name, v.base_url, v.api_key, first ? 1 : 0, t, t);
      return siteView(q.one.get(r.lastInsertRowid));
    }),
  );
  app.patch(
    "/api/traffic/sites/:id",
    wrap(async (req) => {
      const s = mustSite(req.params.id);
      const v = siteInput(req.body || {}, true);
      const keys = Object.keys(v);
      if (keys.length) db.prepare(`UPDATE traffic_sites SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => v[k]), nowIso(), s.id);
      bust(s.id);
      return siteView(q.one.get(s.id));
    }),
  );
  app.delete(
    "/api/traffic/sites/:id",
    wrap(async (req) => {
      const s = mustSite(req.params.id);
      db.prepare("DELETE FROM traffic_sites WHERE id = ?").run(s.id);
      // 删掉的是默认服务器：把剩下的第一台设为默认
      if (s.is_default) db.prepare("UPDATE traffic_sites SET is_default = 1 WHERE id = (SELECT min(id) FROM traffic_sites)").run();
      bust(s.id);
      return { ok: true };
    }),
  );
  app.put(
    "/api/traffic/sites/:id/default",
    wrap(async (req) => {
      const s = mustSite(req.params.id);
      db.exec("UPDATE traffic_sites SET is_default = 0");
      db.prepare("UPDATE traffic_sites SET is_default = 1 WHERE id = ?").run(s.id);
      return q.all.all().map(siteView);
    }),
  );
  // 测试连接：只读一次 dashboard/stats
  app.post(
    "/api/traffic/sites/:id/check",
    wrap(async (req) => {
      const s = mustSite(req.params.id);
      const t0 = Date.now();
      const d = await call(s, "GET", "/admin/dashboard/stats");
      return { ok: true, latency_ms: Date.now() - t0, rpm: d?.rpm ?? 0, tpm: d?.tpm ?? 0 };
    }),
  );

  // ---------- 读：某台服务器的数据 /api/traffic/:siteId/... ----------
  const site = (req) => mustSite(req.params.siteId);

  // 结构：分组 + 账号（渠道）
  app.get(
    "/api/traffic/:siteId/structure",
    wrap(async (req) => {
      const s = site(req);
      const [groups, accounts] = await Promise.all([groupsOf(s), accountsOf(s)]);
      return {
        groups: groups.map((g) => ({ id: g.id, name: g.name, platform: g.platform, status: g.status, rate_multiplier: g.rate_multiplier })),
        accounts,
      };
    }),
  );

  // 实时：RPM / TPM + 各渠道并发，一次请求拿全（前端每 2 秒拉一次）
  app.get(
    "/api/traffic/:siteId/realtime",
    wrap(async (req) => {
      const s = site(req);
      return cached(`${s.id}:realtime`, 1500, async () => {
        const [stats, conc] = await Promise.all([
          call(s, "GET", "/admin/dashboard/stats").catch(() => null),
          call(s, "GET", "/admin/ops/concurrency").catch(() => null),
        ]);
        if (!stats && !conc) await call(s, "GET", "/admin/dashboard/stats"); // 全失败：抛出真实原因
        const account = {};
        for (const [k, v] of Object.entries(conc?.account ?? {}))
          account[k] = { current_in_use: v.current_in_use ?? 0, max_capacity: v.max_capacity ?? 0, waiting_in_queue: v.waiting_in_queue ?? 0 };
        return {
          rpm: stats?.rpm ?? null,
          tpm: stats?.tpm ?? null,
          account,
          at: nowIso(),
        };
      });
    }),
  );

  // 各渠道今日统计（请求数 / 费用）
  app.get(
    "/api/traffic/:siteId/today-stats",
    wrap(async (req) => {
      const s = site(req);
      return cached(`${s.id}:today-stats`, 30_000, async () => {
        const accountIds = (await accountsOf(s)).map((a) => a.id);
        if (!accountIds.length) return {};
        const d = await call(s, "POST", "/admin/accounts/today-stats/batch", { account_ids: accountIds });
        return d?.stats ?? {};
      });
    }),
  );
  // 分组今日用量（按分组逐个查，10 并发）
  app.get(
    "/api/traffic/:siteId/group-usage",
    wrap(async (req) => {
      const s = site(req);
      return cached(`${s.id}:group-usage`, 60_000, async () => {
        const today = todayShanghai();
        const groups = await groupsOf(s);
        const rows = await runWithLimit(groups, 10, async (g) => {
          const st = await call(s, "GET", `/admin/usage/stats?${new URLSearchParams({ group_id: g.id, start_date: today, end_date: today, timezone: TZ })}`).catch(() => null);
          return [g.id, { cost: st?.total_cost ?? 0, actual_cost: st?.total_actual_cost ?? 0, requests: st?.total_requests ?? 0 }];
        });
        return { today, by_group: Object.fromEntries(rows) };
      });
    }),
  );

  // 分组使用：每个分组今天的用户消费明细
  app.get(
    "/api/traffic/:siteId/group-users",
    wrap(async (req) => {
      const s = site(req);
      return cached(`${s.id}:group-users`, 60_000, async () => {
        const today = todayShanghai();
        const groups = await groupsOf(s);
        const rows = await runWithLimit(groups, 10, async (g) => {
          try {
            const r = await call(
              s,
              "GET",
              `/admin/dashboard/user-breakdown?${new URLSearchParams({ group_id: g.id, start_date: today, end_date: today, timezone: TZ, limit: "200" })}`,
            );
            return {
              group_id: g.id,
              group_name: g.name,
              users: (r?.users ?? []).map((u) => ({ user_id: u.user_id, email: u.email ?? "", requests: u.requests ?? 0, cost: u.cost ?? 0, actual_cost: u.actual_cost ?? 0 })),
            };
          } catch (e) {
            return { group_id: g.id, group_name: g.name, users: [], error: String(e.message).slice(0, 200) };
          }
        });
        return { today, groups: rows };
      });
    }),
  );

  // 错误排行：翻页拉取请求错误，按账号聚合（最多 100 页 × 500 条）
  app.get(
    "/api/traffic/:siteId/error-ranking",
    wrap(async (req) => {
      const s = site(req);
      const range = ERROR_RANGES.has(req.query.range) ? req.query.range : "1h";
      return cached(`${s.id}:errors:${range}`, 60_000, async () => {
        const list = (page) =>
          call(s, "GET", `/admin/ops/request-errors?${new URLSearchParams({ page, page_size: ERR_PAGE_SIZE, time_range: range, view: "errors", timezone: TZ })}`);
        const snapshot = call(s, "GET", `/admin/ops/dashboard/snapshot-v2?${new URLSearchParams({ mode: "auto", time_range: range, timezone: TZ })}`).catch(() => null);
        const first = await list(1);
        const pages = first.pages ?? 1;
        const rest = await runWithLimit(
          Array.from({ length: Math.min(pages, ERR_MAX_PAGES) - 1 }, (_, i) => i + 2),
          ERR_PAGE_CONCURRENCY,
          (p) => list(p).then((r) => r.items ?? [], () => []),
        );
        const items = [...(first.items ?? []), ...rest.flat()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        const total = first.total ?? items.length;

        const accs = new Map();
        for (const e of items) {
          if (!e.account_id) continue;
          let a = accs.get(e.account_id);
          if (!a) {
            a = {
              account_id: e.account_id,
              account_name: e.account_name || `账号 #${e.account_id}`,
              count: 0,
              by_status: {},
              by_model: {},
              groups: {},
              latest_at: e.created_at,
              latest_status: e.status_code || 0,
              latest_message: String(e.message || "").slice(0, 300),
              recent: [],
            };
            accs.set(e.account_id, a);
          }
          a.count++;
          const sc = String(e.status_code || 0);
          a.by_status[sc] = (a.by_status[sc] ?? 0) + 1;
          const model = e.model || e.requested_model || "(未知)";
          a.by_model[model] = (a.by_model[model] ?? 0) + 1;
          if (e.group_id) (a.groups[e.group_id] ||= { group_id: e.group_id, group_name: e.group_name || `分组 #${e.group_id}`, count: 0 }).count++;
          if (a.recent.length < RECENT_PER_ACCOUNT)
            a.recent.push({
              id: e.id,
              created_at: e.created_at,
              status_code: e.status_code || 0,
              model: e.model || "",
              requested_model: e.requested_model || "",
              message: String(e.message || "").slice(0, 600),
              group_name: e.group_name || "",
              user_email: e.user_email || "",
              request_id: e.request_id || "",
            });
        }
        const snap = await snapshot;
        const o = snap?.overview;
        return {
          range,
          total,
          processed: items.length,
          truncated: pages > ERR_MAX_PAGES,
          summary: o
            ? {
                error_rate: o.error_rate ?? 0,
                upstream_error_rate: o.upstream_error_rate ?? 0,
                sla: o.sla ?? 0,
                request_count: o.request_count_total ?? 0,
                success_count: o.success_count ?? 0,
                error_count: o.error_count_total ?? 0,
                upstream_429: o.upstream_429_count ?? 0,
                upstream_529: o.upstream_529_count ?? 0,
                upstream_other: o.upstream_error_count_excl_429_529 ?? 0,
                health_score: o.health_score ?? null,
                generated_at: snap.generated_at ?? null,
              }
            : null,
          accounts: [...accs.values()]
            .sort((x, y) => y.count - x.count)
            .map((a) => ({ ...a, share: total ? a.count / total : 0, groups: Object.values(a.groups).sort((x, y) => y.count - x.count) })),
        };
      });
    }),
  );

  // ---------- 写：渠道（受只读保护） ----------
  const afterWrite = (s) => {
    cache.delete(`${s.id}:accounts`);
    cache.delete(`${s.id}:today-stats`);
  };
  app.post(
    "/api/traffic/:siteId/channels",
    wrap(async (req) => {
      const s = site(req);
      const b = req.body || {};
      const name = str(b.name, 100);
      const baseUrl = str(b.base_url, 300);
      const apiKey = str(b.api_key, 500);
      if (!name || !baseUrl || !apiKey) throw httpError(400, "名称 / Base URL / API Key 必填");
      const models = (Array.isArray(b.models) ? b.models : []).map((m) => str(m, 100)).filter(Boolean);
      const r = await call(s, "POST", "/admin/accounts", {
        name,
        platform: str(b.platform, 30) || "anthropic",
        type: "apikey",
        credentials: { base_url: baseUrl, api_key: apiKey, ...(models.length ? { model_mapping: Object.fromEntries(models.map((m) => [m, m])) } : {}) },
        concurrency: Math.max(0, parseInt(b.concurrency) || 0),
        priority: Math.max(0, parseInt(b.priority) || 0),
        rate_multiplier: Number(b.rate_multiplier) || 1,
        group_ids: ids(b.group_ids),
        confirm_mixed_channel_risk: true,
      });
      afterWrite(s);
      return { id: r?.id, name: r?.name };
    }),
  );
  app.put(
    "/api/traffic/:siteId/channels/:id",
    wrap(async (req) => {
      const s = site(req);
      const b = req.body || {};
      const body = {};
      if ("status" in b) body.status = b.status === "active" ? "active" : "inactive";
      if ("concurrency" in b) body.concurrency = Math.max(0, parseInt(b.concurrency) || 0);
      if ("priority" in b) body.priority = Math.max(0, parseInt(b.priority) || 0);
      if ("group_ids" in b) body.group_ids = ids(b.group_ids);
      if ("notes" in b) body.notes = str(b.notes, 1000) || null;
      if ("group_ids" in body) body.confirm_mixed_channel_risk = true;
      await call(s, "PUT", `/admin/accounts/${parseInt(req.params.id)}`, body);
      afterWrite(s);
      return { ok: true };
    }),
  );
  app.get(
    "/api/traffic/:siteId/channels/:id/models",
    wrap(async (req) => {
      const items = await call(site(req), "GET", `/admin/accounts/${parseInt(req.params.id)}/models`);
      return (items ?? []).map((m) => m.id);
    }),
  );
  // 模型白名单存在 credentials.model_mapping：先读回完整 credentials 再改，避免覆盖 base_url / api_key
  app.put(
    "/api/traffic/:siteId/channels/:id/models",
    wrap(async (req) => {
      const s = site(req);
      const id = parseInt(req.params.id);
      const models = (Array.isArray(req.body?.models) ? req.body.models : []).map((m) => str(m, 100)).filter(Boolean);
      if (readonly) throw httpError(403, "只读模式：已拦截对 sub2api 的写操作（修改模型白名单）");
      const acc = await call(s, "GET", `/admin/accounts/${id}`);
      const creds = { ...(acc?.credentials ?? {}) };
      if (models.length) creds.model_mapping = Object.fromEntries(models.map((m) => [m, m]));
      else delete creds.model_mapping;
      await call(s, "PUT", `/admin/accounts/${id}`, { credentials: creds });
      return { ok: true };
    }),
  );
  app.post(
    "/api/traffic/:siteId/channels/:id/schedulable",
    wrap(async (req) => {
      const s = site(req);
      if (typeof req.body?.schedulable !== "boolean") throw httpError(400, "schedulable 必须是 true / false");
      await call(s, "POST", `/admin/accounts/${parseInt(req.params.id)}/schedulable`, { schedulable: req.body.schedulable });
      afterWrite(s);
      return { ok: true };
    }),
  );
  app.post(
    "/api/traffic/:siteId/channels/clear-error",
    wrap(async (req) => {
      const s = site(req);
      const accountIds = ids(req.body?.account_ids);
      if (!accountIds.length) throw httpError(400, "account_ids 必填");
      await call(s, "POST", "/admin/accounts/batch-clear-error", { account_ids: accountIds });
      afterWrite(s);
      return { ok: true };
    }),
  );
  app.post(
    "/api/traffic/:siteId/channels/bulk-update",
    wrap(async (req) => {
      const s = site(req);
      const accountIds = ids(req.body?.account_ids);
      if (!accountIds.length) throw httpError(400, "account_ids 必填");
      // 可改：status（active / inactive）、schedulable（是否参与调度），至少一项
      const body = { account_ids: accountIds };
      if (req.body?.status === "active" || req.body?.status === "inactive") body.status = req.body.status;
      if (typeof req.body?.schedulable === "boolean") body.schedulable = req.body.schedulable;
      if (Object.keys(body).length === 1) throw httpError(400, "需要 status（active / inactive）或 schedulable（true / false）");
      await call(s, "POST", "/admin/accounts/bulk-update", body);
      afterWrite(s);
      return { ok: true };
    }),
  );
  // 测试渠道：会真实请求上游（产生费用），只读模式下拦截。返回 SSE 文本，粗判成功 / 失败
  app.post(
    "/api/traffic/:siteId/channels/:id/test",
    wrap(async (req) => {
      const s = site(req);
      if (readonly) throw httpError(403, "只读模式：测试渠道会真实请求上游并产生费用，已拦截");
      const t0 = Date.now();
      const model = str(req.body?.model, 100);
      let res;
      try {
        res = await fetch(`${s.base_url}/api/v1/admin/accounts/${parseInt(req.params.id)}/test`, {
          method: "POST",
          headers: { "x-api-key": s.api_key, "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify(model ? { model_id: model } : {}),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        return { ok: false, latency_ms: Date.now() - t0, output: e?.name === "TimeoutError" ? "超时（>60s）" : String(e?.message || e) };
      }
      const text = await res.text();
      const failed = !res.ok || /\bevent:\s*error\b/i.test(text) || /"error"\s*:/.test(text) || /"code"\s*:\s*[1-9]/.test(text);
      return { ok: !failed, latency_ms: Date.now() - t0, output: (failed ? text.slice(0, 800) : text.slice(-300)).trim() };
    }),
  );
}
