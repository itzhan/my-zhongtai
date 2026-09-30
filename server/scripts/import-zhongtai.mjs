// 一次性导入：从 zhongtai 的 app.db（只读打开）把供应商、可提供的货、接口监测项与最近样本导入 ops.db。
// 用法：node scripts/import-zhongtai.mjs <zhongtai 的 app.db 路径> [DATA_DIR]
// 目标库里已有供应商时拒绝执行，避免重复导入。
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { normalizeRate, openDb } from "../suppliers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
const dataDir = process.argv[3] || process.env.DATA_DIR || path.join(__dirname, "..", "data");
if (!src) {
  console.error("用法：node scripts/import-zhongtai.mjs <zhongtai app.db> [DATA_DIR]");
  process.exit(1);
}

const from = new DatabaseSync(src, { readOnly: true });
const to = openDb(dataDir);
if (to.prepare("SELECT count(*) AS n FROM suppliers").get().n) {
  console.error("ops.db 里已经有供应商，停止导入（避免重复）");
  process.exit(1);
}

// zhongtai（Prisma + SQLite）的时间是毫秒时间戳
const iso = (v) => (v === null || v === undefined || v === "" ? null : new Date(Number(v)).toISOString());

to.exec("BEGIN");
try {
  const suppliers = from.prepare("SELECT * FROM Supplier ORDER BY id").all();
  const insS = to.prepare(
    `INSERT INTO suppliers (id, name, wechat, contact, base_url, category, channel, status, notes, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of suppliers) {
    insS.run(s.id, s.name, s.wechat || "", s.contact || "", s.baseUrl || "", s.category || "", s.channel || "", s.status || "active", s.notes || "", iso(s.deletedAt), iso(s.createdAt), iso(s.updatedAt));
  }

  const goods = from.prepare("SELECT * FROM SupplierGood ORDER BY id").all();
  const insG = to.prepare("INSERT INTO supplier_goods (id, supplier_id, name, rate, created_at) VALUES (?, ?, ?, ?, ?)");
  for (const g of goods) insG.run(g.id, g.supplierId, g.name, normalizeRate(g.rate || ""), iso(g.createdAt));

  const monitors = from.prepare("SELECT * FROM SupplierMonitor ORDER BY id").all();
  const insM = to.prepare(
    `INSERT INTO supplier_monitors (id, supplier_id, name, kind, base_url, api_key, model, enabled, slow_ms, last_status, last_latency_ms, last_error, last_checked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of monitors) {
    insM.run(m.id, m.supplierId, m.name, m.kind, m.baseUrl, m.apiKey || "", m.model || "", m.enabled ? 1 : 0, m.slowMs || 5000, m.lastStatus || "unknown", m.lastLatencyMs ?? null, m.lastError || "", iso(m.lastCheckedAt), iso(m.createdAt), iso(m.updatedAt));
  }

  // 每个监测项只导最近 48 条样本（与保留策略一致）
  const samples = from
    .prepare(
      `SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY monitorId ORDER BY checkedAt DESC) AS rn FROM SupplierMonitorSample) WHERE rn <= 48 ORDER BY checkedAt`,
    )
    .all();
  const insX = to.prepare("INSERT INTO supplier_monitor_samples (monitor_id, status, latency_ms, http_status, error, checked_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const x of samples) insX.run(x.monitorId, x.status, x.latencyMs || 0, x.httpStatus ?? null, x.error || "", iso(x.checkedAt));

  to.exec("COMMIT");
  console.log(`导入完成：供应商 ${suppliers.length}（含已删除 ${suppliers.filter((s) => s.deletedAt).length}）、货 ${goods.length}、监测项 ${monitors.length}、样本 ${samples.length}`);
} catch (e) {
  to.exec("ROLLBACK");
  throw e;
}
