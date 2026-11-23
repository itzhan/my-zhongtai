// 模型基础连通测试（非真假鉴定）：拉取上游全部模型并并行发起最小对话请求，
// 区分每个模型「通 / 不通」与耗时，支持重测失败模型，并配合前端一键录入时仅写入通的模型。
// 存储：DATA_DIR/ops.db（node:sqlite），与真伪鉴定记录（verify_runs）隔离，避免污染真假统计。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildProbeHttpRequest,
  fetchUpstreamModels,
  maskSecret,
  normalizeUpstreamBase,
  redactSecret,
} from "./verifier.js";

const MODEL_TIMEOUT_MS = 25_000;
const MAX_BASIC_RUNS = 200;
const MAX_MODELS_PER_RUN = 300;
const MAX_SNIPPET = 1500;
const VALID_PROTOCOLS = new Set(["auto", "openai_chat", "openai_responses", "anthropic_messages", "gemini_native"]);

const nowIso = () => new Date().toISOString();
const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);

function parseJsonSafe(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function extractMessage(json, rawText) {
  if (!json || typeof json !== "object") return String(rawText || "");
  const err = json.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const parts = [err.code, err.type, err.message].filter(Boolean);
    if (parts.length) return parts.join(": ");
  }
  if (json.message) return String(json.message);
  return String(rawText || "");
}

function isReasoningChatModel(model) {
  return /^(o1|o3|o4|gpt-5)/i.test(String(model || "").trim());
}

function isResponsesPreferredModel(model) {
  const m = String(model || "").trim().toLowerCase();
  return /^(gpt|o1|o3|o4|codex)/.test(m) && (m.includes("codex") || /(?:^|-)pro(?:-|$)/.test(m));
}

export function pickPrimaryProtocol(model, requestedProtocol = "auto", modelsEndpoint = "") {
  if (requestedProtocol && requestedProtocol !== "auto" && VALID_PROTOCOLS.has(requestedProtocol)) {
    return requestedProtocol;
  }
  const m = String(model || "").trim().toLowerCase();
  if (/(?:^|\/|\.)(claude|opus|sonnet|haiku)|claude-/.test(m)) {
    return "anthropic_messages";
  }
  if (/gemini/.test(m)) {
    return /v1beta/i.test(modelsEndpoint) ? "gemini_native" : "openai_chat";
  }
  if (isResponsesPreferredModel(m)) {
    return "openai_responses";
  }
  return "openai_chat";
}

function buildMinimalBody(protocol, model, { useMaxCompletionTokens = false } = {}) {
  switch (protocol) {
    case "anthropic_messages":
      return {
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply OK" }],
      };
    case "gemini_native":
      return {
        contents: [{ role: "user", parts: [{ text: "Reply OK" }] }],
        generationConfig: { maxOutputTokens: 16 },
      };
    case "openai_responses":
      return {
        input: "Reply OK",
        max_output_tokens: 16,
      };
    case "openai_chat":
    default: {
      const useComp = useMaxCompletionTokens || isReasoningChatModel(model);
      return useComp
        ? {
            messages: [{ role: "user", content: "Reply OK" }],
            max_completion_tokens: 32,
          }
        : {
            messages: [{ role: "user", content: "Reply OK" }],
            max_tokens: 16,
          };
    }
  }
}

function inspectSseResponse(rawText) {
  let hasContent = false;
  let sseError = "";
  let responseModel = "";
  for (const rawLine of String(rawText || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const ev = parseJsonSafe(payload, null);
    if (!ev || typeof ev !== "object") continue;
    if (ev.error) {
      sseError = extractMessage(ev, payload);
      continue;
    }
    if (ev.type === "error") {
      sseError = extractMessage(ev.error || ev, payload);
      continue;
    }
    if (ev.model) responseModel = String(ev.model);
    if (ev.message?.model) responseModel = String(ev.message.model);
    if (ev.response?.model) responseModel = String(ev.response.model);
    if (ev.modelVersion) responseModel = String(ev.modelVersion);
    if (
      ev.id ||
      Array.isArray(ev.choices) ||
      Array.isArray(ev.candidates) ||
      ev.type === "message_start" ||
      ev.type === "content_block_delta" ||
      ev.type === "response.created" ||
      ev.type === "response.completed"
    ) {
      hasContent = true;
    }
  }
  return { hasContent, sseError, responseModel };
}

function evaluateBasicResponse({ protocol, httpStatus, headers, json, rawText }) {
  if (httpStatus === 0) {
    return { ok: false, responseModel: "", reason: String(rawText || "网络请求失败").slice(0, 180) };
  }
  if (httpStatus !== 200) {
    const msg = extractMessage(json, rawText).replace(/\s+/g, " ").trim().slice(0, 160);
    return {
      ok: false,
      responseModel: "",
      reason: `HTTP ${httpStatus}${msg ? ` · ${msg}` : ""}`,
    };
  }

  const ct = String(headers?.["content-type"] || "").toLowerCase();
  if (ct.includes("text/event-stream") || (!json && /^\s*(event:|data:)/m.test(String(rawText || "")))) {
    const sse = inspectSseResponse(rawText);
    if (sse.sseError && !sse.hasContent) {
      return { ok: false, responseModel: "", reason: `流式报错：${sse.sseError.slice(0, 160)}` };
    }
    if (sse.hasContent) {
      return {
        ok: true,
        responseModel: sse.responseModel,
        reason: `HTTP 200 · 连通正常${sse.responseModel ? ` (${sse.responseModel})` : ""}`,
      };
    }
  }

  if (!json || typeof json !== "object") {
    const preview = String(rawText || "").replace(/\s+/g, " ").trim().slice(0, 120);
    return {
      ok: false,
      responseModel: "",
      reason: `HTTP 200 但返回非 JSON${preview ? `：${preview}` : ""}`,
    };
  }
  if (json.error) {
    const msg = extractMessage(json, rawText).replace(/\s+/g, " ").trim().slice(0, 160);
    return { ok: false, responseModel: "", reason: `HTTP 200 但包含错误：${msg}` };
  }

  let validShape = false;
  let responseModel = "";
  if (protocol === "gemini_native") {
    validShape = Array.isArray(json.candidates) || Boolean(json.modelVersion);
    responseModel = String(json.modelVersion || "");
  } else if (protocol === "anthropic_messages") {
    validShape = Boolean(json.id || Array.isArray(json.content));
    responseModel = String(json.model || "");
  } else if (protocol === "openai_responses") {
    validShape = Boolean(json.id || Array.isArray(json.output));
    responseModel = String(json.model || "");
  } else {
    validShape = (Array.isArray(json.choices) && json.choices.length > 0) || Boolean(json.id);
    responseModel = String(json.model || "");
  }

  if (!validShape) {
    return {
      ok: false,
      responseModel: "",
      reason: "HTTP 200 但响应结构不合法（缺少模型输出字段）",
    };
  }
  return {
    ok: true,
    responseModel,
    reason: `HTTP 200 · 连通正常${responseModel ? ` (${responseModel})` : ""}`,
  };
}

function shouldFallbackProtocol(primaryProtocol, res, model) {
  const status = res.http_status;
  const text = `${res.raw_text || ""} ${res.reason || ""}`;
  const isRouteMissing =
    status === 404 ||
    status === 405 ||
    (status === 400 && /invalid url|unknown endpoint|unsupported path|not found/i.test(text));

  if (primaryProtocol === "anthropic_messages" && isRouteMissing) {
    return "openai_chat";
  }
  if (primaryProtocol === "gemini_native" && isRouteMissing) {
    return "openai_chat";
  }
  if (primaryProtocol === "openai_responses" && isRouteMissing) {
    return "openai_chat";
  }
  if (primaryProtocol === "openai_chat") {
    if (
      (status === 400 || status === 404) &&
      /v1\/responses|only supported in.*responses|not a chat model|use the responses/i.test(text)
    ) {
      return "openai_responses";
    }
    if (/gemini/i.test(model) && isRouteMissing) {
      return "gemini_native";
    }
  }
  return null;
}

async function sendMinimalOnce({ baseUrl, apiKey, protocol, model, body, fetchImpl, timeoutMs }) {
  const reqSpec = buildProbeHttpRequest({ baseUrl, apiKey, protocol, model, body });
  const started = Date.now();
  let res;
  let rawText = "";
  let headers = {};

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
    try {
      res = await fetchImpl(reqSpec.url, {
        method: "POST",
        headers: reqSpec.headers,
        body: JSON.stringify(reqSpec.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      headers = Object.fromEntries(res.headers.entries());
      rawText = await res.text();
      if (res.status !== 429) break;
    } catch (e) {
      const aborted = e?.name === "TimeoutError" || e?.name === "AbortError";
      const msg = aborted ? `请求超时 (>${Math.round(timeoutMs / 1000)}s)` : redactSecret(e?.cause?.message || e?.message || e, apiKey);
      return {
        url: redactSecret(reqSpec.url, apiKey),
        http_status: 0,
        headers: {},
        raw_text: msg,
        snippet: msg.slice(0, MAX_SNIPPET),
        json: null,
        latency_ms: Date.now() - started,
      };
    }
  }

  const sanitized = redactSecret(rawText, apiKey);
  const json = parseJsonSafe(sanitized, null);
  return {
    url: redactSecret(reqSpec.url, apiKey),
    http_status: res.status,
    headers,
    raw_text: sanitized,
    snippet: sanitized.slice(0, MAX_SNIPPET),
    json,
    latency_ms: Date.now() - started,
  };
}

export async function testSingleModel({
  baseUrl,
  apiKey,
  model,
  protocol = "auto",
  modelsEndpoint = "",
  fetchImpl = fetch,
  timeoutMs = MODEL_TIMEOUT_MS,
}) {
  const primary = pickPrimaryProtocol(model, protocol, modelsEndpoint);
  let usedProtocol = primary;
  let fallbackUsed = false;

  let res = await sendMinimalOnce({
    baseUrl,
    apiKey,
    protocol: primary,
    model,
    body: buildMinimalBody(primary, model),
    fetchImpl,
    timeoutMs,
  });

  // OpenAI 新模型若拒绝 max_tokens，自动改用 max_completion_tokens 重试一次
  if (
    primary === "openai_chat" &&
    res.http_status === 400 &&
    !isReasoningChatModel(model) &&
    /max_completion_tokens/i.test(res.raw_text || "")
  ) {
    fallbackUsed = true;
    res = await sendMinimalOnce({
      baseUrl,
      apiKey,
      protocol: "openai_chat",
      model,
      body: buildMinimalBody("openai_chat", model, { useMaxCompletionTokens: true }),
      fetchImpl,
      timeoutMs,
    });
  }

  let evaluated = evaluateBasicResponse({
    protocol: usedProtocol,
    httpStatus: res.http_status,
    headers: res.headers,
    json: res.json,
    rawText: res.raw_text,
  });

  if (!evaluated.ok && protocol === "auto") {
    const alt = shouldFallbackProtocol(primary, { ...res, reason: evaluated.reason }, model);
    if (alt && alt !== primary) {
      const altRes = await sendMinimalOnce({
        baseUrl,
        apiKey,
        protocol: alt,
        model,
        body: buildMinimalBody(alt, model),
        fetchImpl,
        timeoutMs,
      });
      const altEval = evaluateBasicResponse({
        protocol: alt,
        httpStatus: altRes.http_status,
        headers: altRes.headers,
        json: altRes.json,
        rawText: altRes.raw_text,
      });
      if (altEval.ok || (res.http_status === 404 && altRes.http_status !== 404)) {
        res = altRes;
        evaluated = altEval;
        usedProtocol = alt;
        fallbackUsed = true;
      }
    }
  }

  return {
    model,
    status: evaluated.ok ? "pass" : "fail",
    protocol_used: usedProtocol,
    fallback_used: fallbackUsed,
    http_status: res.http_status,
    latency_ms: res.latency_ms,
    reason: redactSecret(evaluated.reason, apiKey),
    response_model: redactSecret(evaluated.responseModel, apiKey),
    request_url: res.url,
    response_snippet: res.snippet,
  };
}

export function openBasicTestDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "ops.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS basic_test_runs (
      id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL DEFAULT 0,
      account_name TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL,
      sk_masked TEXT NOT NULL DEFAULT '',
      sk_source TEXT NOT NULL DEFAULT '',
      protocol TEXT NOT NULL DEFAULT 'auto',
      models_endpoint TEXT NOT NULL DEFAULT '',
      concurrency INTEGER NOT NULL DEFAULT 8,
      status TEXT NOT NULL DEFAULT 'running',
      total_models INTEGER NOT NULL DEFAULT 0,
      completed_models INTEGER NOT NULL DEFAULT 0,
      passed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      results_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_basic_test_runs_started ON basic_test_runs(started_at DESC);
    CREATE TABLE IF NOT EXISTS basic_test_manual_keys (
      run_id TEXT PRIMARY KEY,
      api_key TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function basicRunView(row, includeResults = true, hasSavedKey = false) {
  const results = parseJsonSafe(row.results_json, []);
  const passedModels = results.filter((r) => r.status === "pass").map((r) => r.model);
  const failedModels = results.filter((r) => r.status === "fail").map((r) => r.model);
  const out = {
    id: row.id,
    account_id: row.account_id,
    account_name: row.account_name,
    base_url: row.base_url,
    sk_masked: row.sk_masked,
    sk_source: row.sk_source,
    has_saved_key: Boolean(hasSavedKey),
    protocol: row.protocol,
    models_endpoint: row.models_endpoint,
    concurrency: row.concurrency,
    status: row.status,
    total_models: row.total_models,
    completed_models: row.completed_models,
    passed_count: row.passed_count,
    failed_count: row.failed_count,
    passed_models: passedModels,
    failed_models: failedModels,
    summary: row.summary,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
  };
  if (includeResults) out.results = results;
  return out;
}

export function registerBasicTester({ app, wrap, httpError, dataDir, verifierApi, fetchImpl = fetch }) {
  const db = openBasicTestDb(dataDir);
  const q = {
    run: db.prepare("SELECT * FROM basic_test_runs WHERE id = ?"),
    manualKey: db.prepare("SELECT api_key FROM basic_test_manual_keys WHERE run_id = ?"),
    allManualKeyIds: db.prepare("SELECT run_id FROM basic_test_manual_keys"),
    saveManualKey: db.prepare(
      "INSERT INTO basic_test_manual_keys (run_id, api_key, updated_at) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at",
    ),
    delManualKey: db.prepare("DELETE FROM basic_test_manual_keys WHERE run_id = ?"),
  };

  const activeRuns = new Set();

  function resolveBasicManualKey(sourceRunId, expectedBaseUrl = "") {
    const rid = str(sourceRunId, 40);
    if (!rid) return "";
    const keyRow = q.manualKey.get(rid);
    if (!keyRow?.api_key) return "";
    if (expectedBaseUrl) {
      const runRow = q.run.get(rid);
      if (runRow && normalizeUpstreamBase(runRow.base_url) !== normalizeUpstreamBase(expectedBaseUrl)) {
        return "";
      }
    }
    return String(keyRow.api_key).trim();
  }

  function resolveAnyManualKey(sourceRunId, expectedBaseUrl = "") {
    return (
      resolveBasicManualKey(sourceRunId, expectedBaseUrl) ||
      (verifierApi?.getManualRunKey ? verifierApi.getManualRunKey(sourceRunId, expectedBaseUrl) : "")
    );
  }

  function buildSummary(results, status) {
    const total = results.length;
    const passed = results.filter((r) => r.status === "pass").length;
    const failed = results.filter((r) => r.status === "fail").length;
    const done = passed + failed;
    if (status === "running") {
      return `正在并行测试模型连通性（已完成 ${done}/${total}，通 ${passed} · 不通 ${failed}）…`;
    }
    if (total === 0) return "未拉取到任何模型";
    if (passed === total) return `全部 ${total} 个模型均连通正常`;
    if (passed === 0) return `共测试 ${total} 个模型，全部不通（0/${total}）`;
    return `共测试 ${total} 个模型：${passed} 个通，${failed} 个不通（一键添加时将仅录入通的模型）`;
  }

  function saveProgress(runId, results, extra = {}) {
    const passed = results.filter((r) => r.status === "pass").length;
    const failed = results.filter((r) => r.status === "fail").length;
    const completed = passed + failed;
    const status = extra.status || "running";
    const summary = extra.summary ?? buildSummary(results, status);
    const fields = [
      "results_json = ?",
      "completed_models = ?",
      "passed_count = ?",
      "failed_count = ?",
      "summary = ?",
    ];
    const args = [JSON.stringify(results), completed, passed, failed, summary];
    for (const [k, v] of Object.entries(extra)) {
      if (k === "summary") continue;
      fields.push(`${k} = ?`);
      args.push(v);
    }
    args.push(runId);
    db.prepare(`UPDATE basic_test_runs SET ${fields.join(", ")} WHERE id = ?`).run(...args);
  }

  async function executeBasicTestRun({
    runId,
    baseUrl,
    apiKey,
    protocol,
    modelsEndpoint,
    concurrency,
    results,
    targetIndexes,
    startedMs,
  }) {
    activeRuns.add(runId);
    let lastFlush = 0;
    let flushTimer = null;
    const flushNow = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      lastFlush = Date.now();
      saveProgress(runId, results, { status: "running", duration_ms: Date.now() - startedMs });
    };
    const scheduleFlush = () => {
      const now = Date.now();
      if (now - lastFlush >= 220) {
        flushNow();
      } else if (!flushTimer) {
        flushTimer = setTimeout(flushNow, 220);
      }
    };

    try {
      let cursor = 0;
      const workerCount = Math.max(1, Math.min(20, concurrency, targetIndexes.length));
      const worker = async () => {
        for (;;) {
          const pos = cursor++;
          if (pos >= targetIndexes.length) return;
          const idx = targetIndexes[pos];
          const model = results[idx].model;
          results[idx] = {
            ...results[idx],
            status: "running",
            reason: "正在发送连通测试请求…",
          };
          scheduleFlush();

          const out = await testSingleModel({
            baseUrl,
            apiKey,
            model,
            protocol,
            modelsEndpoint,
            fetchImpl,
          });
          results[idx] = out;
          scheduleFlush();
        }
      };

      if (workerCount > 0) {
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
      }
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      saveProgress(runId, results, {
        status: "done",
        finished_at: nowIso(),
        duration_ms: Date.now() - startedMs,
      });
    } catch (e) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      saveProgress(runId, results, {
        status: "error",
        summary: `连通测试执行异常：${redactSecret(e?.message || e, apiKey)}`,
        finished_at: nowIso(),
        duration_ms: Date.now() - startedMs,
      });
    } finally {
      activeRuns.delete(runId);
    }
  }

  // 供基础连通测试预览/筛选模型列表（支持同时复用 basic_test 与 verify 的已存 Key）
  app.post(
    "/api/verify/basic-fetch-models",
    wrap(async (req) => {
      const b = req.body || {};
      if (parseInt(b.account_id, 10) > 0) {
        if (!verifierApi?.resolveAccountContext) throw httpError(500, "账号解析服务未初始化");
        const ctx = await verifierApi.resolveAccountContext(
          parseInt(b.account_id, 10),
          str(b.api_key_override || b.api_key, 1000),
          { skipUpstream: true },
        );
        if (!ctx.supported) throw httpError(400, ctx.unsupported_reason);
        if (!ctx.has_sk) throw httpError(400, "该账号尚未配置可用 SK，请先填写测试 SK");
        return fetchUpstreamModels({
          baseUrl: ctx.base_url,
          apiKey: ctx.api_key,
          fetchImpl,
          timeoutMs: 20_000,
          httpError,
        });
      }
      const manualKey =
        str(b.api_key || b.api_key_override, 1000) || resolveAnyManualKey(b.source_run_id, b.base_url);
      return fetchUpstreamModels({
        baseUrl: b.base_url,
        apiKey: manualKey,
        fetchImpl,
        timeoutMs: 20_000,
        httpError,
      });
    }),
  );

  // 启动一次基础连通测试（未传 models 时自动拉取上游全部模型）
  app.post(
    "/api/verify/basic-runs",
    wrap(async (req) => {
      const b = req.body || {};
      const protocol = VALID_PROTOCOLS.has(b.protocol) ? b.protocol : "auto";
      const concurrency = Math.max(1, Math.min(20, parseInt(b.concurrency, 10) || 8));
      const isManual = b.mode === "manual" || (!parseInt(b.account_id, 10) && Boolean(b.base_url));

      let accountId = 0;
      let accountName = "";
      let baseUrl = "";
      let apiKey = "";
      let skSource = "";

      if (isManual) {
        baseUrl = normalizeUpstreamBase(str(b.base_url, 500));
        if (!/^https?:\/\/[^/\s]+/i.test(baseUrl)) {
          throw httpError(400, "请输入合法的上游站点 URL（需以 http:// 或 https:// 开头）");
        }
        apiKey = str(b.api_key || b.api_key_override, 1000);
        skSource = "manual";
        if (!apiKey && b.source_run_id) {
          apiKey = resolveAnyManualKey(b.source_run_id, baseUrl);
          if (apiKey) skSource = "saved_manual";
        }
        if (!apiKey) throw httpError(400, "请输入测试 API Key (SK)");
        let host = baseUrl;
        try {
          host = new URL(baseUrl).host;
        } catch {}
        accountName = str(b.target_name, 80) || `基础测试 (${host})`;
      } else {
        if (!verifierApi?.resolveAccountContext) {
          throw httpError(500, "账号解析服务未初始化");
        }
        accountId = parseInt(b.account_id, 10);
        const ctx = await verifierApi.resolveAccountContext(accountId, str(b.api_key_override, 1000), {
          skipUpstream: true,
        });
        if (!ctx.supported) throw httpError(400, ctx.unsupported_reason);
        if (!ctx.has_sk) throw httpError(400, "未能从该账号读取到 SK（api_key），请填写覆盖测试 SK 后重试");
        accountName = ctx.account.name;
        baseUrl = ctx.base_url;
        apiKey = ctx.api_key;
        skSource = ctx.sk_source;
      }

      let modelList = Array.isArray(b.models)
        ? [...new Set(b.models.map((x) => str(x, 150)).filter(Boolean))]
        : [];
      let modelsEndpoint = str(b.models_endpoint, 100);

      if (modelList.length === 0) {
        const fetched = await fetchUpstreamModels({
          baseUrl,
          apiKey,
          fetchImpl,
          timeoutMs: 20_000,
          httpError,
        });
        modelList = fetched.models.map((m) => m.id).filter(Boolean);
        modelsEndpoint = fetched.endpoint || "";
      }

      if (modelList.length === 0) {
        throw httpError(400, "未能从上游拉取到任何可用模型，请确认上游 /v1/models 接口或手动输入模型列表");
      }
      if (modelList.length > MAX_MODELS_PER_RUN) {
        modelList = modelList.slice(0, MAX_MODELS_PER_RUN);
      }

      const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const startedAt = nowIso();
      const results = modelList.map((m) => ({
        model: m,
        status: "pending",
        protocol_used: pickPrimaryProtocol(m, protocol, modelsEndpoint),
        fallback_used: false,
        http_status: null,
        latency_ms: null,
        reason: "排队等待中…",
        response_model: "",
        request_url: "",
        response_snippet: "",
      }));

      db.prepare(
        `INSERT INTO basic_test_runs
          (id, account_id, account_name, base_url, sk_masked, sk_source, protocol, models_endpoint, concurrency,
           status, total_models, completed_models, passed_count, failed_count, summary, results_json, started_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 0, 0, 0, ?, ?, ?, 0)`,
      ).run(
        runId,
        accountId,
        accountName,
        baseUrl,
        maskSecret(apiKey),
        skSource,
        protocol,
        modelsEndpoint,
        concurrency,
        results.length,
        buildSummary(results, "running"),
        JSON.stringify(results),
        startedAt,
      );

      if (isManual && apiKey) {
        q.saveManualKey.run(runId, apiKey, startedAt);
      }
      db.prepare(
        `DELETE FROM basic_test_runs WHERE id NOT IN (SELECT id FROM basic_test_runs ORDER BY started_at DESC LIMIT ${MAX_BASIC_RUNS})`,
      ).run();
      db.prepare("DELETE FROM basic_test_manual_keys WHERE run_id NOT IN (SELECT id FROM basic_test_runs)").run();

      const targetIndexes = results.map((_, idx) => idx);
      void executeBasicTestRun({
        runId,
        baseUrl,
        apiKey,
        protocol,
        modelsEndpoint,
        concurrency,
        results,
        targetIndexes,
        startedMs: Date.now(),
      });

      return basicRunView(q.run.get(runId), true, isManual && Boolean(apiKey));
    }),
  );

  // 原地重测本次记录中「不通」的模型，新测通的模型会自动合并到通的列表中
  app.post(
    "/api/verify/basic-runs/:id/retest-failed",
    wrap(async (req) => {
      const rid = str(req.params.id, 40);
      const row = q.run.get(rid);
      if (!row) throw httpError(404, "基础测试记录不存在");
      if (row.status === "running" || activeRuns.has(rid)) {
        throw httpError(409, "该测试正在运行中，请稍候完成后再重测");
      }
      const results = parseJsonSafe(row.results_json, []);
      const failedIndexes = [];
      for (let i = 0; i < results.length; i++) {
        if (results[i].status !== "pass") failedIndexes.push(i);
      }
      if (!failedIndexes.length) {
        return basicRunView(row, true, Boolean(q.manualKey.get(rid)));
      }

      let apiKey = str(req.body?.api_key, 1000);
      if (!apiKey) {
        if (row.account_id > 0 && verifierApi?.resolveAccountContext) {
          const ctx = await verifierApi.resolveAccountContext(row.account_id, "", { skipUpstream: true });
          apiKey = ctx.api_key || "";
        } else {
          apiKey = resolveBasicManualKey(rid, row.base_url);
        }
      }
      if (!apiKey) throw httpError(400, "未找到该记录对应的测试 API Key，请重新发起测试");

      for (const idx of failedIndexes) {
        results[idx] = {
          ...results[idx],
          status: "pending",
          http_status: null,
          latency_ms: null,
          reason: "等待重测…",
          response_snippet: "",
        };
      }
      const concurrency = Math.max(1, Math.min(20, parseInt(req.body?.concurrency, 10) || row.concurrency || 8));
      saveProgress(rid, results, {
        status: "running",
        finished_at: null,
        concurrency,
      });

      void executeBasicTestRun({
        runId: rid,
        baseUrl: row.base_url,
        apiKey,
        protocol: row.protocol || "auto",
        modelsEndpoint: row.models_endpoint || "",
        concurrency,
        results,
        targetIndexes: failedIndexes,
        startedMs: Date.now(),
      });

      return basicRunView(q.run.get(rid), true, Boolean(q.manualKey.get(rid)));
    }),
  );

  app.get(
    "/api/verify/basic-runs",
    wrap(async (req) => {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const savedSet = new Set(q.allManualKeyIds.all().map((x) => x.run_id));
      const rows = db.prepare(`SELECT * FROM basic_test_runs ORDER BY started_at DESC LIMIT ${limit}`).all();
      return rows.map((r) => basicRunView(r, false, savedSet.has(r.id)));
    }),
  );

  app.get(
    "/api/verify/basic-runs/:id",
    wrap(async (req) => {
      const row = q.run.get(str(req.params.id, 40));
      if (!row) throw httpError(404, "基础测试记录不存在");
      return basicRunView(row, true, Boolean(q.manualKey.get(row.id)));
    }),
  );

  app.delete(
    "/api/verify/basic-runs/:id",
    wrap(async (req) => {
      const rid = str(req.params.id, 40);
      db.prepare("DELETE FROM basic_test_runs WHERE id = ?").run(rid);
      q.delManualKey.run(rid);
      return { ok: true };
    }),
  );

  return {
    getManualRunKey: resolveBasicManualKey,
  };
}
