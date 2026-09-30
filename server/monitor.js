// 延迟监控条（参考 zhongtai 的 Heatmap）：把账号的真实流量按时间分段，每段给出一个状态色块。
// 数据直接按时间分桶查 usage_logs / ops_error_logs，不另外存储、不发任何探测请求，零成本。
//
// 每段状态（按优先级判定）：
//   unknown 无请求 → down 死亡类错误且无成功，或上游错误率 ≥ 30% → limited 以 429 为主 → slow 首字 P50 ≥ slowMs → up
// 评级（同 zhongtai monitor-score）：取最近 12 段，忽略 unknown / limited
//   unavailable：末尾连续 down ≥ 3 或失败率 ≥ 0.5；excellent：失败率 ≤ 0.1、偏慢率 ≤ 0.25 且最后一段不是 down；其余 unstable

const RANGES = {
  "2h": { bucketMin: 5, n: 24 },
  "6h": { bucketMin: 15, n: 24 },
  "24h": { bucketMin: 60, n: 24 },
};
const DEFAULT_SLOW_MS = 5000;
const SCORE_WINDOW = 12;

function statusOf(b, slowMs) {
  const upstreamErr = b.fail + b.dead;
  const total = b.n + upstreamErr;
  if (!total && !b.r429) return "unknown";
  if ((b.dead && !b.n) || (total >= 3 && upstreamErr / total >= 0.3) || (total && !b.n && upstreamErr)) return "down";
  if (b.r429 && b.r429 >= Math.max(1, b.n)) return "limited";
  if (b.p50 != null && b.p50 >= slowMs) return "slow";
  return "up";
}

export function scoreOf(samples) {
  const recent = samples.slice(-SCORE_WINDOW).filter((s) => s.status !== "unknown" && s.status !== "limited");
  if (!recent.length) return { grade: "unknown", total: 0, up: 0, slow: 0, down: 0 };
  const count = (st) => recent.filter((s) => s.status === st).length;
  const up = count("up");
  const slow = count("slow");
  const down = count("down");
  let tailDown = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i].status === "down"; i--) tailDown++;
  const failRate = down / recent.length;
  const slowRate = slow / recent.length;
  let grade = "unstable";
  if (tailDown >= 3 || failRate >= 0.5) grade = "unavailable";
  else if (failRate <= 0.1 && slowRate <= 0.25 && recent[recent.length - 1].status !== "down") grade = "excellent";
  return { grade, total: recent.length, up, slow, down };
}

export function registerMonitor({ app, wrap, pool, getAccounts, httpError, ERROR_CLASS_SQL }) {
  const cache = new Map();

  // GET /api/monitor/accounts?range=2h|6h|24h&slow_ms=5000&ids=1,2,3（不传 ids = 全部账号）
  app.get(
    "/api/monitor/accounts",
    wrap(async (req) => {
      const r = RANGES[req.query.range] || RANGES["2h"];
      const slowMs = Math.max(200, parseInt(req.query.slow_ms) || DEFAULT_SLOW_MS);
      const accounts = await getAccounts();
      let ids = String(req.query.ids || "")
        .split(",")
        .map(Number)
        .filter(Boolean);
      if (!ids.length) ids = accounts.map((a) => a.id);
      if (ids.length > 1000) throw httpError(400, "账号过多");

      const bucketSec = r.bucketMin * 60;
      const lastBucket = Math.floor(Date.now() / 1000 / bucketSec);
      const firstBucket = lastBucket - r.n + 1;
      const since = new Date(firstBucket * bucketSec * 1000);
      const key = `${req.query.range}|${slowMs}|${ids.join(",")}|${lastBucket}`;
      const hit = cache.get(key);
      if (hit && hit.exp > Date.now()) return hit.val;

      const [usage, errs] = await Promise.all([
        pool.query(
          `SELECT account_id, floor(extract(epoch FROM created_at) / $3)::bigint AS k, count(*)::int AS n,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL) AS p50,
                  percentile_cont(0.9) WITHIN GROUP (ORDER BY first_token_ms) FILTER (WHERE first_token_ms IS NOT NULL) AS p90
             FROM usage_logs WHERE account_id = ANY($1) AND created_at >= $2 GROUP BY 1, 2`,
          [ids, since, bucketSec],
        ),
        pool.query(
          `SELECT e.account_id, floor(extract(epoch FROM e.created_at) / $3)::bigint AS k, ${ERROR_CLASS_SQL} AS cls, count(*)::int AS n
             FROM ops_error_logs e WHERE e.account_id = ANY($1) AND e.created_at >= $2 GROUP BY 1, 2, 3`,
          [ids, since, bucketSec],
        ),
      ]);

      const buckets = {};
      const cell = (aid, k) => {
        const byK = (buckets[aid] ||= {});
        return (byK[k] ||= { n: 0, p50: null, p90: null, dead: 0, fail: 0, r429: 0, client: 0 });
      };
      for (const u of usage.rows) {
        const c = cell(u.account_id, Number(u.k));
        c.n = u.n;
        c.p50 = u.p50 == null ? null : Math.round(u.p50);
        c.p90 = u.p90 == null ? null : Math.round(u.p90);
      }
      for (const e of errs.rows) cell(e.account_id, Number(e.k))[e.cls] += e.n;

      const out = {};
      for (const aid of ids) {
        const samples = [];
        for (let k = firstBucket; k <= lastBucket; k++) {
          const b = buckets[aid]?.[k] || { n: 0, p50: null, p90: null, dead: 0, fail: 0, r429: 0, client: 0 };
          samples.push({ t: new Date(k * bucketSec * 1000).toISOString(), status: statusOf(b, slowMs), ...b });
        }
        out[aid] = { samples, score: scoreOf(samples) };
      }
      const val = { range: req.query.range in RANGES ? req.query.range : "2h", bucket_min: r.bucketMin, slow_ms: slowMs, accounts: out };
      cache.set(key, { val, exp: Date.now() + 30000 });
      if (cache.size > 50) cache.delete(cache.keys().next().value);
      return val;
    }),
  );
}
