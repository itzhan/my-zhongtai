// 账号录入模板：保存常用渠道（如 awsb / az_gpt / vertex_gemini 等）的默认 sub2api 账号配置，
// 一键录入或新建账号时套用模板，仅需填写名称 / URL / Key 并按需微调分组等参数。
// 存储：DATA_DIR/ops.db（node:sqlite），与 sub2api 解耦；只读模式下同样可增删改模板。
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PLATFORMS = new Set(["anthropic", "openai", "gemini"]);
const CODE_RE = /^[a-z0-9_-]{2,48}$/;
const KNOWN_CRED_KEYS = new Set([
  "base_url",
  "model_mapping",
  "pool_mode",
  "pool_mode_retry_count",
  "pool_mode_retry_status_codes",
  "api_key",
  "access_token",
  "refresh_token",
  "session_key",
  "cookie",
]);
const KNOWN_EXTRA_KEYS = new Set([
  "anthropic_passthrough",
  "openai_passthrough",
  "upstream_billing_probe_enabled",
]);

const nowIso = () => new Date().toISOString();
const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);

function parseJsonSafe(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function cleanPlainObject(raw, dropKeys = new Set()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = str(k, 100);
    if (!key || dropKeys.has(key)) continue;
    out[key] = v;
  }
  return out;
}

function normalizeModelMapping(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const reqModel = str(k, 150);
    if (!reqModel) continue;
    out[reqModel] = str(v || reqModel, 150);
  }
  return out;
}

function normalizeRetryCodes(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,\s，]+/);
  const codes = [...new Set(list.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n >= 100 && n < 600))];
  return codes.join(",");
}

function normalizeGroupIds(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0))];
}

function numOr(v, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (v === "" || v === null || v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeTemplateConfig(raw = {}) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const platform = PLATFORMS.has(src.platform) ? src.platform : "anthropic";
  const loadFactorRaw = src.load_factor === null || src.load_factor === undefined ? "" : String(src.load_factor).trim();
  const loadFactor = loadFactorRaw && Number.isFinite(Number(loadFactorRaw)) && Number(loadFactorRaw) > 0 ? loadFactorRaw : "";
  return {
    platform,
    notes: str(src.notes, 1000),
    schedulable: src.schedulable !== false,
    use_as_detect_key: src.use_as_detect_key !== false,
    pool_mode: Boolean(src.pool_mode),
    pool_mode_retry_count: Math.round(numOr(src.pool_mode_retry_count, 3, { min: 0, max: 10 })),
    pool_mode_retry_status_codes: normalizeRetryCodes(src.pool_mode_retry_status_codes),
    passthrough: platform === "gemini" ? false : Boolean(src.passthrough),
    upstream_billing_probe_enabled: Boolean(src.upstream_billing_probe_enabled),
    model_mapping: normalizeModelMapping(src.model_mapping),
    priority: Math.round(numOr(src.priority, 1, { min: 0, max: 1000 })),
    concurrency: Math.round(numOr(src.concurrency, 1000, { min: 0, max: 100000 })),
    load_factor: loadFactor,
    rate_multiplier: numOr(src.rate_multiplier, 1, { min: 0, max: 1000 }),
    proxy_id: Math.round(numOr(src.proxy_id, 0, { min: 0, max: 10000000 })),
    auto_pause_on_expired: src.auto_pause_on_expired !== false,
    group_ids: normalizeGroupIds(src.group_ids),
    credentials_other: cleanPlainObject(src.credentials_other, KNOWN_CRED_KEYS),
    extra_other: cleanPlainObject(src.extra_other, KNOWN_EXTRA_KEYS),
  };
}

export const STARTER_TEMPLATES = [
  {
    code: "awsb",
    name: "awsb",
    description: "AWS Bedrock 中转默认配置：Anthropic + 号池模式 + 透传 + 高并发，按需补充所属分组与模型映射",
    channel_code: "aws_bedrock",
    sort_order: 1,
    config: normalizeTemplateConfig({
      platform: "anthropic",
      pool_mode: true,
      pool_mode_retry_count: 3,
      passthrough: true,
      concurrency: 1000,
      load_factor: "1000",
      priority: 1,
      rate_multiplier: 1,
      schedulable: true,
      use_as_detect_key: true,
      auto_pause_on_expired: true,
    }),
  },
  {
    code: "az_gpt",
    name: "az gpt",
    description: "OpenAI / Azure 中转默认配置：OpenAI + 号池模式 + 透传",
    channel_code: "az_gpt",
    sort_order: 2,
    config: normalizeTemplateConfig({
      platform: "openai",
      pool_mode: true,
      pool_mode_retry_count: 3,
      passthrough: true,
      concurrency: 1000,
      priority: 1,
      rate_multiplier: 1,
      schedulable: true,
      use_as_detect_key: true,
      auto_pause_on_expired: true,
    }),
  },
  {
    code: "vertex_gemini",
    name: "vertex gemini",
    description: "Google Cloud Vertex Gemini 中转默认配置",
    channel_code: "vertex_gemini",
    sort_order: 3,
    config: normalizeTemplateConfig({
      platform: "gemini",
      pool_mode: true,
      pool_mode_retry_count: 3,
      passthrough: false,
      concurrency: 1000,
      priority: 1,
      rate_multiplier: 1,
      schedulable: true,
      use_as_detect_key: true,
      auto_pause_on_expired: true,
    }),
  },
  {
    code: "as_gemini",
    name: "as gemini",
    description: "AI Studio Gemini 中转默认配置",
    channel_code: "as_gemini",
    sort_order: 4,
    config: normalizeTemplateConfig({
      platform: "gemini",
      pool_mode: true,
      pool_mode_retry_count: 3,
      passthrough: false,
      concurrency: 1000,
      priority: 1,
      rate_multiplier: 1,
      schedulable: true,
      use_as_detect_key: true,
      auto_pause_on_expired: true,
    }),
  },
];

function makeCode(rawCode, name) {
  const cleaned = str(rawCode, 48).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  if (CODE_RE.test(cleaned)) return cleaned;
  const fromName = str(name, 40).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const base = fromName.length >= 2 ? fromName.slice(0, 32) : "tpl";
  return `${base}_${Date.now().toString(36).slice(-6)}`;
}

function templateView(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    channel_code: row.channel_code || "",
    sort_order: row.sort_order ?? 100,
    config: normalizeTemplateConfig(parseJsonSafe(row.config_json, {})),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function openAccountTemplatesDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "ops.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS account_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      channel_code TEXT NOT NULL DEFAULT '',
      config_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_templates_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const seeded = db.prepare("SELECT value FROM account_templates_meta WHERE key = 'seeded_v1'").get();
  if (!seeded) {
    const count = db.prepare("SELECT count(*) AS n FROM account_templates").get()?.n ?? 0;
    if (count === 0) {
      const t = nowIso();
      const ins = db.prepare(`
        INSERT OR IGNORE INTO account_templates
          (code, name, description, channel_code, config_json, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const tpl of STARTER_TEMPLATES) {
        ins.run(tpl.code, tpl.name, tpl.description, tpl.channel_code, JSON.stringify(tpl.config), tpl.sort_order, t, t);
      }
    }
    db.prepare("INSERT OR REPLACE INTO account_templates_meta (key, value) VALUES ('seeded_v1', '1')").run();
  }
  return db;
}

export function registerAccountTemplates({ app, wrap, httpError, dataDir }) {
  const db = openAccountTemplatesDb(dataDir);
  const q = {
    all: db.prepare("SELECT * FROM account_templates ORDER BY sort_order ASC, id ASC"),
    one: db.prepare("SELECT * FROM account_templates WHERE id = ?"),
    byCode: db.prepare("SELECT * FROM account_templates WHERE code = ?"),
  };

  const mustTemplate = (idRaw) => {
    const id = parseInt(idRaw, 10);
    if (!Number.isInteger(id) || id <= 0) throw httpError(400, "模板 ID 无效");
    const row = q.one.get(id);
    if (!row) throw httpError(404, "模板不存在");
    return row;
  };

  app.get(
    "/api/account-templates",
    wrap(async () => q.all.all().map(templateView)),
  );

  app.get(
    "/api/account-templates/:id",
    wrap(async (req) => templateView(mustTemplate(req.params.id))),
  );

  app.post(
    "/api/account-templates",
    wrap(async (req) => {
      const b = req.body || {};
      const name = str(b.name, 60);
      if (!name) throw httpError(400, "模板名称必填");
      let code = makeCode(b.code, name);
      if (b.code && !CODE_RE.test(str(b.code, 48).toLowerCase())) {
        throw httpError(400, "模板编码仅支持 2-48 位小写字母、数字、下划线或短横线");
      }
      if (q.byCode.get(code)) {
        if (b.code) throw httpError(409, `模板编码「${code}」已存在`);
        code = `${code.slice(0, 40)}_${Math.random().toString(36).slice(2, 6)}`;
      }
      const description = str(b.description, 300);
      const channelCode = str(b.channel_code, 50);
      const config = normalizeTemplateConfig(b.config);
      const maxOrder = db.prepare("SELECT coalesce(max(sort_order), 0) AS m FROM account_templates").get()?.m || 0;
      const sortOrder = b.sort_order != null ? Math.round(numOr(b.sort_order, maxOrder + 1, { min: 0, max: 10000 })) : maxOrder + 1;
      const t = nowIso();
      const r = db
        .prepare(
          `INSERT INTO account_templates (code, name, description, channel_code, config_json, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(code, name, description, channelCode, JSON.stringify(config), sortOrder, t, t);
      return templateView(q.one.get(r.lastInsertRowid));
    }),
  );

  app.put(
    "/api/account-templates/:id",
    wrap(async (req) => {
      const cur = mustTemplate(req.params.id);
      const b = req.body || {};
      const name = "name" in b ? str(b.name, 60) : cur.name;
      if (!name) throw httpError(400, "模板名称必填");
      const description = "description" in b ? str(b.description, 300) : cur.description;
      const channelCode = "channel_code" in b ? str(b.channel_code, 50) : cur.channel_code;
      const sortOrder =
        "sort_order" in b ? Math.round(numOr(b.sort_order, cur.sort_order, { min: 0, max: 10000 })) : cur.sort_order;
      const config = "config" in b ? normalizeTemplateConfig(b.config) : normalizeTemplateConfig(parseJsonSafe(cur.config_json, {}));
      db.prepare(
        `UPDATE account_templates
            SET name = ?, description = ?, channel_code = ?, config_json = ?, sort_order = ?, updated_at = ?
          WHERE id = ?`,
      ).run(name, description, channelCode, JSON.stringify(config), sortOrder, nowIso(), cur.id);
      return templateView(q.one.get(cur.id));
    }),
  );

  app.delete(
    "/api/account-templates/:id",
    wrap(async (req) => {
      const cur = mustTemplate(req.params.id);
      db.prepare("DELETE FROM account_templates WHERE id = ?").run(cur.id);
      return { ok: true };
    }),
  );
}
