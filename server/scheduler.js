// 智能调度引擎：只监测、只调整「在分组里被手动关联」的账号，没关联的一律不碰。
//
// 快循环（30s）：熔断 → 探测恢复 → 观察期 → 负载系数保护 → 存活检查/报警
// 慢循环（5min）：按「分组 × 模型」打分 → 优先级 1-10 → 模型路由（分组开启时）
//
// 保缓存原则：sub2api 的粘性会话不看优先级，所以调优先级 / 改路由只影响新会话；
// 只有熔断会停调度（必然断缓存，因为号已经坏了）。
import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG = {
  minAlive: 2, // 每个分组至少存活的关联账号数
  breaker: {
    windowSec: 60,
    deadCount: 2, // 窗口内账号死亡类错误（401/403/额度不足…）次数
    consecFail: 5, // 自上次成功后的连续上游失败次数
    errRate: 0.3, // 窗口内错误率
    minReq: 10, // 错误率判定的最少请求数
  },
  probeIntervalSec: 30,
  probeModel: "claude-opus-5", // 分组没自定义探测模型时的默认值
  probationMin: 5, // 探测通过后以优先级 10 观察的时长
  scoreIntervalMin: 5,
  scoreWindowMin: 30,
  minSamples: 20, // 分组×模型×账号 的最少样本数，不足不评分
  weights: { ttft: 0.4, cache: 0.3, err: 0.3 },
  maxStep: 3, // 单次优先级最多变化
  changeCooldownMin: 10, // 同一账号两次调优先级的最小间隔
  headroom: 0.85, // 并发占用超过此比例时，用负载系数挡住新会话，给粘性会话留位置
  routingTopK: 2, // 每个模型的候选账号数
  routingExpandLoad: 0.7, // 候选账号平均负载超过此值时再加一个
};

// ops_error_logs 的错误归类：只有 dead / fail / r429 算账号的锅
export const ERROR_CLASS_SQL = `CASE
  WHEN e.error_owner = 'client' OR e.error_phase IN ('request', 'auth') OR e.status_code = 499 THEN 'client'
  WHEN coalesce(e.upstream_error_message, e.error_message) ~* '(model_not_found|no available channel for model|model .{0,40}not (found|supported)|不支持该模型|无可用渠道)' THEN 'client'
  WHEN coalesce(e.upstream_status_code, e.status_code) IN (401, 402, 403, 407)
    OR e.error_message ~* '(额度不足|余额不足|insufficient.{0,20}(balance|quota|credit)|credit balance|account.{0,20}(suspended|disabled|banned|deactivated)|invalid.{0,10}api.?key)' THEN 'dead'
  WHEN coalesce(e.upstream_status_code, e.status_code) = 429 THEN 'r429'
  WHEN coalesce(e.upstream_status_code, e.status_code) IN (400, 404, 405, 413, 415, 422) THEN 'client'
  WHEN coalesce(e.upstream_status_code, e.status_code) >= 500 OR e.upstream_status_code IS NULL THEN 'fail'
  ELSE 'client' END`;

const MODEL_SQL = `coalesce(nullif(btrim(u.requested_model), ''), u.model)`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const now = () => Date.now();

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object" ? deepMerge(base[k], v) : v;
  }
  return out;
}

// observeOnly：只读取指标、计算评分，不做任何调整（不写 sub2api、不改本地状态），本地开发 / 只读模式用
export function createScheduler({ s2, s2raw, pool, dataDir, onAccountsChanged, observeOnly = false }) {
  const STATE_FILE = path.join(dataDir, "scheduler.json");
  const AUDIT_FILE = path.join(dataDir, "scheduler-audit.jsonl");

  let state = { enabled: true, config: DEFAULT_CONFIG, groups: {}, accounts: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    state = { ...state, ...saved, config: deepMerge(DEFAULT_CONFIG, saved.config) };
  } catch {}
  const save = () => {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  };

  // 审计日志：文件追加 + 内存保留最近 2000 条
  let audit = [];
  try {
    audit = fs.readFileSync(AUDIT_FILE, "utf8").trim().split("\n").filter(Boolean).slice(-2000).map((l) => JSON.parse(l));
  } catch {}
  function log(entry) {
    const e = { t: new Date().toISOString(), ...entry };
    audit.push(e);
    if (audit.length > 2000) audit = audit.slice(-2000);
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(e) + "\n");
    if (entry.level === "alert") console.log("[alert]", entry.msg);
  }

  // 运行时数据（不持久化）
  const rt = {
    accounts: [], // sub2api 最新账号列表
    groups: [],
    live: {}, // accountId -> 最近 1 分钟指标
    scores: {}, // accountId -> { score, cells, suggested, ... }
    cells: {}, // `${gid}|${model}` -> [{account_id, n, p50, p90, cache, err, score}]
    alerts: [], // 当前生效的报警
    lastFast: null,
    lastScore: null,
    lastError: null,
  };

  // ---------- 关联关系 ----------
  const groupCfg = (gid) => (state.groups[gid] ||= { accounts: [], auto: false, routing: false, minAlive: null, originalRouting: null });
  const enrolledIds = () => [...new Set(Object.values(state.groups).flatMap((g) => g.accounts))];
  const groupsOfAccount = (aid) => Object.entries(state.groups).filter(([, g]) => g.accounts.includes(aid)).map(([gid]) => +gid);
  // 账号是否允许被自动调整：总开关开 + 它所在的某个已关联分组开了智能调度
  const canAct = (aid) => state.enabled && groupsOfAccount(aid).some((gid) => state.groups[gid]?.auto);
  const acctState = (aid) => (state.accounts[aid] ||= { breaker: "closed" });
  const accById = (aid) => rt.accounts.find((a) => a.id === aid);

  function snapshotOriginal(a) {
    const s = acctState(a.id);
    if (!s.original) s.original = { priority: a.priority, load_factor: a.load_factor ?? null, concurrency: a.concurrency, schedulable: a.schedulable, at: new Date().toISOString() };
  }

  async function bulk(aid, body, reason, meta = {}) {
    await s2("POST", "/admin/accounts/bulk-update", { account_ids: [aid], ...body });
    const a = accById(aid);
    if (a) Object.assign(a, body);
    log({ level: "action", account_id: aid, account_name: a?.name, change: body, msg: reason, ...meta });
    onAccountsChanged?.();
  }

  // ---------- 探测 ----------
  const probeModelFor = (aid) => groupsOfAccount(aid).map((gid) => state.groups[gid]?.probeModel).find(Boolean) || state.config.probeModel || "";
  async function probe(aid) {
    const s = acctState(aid);
    s.lastProbeAt = now();
    const started = now();
    let ok = false, msg = "";
    try {
      const model = probeModelFor(aid);
      const res = await s2raw("POST", `/admin/accounts/${aid}/test`, model ? { model_id: model } : {}, 90000);
      const text = await res.text();
      for (const line of text.split("\n")) {
        const m = line.match(/^data:\s?(.*)$/);
        if (!m) continue;
        try {
          const ev = JSON.parse(m[1]);
          if (ev.type === "test_complete") ok = !!ev.success;
          if (ev.type === "error") msg = ev.error || ev.text || "error";
        } catch {}
      }
      if (!ok && !msg) msg = `测试未返回成功（HTTP ${res.status}）`;
    } catch (e) {
      msg = e.message;
    }
    s.lastProbe = { ok, msg: msg.slice(0, 300), ms: now() - started, model: probeModelFor(aid) || "默认", at: new Date().toISOString() };
    return s.lastProbe;
  }

  // ---------- 指标 ----------
  async function loadLive(ids) {
    const win = state.config.breaker.windowSec;
    const [succ, lastOk, errs] = await Promise.all([
      pool.query(
        `SELECT account_id, count(*)::int n FROM usage_logs WHERE account_id = ANY($1) AND created_at >= now() - make_interval(secs => $2) GROUP BY 1`,
        [ids, win]
      ),
      pool.query(`SELECT account_id, max(created_at) t FROM usage_logs WHERE account_id = ANY($1) AND created_at >= now() - interval '30 minutes' GROUP BY 1`, [ids]),
      pool.query(
        `SELECT e.account_id, e.created_at, ${ERROR_CLASS_SQL} AS cls, left(coalesce(e.upstream_error_message, e.error_message), 200) AS msg,
                coalesce(e.upstream_status_code, e.status_code) AS code
           FROM ops_error_logs e WHERE e.account_id = ANY($1) AND e.created_at >= now() - interval '30 minutes' ORDER BY e.created_at DESC`,
        [ids]
      ),
    ]);
    const live = {};
    for (const id of ids) live[id] = { ok: 0, dead: 0, fail: 0, r429: 0, client: 0, consec: 0, lastOk: null, lastErr: null };
    for (const r of succ.rows) live[r.account_id].ok = r.n;
    for (const r of lastOk.rows) live[r.account_id].lastOk = r.t;
    // 只统计「上次恢复 / 关联」之后的报错，避免刚恢复就被旧报错再次熔断
    for (const r of errs.rows) {
      const l = live[r.account_id];
      const t = new Date(r.created_at).getTime();
      const floor = state.accounts[r.account_id]?.resetAt || 0;
      if (t <= floor) continue;
      if (t >= now() - win * 1000) l[r.cls]++;
      if (r.cls === "client") continue;
      if (!l.lastErr) l.lastErr = { at: r.created_at, code: r.code, msg: r.msg, cls: r.cls };
      if (r.cls !== "r429" && (!l.lastOk || t > new Date(l.lastOk).getTime())) l.consec++;
    }
    return live;
  }

  function isAvailable(a) {
    if (!a || a.status !== "active" || !a.schedulable) return false;
    const t = now();
    return ![a.rate_limit_reset_at, a.overload_until, a.temp_unschedulable_until].some((x) => x && new Date(x).getTime() > t);
  }
  const aliveIn = (gid, exclude) =>
    (state.groups[gid]?.accounts || []).filter((aid) => aid !== exclude && accById(aid)?.group_ids.includes(+gid) && isAvailable(accById(aid)) && acctState(aid).breaker !== "open");

  // ---------- 快循环 ----------
  let fastRunning = false;
  async function fastTick() {
    if (fastRunning) return;
    fastRunning = true;
    try {
      rt.accounts = (await s2("GET", "/admin/accounts?page=1&page_size=1000")).items.map((a) => ({ ...a, credentials: undefined, extra: undefined, account_groups: undefined, groups: undefined, group_ids: a.group_ids || [] }));
      rt.groups = await s2("GET", "/admin/groups/all");
      const ids = enrolledIds().filter((id) => accById(id));
      rt.live = ids.length ? await loadLive(ids) : {};
      if (observeOnly) {
        rt.lastFast = new Date().toISOString();
        rt.lastError = null; // 与正常路径一致：本轮成功就清掉上一轮的异常
        return;
      }
      const cfg = state.config;
      const alerts = [];

      for (const aid of ids) {
        const a = accById(aid);
        const s = acctState(aid);
        const l = rt.live[aid];
        const act = canAct(aid);
        snapshotOriginal(a);

        // 1. 熔断判定（关闭 / 观察期 状态下）
        if (s.breaker !== "open") {
          const req = l.ok + l.fail + l.dead + l.r429;
          let why = null;
          if (l.dead >= cfg.breaker.deadCount) why = `账号死亡类错误 ${l.dead} 次/${cfg.breaker.windowSec}s（${l.lastErr?.code} ${l.lastErr?.msg || ""}）`;
          else if (l.consec >= cfg.breaker.consecFail) why = `连续失败 ${l.consec} 次（${l.lastErr?.code} ${l.lastErr?.msg || ""}）`;
          else if (req >= cfg.breaker.minReq && (l.fail + l.dead) / req >= cfg.breaker.errRate)
            why = `错误率 ${Math.round(((l.fail + l.dead) / req) * 100)}%（${l.fail + l.dead}/${req}）`;
          else if (s.breaker === "probation" && (l.dead > 0 || l.fail >= 3)) why = `观察期内再次出错 ${l.dead + l.fail} 次（${l.lastErr?.code} ${l.lastErr?.msg || ""}）`;

          if (why) {
            const isDead = l.dead >= cfg.breaker.deadCount;
            // 存活保护：非死亡类错误不能把任何分组打到最少存活数以下，只降优先级
            const protectedBy = groupsOfAccount(aid).find((gid) => aliveIn(gid, aid).length < (state.groups[gid].minAlive ?? cfg.minAlive));
            if (!isDead && protectedBy && a.status === "active" && a.schedulable) {
              if (act && a.priority !== 10) await bulk(aid, { priority: 10 }, `应熔断但受存活保护（分组 ${groupName(protectedBy)}），降为优先级 10：${why}`);
              else if (!act) maybeLog(aid, "would", `[未开启自动] 应熔断但受存活保护：${why}`);
            } else if (act) {
              if (a.schedulable) await bulk(aid, { schedulable: false }, `熔断：${why}`);
              Object.assign(s, { breaker: "open", openedAt: now(), reason: why, probeFails: 0, lastProbeAt: now() });
              log({ level: "alert", account_id: aid, account_name: a.name, msg: `账号「${a.name}」已熔断：${why}` });
            } else maybeLog(aid, "would", `[未开启自动] 应熔断：${why}`);
          }
        }

        // 2. sub2api 自己标成 error 的关联账号，也纳入探测恢复
        if (act && s.breaker === "closed" && a.status === "error") {
          Object.assign(s, { breaker: "open", openedAt: now(), reason: `sub2api 标记错误：${(a.error_message || "").slice(0, 150)}`, probeFails: 0, lastProbeAt: 0 });
          log({ level: "alert", account_id: aid, account_name: a.name, msg: `账号「${a.name}」处于错误状态，开始每 ${cfg.probeIntervalSec}s 探测` });
        }

        // 3. 观察期结束
        if (s.breaker === "probation" && now() >= s.probationUntil) {
          s.breaker = "closed";
          const target = rt.scores[aid]?.suggested ?? s.original?.priority ?? a.priority;
          if (act && target !== a.priority) await bulk(aid, { priority: target }, `观察期结束，恢复优先级 ${target}`);
          else log({ level: "info", account_id: aid, account_name: a.name, msg: "观察期结束，恢复正常" });
        }

        // 4. 负载系数保护：给粘性会话留位置 / 429 时收紧
        if (act && s.breaker !== "open") {
          const conc = a.concurrency || 0;
          const cur = a.current_concurrency || 0;
          const limitLf = Math.max(1, Math.floor(conc * cfg.headroom));
          const origLf = s.original?.load_factor ?? 0; // 0 = 清空，恢复按并发计算
          if (l.r429 >= 5 && cur > 0) {
            const lf = Math.max(1, Math.floor(cur * 0.8));
            if ((a.load_factor ?? conc) > lf) {
              await bulk(aid, { load_factor: lf }, `1 分钟内 429 ${l.r429} 次，负载系数收紧到 ${lf}（只挡新会话，老会话不受影响）`);
              s.lfUntil = now() + 10 * 60000;
            }
          } else if (conc > 0 && cur >= limitLf && (a.load_factor ?? conc) > limitLf) {
            await bulk(aid, { load_factor: limitLf }, `并发 ${cur}/${conc} 超过 ${Math.round(cfg.headroom * 100)}%，负载系数设为 ${limitLf}，为粘性会话留位`);
            s.lfUntil = now() + 5 * 60000;
          } else if (s.lfUntil && now() > s.lfUntil && cur < limitLf * 0.7 && (a.load_factor ?? 0) !== origLf) {
            await bulk(aid, { load_factor: origLf }, `负载恢复正常，负载系数还原为 ${origLf || "未设置"}`);
            s.lfUntil = null;
          }
        }
      }

      // 5. 探测（并行，最多 5 个）
      const toProbe = ids.filter((aid) => {
        const s = acctState(aid);
        if (s.breaker !== "open" || !canAct(aid)) return false;
        const fails = s.probeFails || 0;
        const interval = fails >= 60 ? 300 : fails >= 20 ? 120 : cfg.probeIntervalSec; // 久坏的号放宽探测，省费用
        return now() - (s.lastProbeAt || 0) >= interval * 1000 - 2000;
      });
      for (let i = 0; i < toProbe.length; i += 5) {
        await Promise.all(
          toProbe.slice(i, i + 5).map(async (aid) => {
            const s = acctState(aid);
            const a = accById(aid);
            const r = await probe(aid);
            if (r.ok) {
              if (a.status === "error") await s2("POST", `/admin/accounts/${aid}/clear-error`);
              await bulk(aid, { schedulable: true, priority: 10 }, `探测通过（${r.ms}ms），恢复调度，优先级 10 观察 ${cfg.probationMin} 分钟`);
              Object.assign(s, { breaker: "probation", probationUntil: now() + cfg.probationMin * 60000, probeFails: 0, reason: null, resetAt: now() });
            } else {
              s.probeFails = (s.probeFails || 0) + 1;
              if (s.probeFails === 1 || s.probeFails % 20 === 0) log({ level: "info", account_id: aid, account_name: a.name, msg: `探测失败 ${s.probeFails} 次：${r.msg}` });
            }
          })
        );
      }

      // 6. 存活检查 & 报警
      for (const [gid, g] of Object.entries(state.groups)) {
        if (!g.accounts.length) continue;
        const min = g.minAlive ?? cfg.minAlive;
        const alive = aliveIn(gid);
        if (alive.length < min)
          alerts.push({ level: alive.length === 0 ? "critical" : "warn", group_id: +gid, msg: `分组「${groupName(gid)}」关联账号存活 ${alive.length}/${min}` });
      }
      for (const aid of ids) {
        const s = acctState(aid);
        if (s.breaker === "open") alerts.push({ level: "warn", account_id: aid, msg: `账号「${accById(aid)?.name}」熔断中：${s.reason || ""}（已探测 ${s.probeFails || 0} 次）` });
      }
      // 新出现的分组级报警写进日志
      const prevKeys = new Set(rt.alerts.map((x) => x.msg.replace(/\d+\/\d+/, "")));
      for (const al of alerts) if (al.group_id && !prevKeys.has(al.msg.replace(/\d+\/\d+/, ""))) log({ level: "alert", group_id: al.group_id, msg: al.msg });
      rt.alerts = alerts;
      rt.lastFast = new Date().toISOString();
      rt.lastError = null;
      save();
    } catch (e) {
      rt.lastError = `快循环：${e.message}`;
      console.error("[scheduler fast]", e);
    } finally {
      fastRunning = false;
    }
  }

  const wouldLogged = {};
  function maybeLog(aid, key, msg) {
    const k = `${aid}|${key}|${msg.slice(0, 40)}`;
    if (wouldLogged[k] && now() - wouldLogged[k] < 10 * 60000) return;
    wouldLogged[k] = now();
    log({ level: "suggest", account_id: aid, account_name: accById(aid)?.name, msg });
  }
  const groupName = (gid) => rt.groups.find((g) => g.id === +gid)?.name || `#${gid}`;

  // ---------- 慢循环：打分 / 优先级 / 路由 ----------
  let scoreRunning = false;
  async function scoreTick() {
    if (scoreRunning) return;
    scoreRunning = true;
    try {
      const cfg = state.config;
      const pairs = Object.entries(state.groups).flatMap(([gid, g]) => g.accounts.map((aid) => [+gid, aid]));
      if (!pairs.length) {
        rt.scores = {};
        rt.cells = {};
        return;
      }
      const gids = [...new Set(pairs.map((p) => p[0]))];
      const aids = [...new Set(pairs.map((p) => p[1]))];
      const pairSet = new Set(pairs.map(([g, a]) => `${g}|${a}`));
      const [usage, errs] = await Promise.all([
        pool.query(
          `SELECT u.group_id, ${MODEL_SQL} AS model, u.account_id, count(*)::int AS n,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY u.first_token_ms) FILTER (WHERE u.first_token_ms IS NOT NULL) AS p50,
                  percentile_cont(0.9) WITHIN GROUP (ORDER BY u.first_token_ms) FILTER (WHERE u.first_token_ms IS NOT NULL) AS p90,
                  coalesce(sum(u.cache_read_tokens), 0)::float AS cr,
                  coalesce(sum(u.input_tokens + u.cache_read_tokens + u.cache_creation_tokens), 0)::float AS tin
             FROM usage_logs u
            WHERE u.group_id = ANY($1) AND u.account_id = ANY($2) AND u.created_at >= now() - make_interval(mins => $3)
            GROUP BY 1, 2, 3`,
          [gids, aids, cfg.scoreWindowMin]
        ),
        pool.query(
          `SELECT e.group_id, coalesce(nullif(btrim(e.requested_model), ''), e.model) AS model, e.account_id, count(*)::int AS n
             FROM ops_error_logs e
            WHERE e.group_id = ANY($1) AND e.account_id = ANY($2) AND e.created_at >= now() - make_interval(mins => $3)
              AND (${ERROR_CLASS_SQL}) IN ('dead', 'fail', 'r429')
            GROUP BY 1, 2, 3`,
          [gids, aids, cfg.scoreWindowMin]
        ),
      ]);
      const errBy = Object.fromEntries(errs.rows.map((r) => [`${r.group_id}|${r.model}|${r.account_id}`, r.n]));
      const cells = {};
      for (const r of usage.rows) {
        if (!pairSet.has(`${r.group_id}|${r.account_id}`)) continue;
        const k = `${r.group_id}|${r.model}`;
        const e = errBy[`${r.group_id}|${r.model}|${r.account_id}`] || 0;
        (cells[k] ||= []).push({
          account_id: r.account_id, n: r.n, p50: r.p50 == null ? null : Math.round(r.p50), p90: r.p90 == null ? null : Math.round(r.p90),
          cache: r.tin > 0 ? r.cr / r.tin : null, cr: r.cr, tin: r.tin, err: e / (r.n + e), errors: e,
        });
      }
      // 只有请求失败、没有成功的账号，也要在格子里出现（错误率 100%）
      for (const r of errs.rows) {
        if (!pairSet.has(`${r.group_id}|${r.account_id}`)) continue;
        const k = `${r.group_id}|${r.model}`;
        if (!(cells[k] ||= []).some((c) => c.account_id === r.account_id))
          cells[k].push({ account_id: r.account_id, n: 0, p50: null, p90: null, cache: null, err: 1, errors: r.n });
      }
      // 组内同模型相对打分
      const w = cfg.weights;
      for (const list of Object.values(cells)) {
        const ok = list.filter((c) => c.n + c.errors >= cfg.minSamples);
        const best50 = Math.min(...ok.map((c) => c.p50).filter((v) => v > 0));
        const best90 = Math.min(...ok.map((c) => c.p90).filter((v) => v > 0));
        const bestCache = Math.max(0, ...ok.map((c) => c.cache ?? 0));
        for (const c of list) {
          if (c.n + c.errors < cfg.minSamples) { c.score = null; continue; }
          const ttft = c.p50 > 0 && isFinite(best50) ? 0.6 * (best50 / c.p50) + 0.4 * (c.p90 > 0 && isFinite(best90) ? best90 / c.p90 : 1) : c.n === 0 ? 0 : 1;
          const cache = bestCache > 0.05 ? (c.cache ?? 0) / bestCache : 1;
          const err = 1 - clamp(c.err / 0.2, 0, 1);
          c.parts = { ttft: +ttft.toFixed(3), cache: +cache.toFixed(3), err: +err.toFixed(3) };
          c.score = +(w.ttft * ttft + w.cache * cache + w.err * err).toFixed(3);
        }
      }
      rt.cells = cells;

      // 账号综合分 = 按请求量加权
      const scores = {};
      for (const [k, list] of Object.entries(cells)) {
        for (const c of list) {
          if (c.score == null) continue;
          const s = (scores[c.account_id] ||= { wsum: 0, n: 0, cells: [] });
          const wt = c.n + c.errors;
          s.wsum += c.score * wt;
          s.n += wt;
          s.cells.push({ key: k, ...c });
        }
      }
      for (const s of Object.values(scores)) {
        s.score = +(s.wsum / s.n).toFixed(3);
        delete s.wsum;
      }
      // 相对评分：和同分组（已关联）里最好的账号比，最好的永远是 1，差距越大越靠后
      for (const [aid, s] of Object.entries(scores)) {
        const peers = new Set(groupsOfAccount(+aid).flatMap((gid) => state.groups[gid].accounts));
        const best = Math.max(...[...peers].map((p) => scores[p]?.score ?? 0), s.score);
        s.rel = best > 0 ? s.score / best : 1;
        s.suggested = clamp(1 + Math.round((1 - s.rel) * 18), 1, 10); // 相对差 5% ≈ 一档
      }
      rt.scores = scores;
      if (observeOnly) {
        rt.lastScore = new Date().toISOString();
        return;
      }

      // 应用优先级
      for (const aid of aids) {
        const a = accById(aid);
        const s = acctState(aid);
        const sc = scores[aid];
        if (!a || !sc || s.breaker !== "closed") continue;
        if (sc.suggested === a.priority) continue;
        const target = a.priority < 1 || a.priority > 10 ? sc.suggested : a.priority + clamp(sc.suggested - a.priority, -cfg.maxStep, cfg.maxStep);
        if (!canAct(aid)) { maybeLog(aid, "prio", `[未开启自动] 建议优先级 ${a.priority} → ${sc.suggested}（评分 ${sc.score}）`); continue; }
        if (s.lastPrioAt && now() - s.lastPrioAt < cfg.changeCooldownMin * 60000) continue;
        await bulk(aid, { priority: target }, `评分 ${sc.score}，优先级 ${a.priority} → ${target}${target !== sc.suggested ? `（目标 ${sc.suggested}，单次最多调 ${cfg.maxStep}）` : ""}`, { score: sc.score });
        s.lastPrioAt = now();
      }

      // 模型路由
      for (const [gid, g] of Object.entries(state.groups)) {
        if (!g.routing || !g.auto || !state.enabled || !g.accounts.length) continue;
        const grp = rt.groups.find((x) => x.id === +gid);
        if (!grp) continue;
        if (!g.originalRouting) g.originalRouting = { model_routing: grp.model_routing || {}, model_routing_enabled: !!grp.model_routing_enabled };
        const routing = {};
        for (const [k, list] of Object.entries(cells)) {
          const [cg, model] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
          if (cg !== gid) continue;
          const cand = list
            .filter((c) => c.score != null && acctState(c.account_id).breaker === "closed" && isAvailable(accById(c.account_id)))
            .sort((x, y) => y.score - x.score);
          if (cand.length < 2) continue; // 候选不足 2 个不做路由，交给整组调度
          let k2 = Math.min(cfg.routingTopK, cand.length);
          const load = (ids) => ids.reduce((s, c) => { const a = accById(c.account_id); return s + (a.concurrency ? (a.current_concurrency || 0) / a.concurrency : 0); }, 0) / ids.length;
          while (k2 < cand.length && load(cand.slice(0, k2)) > cfg.routingExpandLoad) k2++;
          routing[model] = cand.slice(0, k2).map((c) => c.account_id);
        }
        const cur = JSON.stringify(Object.fromEntries(Object.entries(grp.model_routing || {}).sort()));
        const next = JSON.stringify(Object.fromEntries(Object.entries(routing).sort()));
        if (cur !== next || grp.model_routing_enabled !== Object.keys(routing).length > 0) {
          await s2("PUT", `/admin/groups/${gid}`, { model_routing: routing, model_routing_enabled: Object.keys(routing).length > 0 });
          log({ level: "action", group_id: +gid, msg: `分组「${grp.name}」模型路由更新：${Object.entries(routing).map(([m, ids]) => `${m} → ${ids.map((i) => accById(i)?.name || i).join(" / ")}`).join("；") || "（清空，交给整组调度）"}` });
        }
      }
      rt.lastScore = new Date().toISOString();
      save();
    } catch (e) {
      rt.lastError = `评分循环：${e.message}`;
      console.error("[scheduler score]", e);
    } finally {
      scoreRunning = false;
    }
  }

  // ---------- 还原 ----------
  async function restoreAccount(aid, why) {
    const s = state.accounts[aid];
    const a = accById(aid);
    if (!s?.original || !a) return;
    const body = {};
    if (a.priority !== s.original.priority) body.priority = s.original.priority;
    // 原来没设负载系数的，传 0 清空（sub2api：0 = 不设置，按并发计算）
    if ((a.load_factor ?? null) !== (s.original.load_factor ?? null)) body.load_factor = s.original.load_factor ?? 0;
    if (s.breaker !== "closed" && !a.schedulable && s.original.schedulable) body.schedulable = true;
    if (Object.keys(body).length) await bulk(aid, body, `${why}，还原为关联前的设置`);
    delete state.accounts[aid];
  }
  async function restoreGroupRouting(gid) {
    const g = state.groups[gid];
    if (!g?.originalRouting) return;
    await s2("PUT", `/admin/groups/${gid}`, g.originalRouting);
    log({ level: "action", group_id: +gid, msg: `分组「${groupName(gid)}」模型路由已还原为开启前的配置` });
    g.originalRouting = null;
  }

  // ---------- 对外接口 ----------
  const api = {
    get state() { return state; },
    rt,
    audit: (limit = 300, filter = {}) =>
      audit.filter((e) => (!filter.group_id || e.group_id === +filter.group_id || groupsOfAccount(e.account_id).includes(+filter.group_id)) && (!filter.account_id || e.account_id === +filter.account_id)).slice(-limit).reverse(),
    setGlobal({ enabled, config }) {
      if (typeof enabled === "boolean" && enabled !== state.enabled) {
        state.enabled = enabled;
        log({ level: "action", msg: `智能调度总开关：${enabled ? "开启" : "关闭"}` });
      }
      if (config) state.config = deepMerge(state.config, config);
      save();
    },
    async setGroup(gid, { auto, routing, minAlive, probeModel, detect, detectExpect }) {
      const g = groupCfg(gid);
      g.touched = true;
      if (typeof auto === "boolean" && auto !== g.auto) {
        g.auto = auto;
        log({ level: "action", group_id: +gid, msg: `分组「${groupName(gid)}」智能调度：${auto ? "开启" : "关闭"}` });
      }
      if (typeof routing === "boolean" && routing !== g.routing) {
        g.routing = routing;
        log({ level: "action", group_id: +gid, msg: `分组「${groupName(gid)}」自动模型路由：${routing ? "开启" : "关闭"}` });
        if (!routing) await restoreGroupRouting(gid);
      }
      if (typeof detect === "boolean" && detect !== g.detect) {
        g.detect = detect;
        log({ level: "action", group_id: +gid, msg: `分组「${groupName(gid)}」深度检测：${detect ? "开启（每 5 分钟）" : "关闭"}` });
      }
      if (detectExpect !== undefined) g.detectExpect = detectExpect === "bedrock" ? "bedrock" : "any";
      if (probeModel !== undefined) g.probeModel = String(probeModel || "").trim() || null;
      if (minAlive !== undefined) g.minAlive = minAlive === null || minAlive === "" ? null : Math.max(0, parseInt(minAlive));
      save();
    },
    async enroll(gid, accountIds, enrolled) {
      const fresh = !state.groups[gid]?.accounts?.length && !state.groups[gid]?.touched;
      const g = groupCfg(gid);
      if (fresh && enrolled) {
        g.auto = true; // 分组第一次关联账号时默认开启智能调度（只作用于关联账号）
        g.touched = true;
      }
      for (const aid of accountIds.map(Number)) {
        if (enrolled && !g.accounts.includes(aid)) {
          g.accounts.push(aid);
          const a = accById(aid);
          if (a) snapshotOriginal(a);
          acctState(aid).resetAt ??= now();
          log({ level: "action", group_id: +gid, account_id: aid, account_name: a?.name, msg: `关联到分组「${groupName(gid)}」的智能调度` });
        } else if (!enrolled && g.accounts.includes(aid)) {
          g.accounts = g.accounts.filter((x) => x !== aid);
          log({ level: "action", group_id: +gid, account_id: aid, account_name: accById(aid)?.name, msg: `从分组「${groupName(gid)}」的智能调度移出` });
          if (!groupsOfAccount(aid).length) await restoreAccount(aid, "已不在任何智能调度分组");
        }
      }
      save();
    },
    async probeNow(aid) {
      const r = await probe(aid);
      log({ level: "info", account_id: aid, account_name: accById(aid)?.name, msg: `手动探测：${r.ok ? "通过" : "失败 " + r.msg}（${r.ms}ms）` });
      save();
      return r;
    },
    async restoreAll() {
      for (const gid of Object.keys(state.groups)) await restoreGroupRouting(gid);
      for (const aid of Object.keys(state.accounts).map(Number)) await restoreAccount(aid, "一键还原");
      for (const g of Object.values(state.groups)) { g.auto = false; g.routing = false; }
      log({ level: "action", msg: "一键还原：所有分组关闭智能调度，关联账号恢复原设置（关联关系保留）" });
      save();
    },
    groupsOfAccount,
    log,
    getGroupCfg: (gid) => state.groups[gid] || null,
    acctState,
    isAvailable,
    aliveIn,
    fastTick,
    scoreTick,
    start() {
      const loopFast = async () => { await fastTick(); setTimeout(loopFast, 30000); };
      setTimeout(loopFast, 3000);
      const loopScore = async () => { await scoreTick(); setTimeout(loopScore, state.config.scoreIntervalMin * 60000); };
      setTimeout(loopScore, 20000);
    },
  };
  return api;
}
