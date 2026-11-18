// 渠道鉴定（渠道真伪检测）：管理各上游渠道的方法论与特征探针，
// 按账号提取上游站点 + SK + 可用模型，直连上游站点逐项执行探针并实时产出检测报告。
// 存储：DATA_DIR/ops.db（node:sqlite），与 sub2api 解耦；只读模式下同样可用（不修改线上 sub2api）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const TIMEOUT_MS = 30_000;
const MAX_RUNS = 500;
const MAX_BODY_SNIPPET = 2500;
const PROTOCOLS = new Set(["gemini_native", "anthropic_messages", "openai_chat", "openai_responses"]);
const PROBE_KINDS = new Set(["baseline", "fingerprint"]);
const MATCH_MODES = new Set(["all", "any"]);
const CODE_RE = /^[a-z0-9_-]{2,40}$/;

const nowIso = () => new Date().toISOString();
const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);

export function maskSecret(k) {
  const s = String(k || "").trim();
  if (!s) return "";
  if (s.length <= 10) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

export function redactSecret(input, secret) {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  if (!secret || secret.length < 6) return text;
  let out = text.split(secret).join("<sk-redacted>");
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret && encoded.length >= 6) {
    out = out.split(encoded).join("<sk-redacted>");
  }
  return out;
}

const VERTEX_METHODOLOGY_MD = `### 鉴定原理（Vertex AI Gemini vs AI Studio / 套壳中转）

本方法论先发送一条极小基准请求确认连通性与可用性，随后连续发送 **6 项边界参数与跨系统权限探针**，捕获 Google Cloud **Vertex AI** 原生校验器特有的报错文案与响应特征：

1. **logprobs: true** — 在 \`generationConfig\` 开启 logprobs 探测（先发 \`responseLogprobs: true\`；若该模型支持则自动补发未带开关的 \`logprobs: 2\`），Vertex 会返回 \`400 Unable to submit request because Logprobs is not supported...\` 并附带 \`cloud.google.com/vertex-ai\` 文档链接。
2. **temperature: 5** — 超出范围触发 Vertex 特有边界文案 \`supported range is from 0 (inclusive) to 2.0001 (exclusive)\` + \`Update the value and try again.\`。
3. **top_p: 2** — 超出范围触发 \`topP value of 2 but the supported range is from 0 (inclusive) to 1 (inclusive)\`。
4. **max_tokens: -1** — 负数触发 \`maxOutputTokens value of -1 but the supported range is from 1 (inclusive) to 65537 (exclusive)\`。
5. **n: 9** — \`candidateCount: 9\` 触发 \`candidateCount value of 9 but the supported range is from 1 (inclusive) to 9 (exclusive)\`。
6. **AI Studio 文件地址** — 传入 \`https://generativelanguage.googleapis.com/v1beta/files/...\` 作为 \`fileData.fileUri\`，Vertex GCP 账户体系无法读取 AI Studio Files API 资源，固定返回 \`403 The caller does not have permission\`（而 AI Studio 原生接口通常返回 \`You do not have permission to access the File\`）。

> 若多项异常参数均返回 \`HTTP 200\`，说明上游中转层过滤/重置了 \`generationConfig\` 参数（非纯透传或存在套壳嫌疑）。`;

export const BUILTIN_CHANNELS = [
  {
    code: "ccmax",
    name: "ccmax",
    platform_hint: "anthropic",
    protocol: "anthropic_messages",
    sort_order: 1,
    builtin_version: 1,
    pass_ratio: 0.8,
    summary: "Claude Max 渠道真伪检测（待补充专属探针，当前已预留方法论配置位）",
    methodology_md: "### ccmax 检测方法论（待补充）\n\n请在后续更新探针规则，或点击「新增探针」在线配置请求载荷与特征正则。",
    probes: [],
  },
  {
    code: "az_gpt",
    name: "az gpt",
    platform_hint: "openai",
    protocol: "openai_chat",
    sort_order: 2,
    builtin_version: 1,
    pass_ratio: 0.8,
    summary: "Azure OpenAI (AZ GPT) 渠道真伪检测（待补充专属探针，当前已预留方法论配置位）",
    methodology_md: "### az gpt 检测方法论（待补充）\n\n后续可补充 Azure 特有部署错误、内容审查特征或响应头探针。",
    probes: [],
  },
  {
    code: "as_gemini",
    name: "as gemini",
    platform_hint: "gemini",
    protocol: "gemini_native",
    sort_order: 3,
    builtin_version: 1,
    pass_ratio: 0.8,
    summary: "AI Studio Gemini (AS Gemini) 渠道真伪检测（待补充专属探针，当前已预留方法论配置位）",
    methodology_md: "### as gemini 检测方法论（待补充）\n\n后续可补充 AI Studio Files API、参数范围校验等差异化探针。",
    probes: [],
  },
  {
    code: "vertex_gemini",
    name: "vertex gemini",
    platform_hint: "gemini",
    protocol: "gemini_native",
    sort_order: 4,
    builtin_version: 1,
    pass_ratio: 0.8,
    summary: "通过基准连通 + 6 项 Vertex AI 原生参数边界与跨端权限探针，鉴别是否为真实 Google Cloud Vertex Gemini。",
    methodology_md: VERTEX_METHODOLOGY_MD,
    probes: [
      {
        id: "vt_baseline",
        name: "基准连通性检查",
        kind: "baseline",
        enabled: true,
        request_desc: "发送最小 generateContent 请求（maxOutputTokens: 16），验证上游站点、SK 与模型真实可用",
        expect_desc: "HTTP 200 且返回合法 JSON（含 candidates / modelVersion）；若基准失败则终止指纹探针避免误判",
        request_body: {
          contents: [{ role: "user", parts: [{ text: "Reply with OK only." }] }],
          generationConfig: { maxOutputTokens: 16 },
        },
        fallback_on_200: null,
        expect_status: [200],
        match_mode: "any",
        must_match: [],
        strong_match: [],
        counter_match: [],
        pass_200_hint: "",
      },
      {
        id: "vt_logprobs",
        name: "logprobs: true",
        kind: "fingerprint",
        enabled: true,
        request_desc: "在 generationConfig 里传 responseLogprobs: true（若模型支持返回 200，则自动补发 logprobs: 2）",
        expect_desc: "返回 400 Unable to submit request because Logprobs is not supported for this model，并直接给出 Vertex AI 文档链接",
        request_body: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { responseLogprobs: true },
        },
        fallback_on_200: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { logprobs: 2 },
        },
        expect_status: [400],
        match_mode: "any",
        must_match: [
          "Unable to submit request because [Ll]ogprobs is not supported",
          "cloud\\.google\\.com/vertex-ai",
        ],
        strong_match: ["cloud\\.google\\.com/vertex-ai"],
        counter_match: [
          "Logprobs is not enabled for models/",
          "generativelanguage\\.googleapis\\.com",
        ],
        pass_200_hint: "两轮 logprobs 探测均返回 HTTP 200，说明中转层丢弃了 generationConfig 中的 logprobs 相关参数（非纯透传）",
      },
      {
        id: "vt_temperature",
        name: "temperature: 5",
        kind: "fingerprint",
        enabled: true,
        request_desc: "在 generationConfig 里设置 temperature: 5",
        expect_desc: "返回 Vertex 特有范围文案：supported range is from 0 (inclusive) to 2.0001 (exclusive) + Update the value and try again.",
        request_body: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { temperature: 5 },
        },
        fallback_on_200: null,
        expect_status: [400],
        match_mode: "all",
        must_match: [
          "supported range is from 0 \\(inclusive\\) to 2\\.0001 \\(exclusive\\)",
          "Update the value and try again",
        ],
        strong_match: ["2\\.0001 \\(exclusive\\)"],
        counter_match: ["\\[0\\.0,\\s*2\\.0\\]", "must be in \\[0", "less than or equal to 2"],
        pass_200_hint: "返回 HTTP 200，说明中转层截断/重置了超界 temperature: 5 参数，未原样透传",
      },
      {
        id: "vt_top_p",
        name: "top_p: 2",
        kind: "fingerprint",
        enabled: true,
        request_desc: "在 generationConfig 里设置 topP: 2",
        expect_desc: "返回 topP value of 2 but the supported range is from 0 (inclusive) to 1 (inclusive)",
        request_body: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { topP: 2 },
        },
        fallback_on_200: null,
        expect_status: [400],
        match_mode: "all",
        must_match: [
          "topP value of 2 but the supported range is from 0 \\(inclusive\\) to 1 \\(inclusive\\)",
        ],
        strong_match: [],
        counter_match: ["must be in \\[0\\.0,\\s*1\\.0\\]"],
        pass_200_hint: "返回 HTTP 200，说明中转层过滤/重置了超界 topP: 2 参数，未原样透传",
      },
      {
        id: "vt_max_tokens",
        name: "max_tokens: -1",
        kind: "fingerprint",
        enabled: true,
        request_desc: "在 generationConfig 里设置 maxOutputTokens: -1",
        expect_desc: "返回 maxOutputTokens value of -1 but the supported range is from 1 (inclusive) to 65537 (exclusive)",
        request_body: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: -1 },
        },
        fallback_on_200: null,
        expect_status: [400],
        match_mode: "any",
        must_match: [
          "maxOutputTokens value of -1 but the supported range is from 1 \\(inclusive\\) to 65537 \\(exclusive\\)",
          "maxOutputTokens value of -1 but the supported range is from 1 \\(inclusive\\) to \\d+ \\(exclusive\\)",
        ],
        strong_match: ["65537 \\(exclusive\\)"],
        counter_match: ["must be positive", "Invalid value at 'generation_config\\.max_output_tokens'"],
        pass_200_hint: "返回 HTTP 200，中转转换层可能忽略了 <=0 的 maxOutputTokens 而未原样透传",
      },
      {
        id: "vt_candidate_count",
        name: "n: 9",
        kind: "fingerprint",
        enabled: true,
        request_desc: "在 generationConfig 里设置 candidateCount: 9",
        expect_desc: "返回 candidateCount value of 9 but the supported range is from 1 (inclusive) to 9 (exclusive)",
        request_body: {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: { candidateCount: 9 },
        },
        fallback_on_200: null,
        expect_status: [400],
        match_mode: "any",
        must_match: [
          "candidateCount value of 9 but the supported range is from 1 \\(inclusive\\) to 9 \\(exclusive\\)",
          "candidateCount value of 9 but the supported range is from 1 \\(inclusive\\) to \\d+ \\(exclusive\\)",
        ],
        strong_match: ["1 \\(inclusive\\) to 9 \\(exclusive\\)"],
        counter_match: [],
        pass_200_hint: "返回 HTTP 200，说明中转层丢弃了 candidateCount: 9 参数，未原样透传",
      },
      {
        id: "vt_aistudio_file",
        name: "AI Studio 文件地址",
        kind: "fingerprint",
        enabled: true,
        request_desc: "用 https://generativelanguage.googleapis.com/v1beta/files/... 作为图片 URI 传入 fileData",
        expect_desc: "返回 403 The caller does not have permission（Vertex 账户体系读不到 AI Studio 的 Files API 资源）",
        request_body: {
          contents: [
            {
              role: "user",
              parts: [
                {
                  fileData: {
                    mimeType: "image/png",
                    fileUri: "https://generativelanguage.googleapis.com/v1beta/files/vtprobe9a8b7c6d5e4f",
                  },
                },
                { text: "Describe this image." },
              ],
            },
          ],
        },
        fallback_on_200: null,
        expect_status: [403],
        match_mode: "all",
        must_match: ["The caller does not have permission"],
        strong_match: ["The caller does not have permission"],
        counter_match: ["You do not have permission to access the File", "or it may not exist"],
        pass_200_hint: "返回 HTTP 200（未读取文件或忽略了 fileData 多模态块），存在严重套壳或丢弃多模态内容嫌疑",
      },
    ],
  },
  {
    code: "aws_bedrock",
    name: "aws bedrock",
    platform_hint: "anthropic",
    protocol: "anthropic_messages",
    sort_order: 5,
    builtin_version: 1,
    pass_ratio: 0.8,
    summary: "AWS Bedrock Claude 渠道真伪检测（待补充专属探针，当前已预留方法论配置位）",
    methodology_md: "### aws bedrock 检测方法论（待补充）\n\n后续可结合 `msg_bdrk_`、thinking signature 校验（S5/S6）与 Bedrock 响应头特征配置探针。",
    probes: [],
  },
  {
    code: "gpt_pool",
    name: "gpt号池",
    platform_hint: "openai",
    protocol: "openai_chat",
    sort_order: 6,
    builtin_version: 1,
    pass_ratio: 0.8,
    summary: "GPT 号池渠道真伪检测（待补充专属探针，当前已预留方法论配置位）",
    methodology_md: "### gpt号池 检测方法论（待补充）\n\n后续可补充号池模型、响应结构及错误特征探针。",
    probes: [],
  },
];

function normalizePatternList(raw, fieldName, httpError) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split("\n");
  const out = [];
  for (const item of arr) {
    const p = String(item ?? "").trim();
    if (!p) continue;
    try {
      new RegExp(p, "i");
    } catch (e) {
      const err = new Error(`${fieldName} 包含无效正则表达式「${p}」：${e.message}`);
      if (httpError) throw httpError(400, err.message);
      throw err;
    }
    out.push(p);
  }
  return out;
}

export function normalizeProbes(rawProbes, httpError) {
  if (!Array.isArray(rawProbes)) {
    const msg = "probes 必须是数组";
    throw httpError ? httpError(400, msg) : new Error(msg);
  }
  const seen = new Set();
  return rawProbes.map((raw, idx) => {
    const p = raw && typeof raw === "object" ? raw : {};
    const name = str(p.name, 100);
    if (!name) {
      const msg = `第 ${idx + 1} 条探针名称不能为空`;
      throw httpError ? httpError(400, msg) : new Error(msg);
    }
    let id = str(p.id, 60).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!id || seen.has(id)) id = `probe_${idx + 1}_${crypto.randomUUID().slice(0, 4)}`;
    seen.add(id);

    const kind = PROBE_KINDS.has(p.kind) ? p.kind : "fingerprint";
    const matchMode = MATCH_MODES.has(p.match_mode) ? p.match_mode : "all";
    const expectStatus = (Array.isArray(p.expect_status) ? p.expect_status : [p.expect_status])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 100 && n < 600);
    if (!expectStatus.length) expectStatus.push(kind === "baseline" ? 200 : 400);

    let requestBody = p.request_body;
    if (typeof requestBody === "string") {
      try {
        requestBody = JSON.parse(requestBody);
      } catch (e) {
        const msg = `探针「${name}」的 request_body 不是合法 JSON：${e.message}`;
        throw httpError ? httpError(400, msg) : new Error(msg);
      }
    }
    if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) {
      const msg = `探针「${name}」的 request_body 必须是 JSON 对象`;
      throw httpError ? httpError(400, msg) : new Error(msg);
    }

    let fallbackOn200 = p.fallback_on_200 ?? null;
    if (typeof fallbackOn200 === "string") {
      const trimmed = fallbackOn200.trim();
      if (!trimmed) fallbackOn200 = null;
      else {
        try {
          fallbackOn200 = JSON.parse(trimmed);
        } catch (e) {
          const msg = `探针「${name}」的 fallback_on_200 不是合法 JSON：${e.message}`;
          throw httpError ? httpError(400, msg) : new Error(msg);
        }
      }
    }
    if (fallbackOn200 !== null && (typeof fallbackOn200 !== "object" || Array.isArray(fallbackOn200))) {
      const msg = `探针「${name}」的 fallback_on_200 必须是 JSON 对象或留空`;
      throw httpError ? httpError(400, msg) : new Error(msg);
    }

    return {
      id,
      name,
      kind,
      enabled: p.enabled !== false,
      request_desc: str(p.request_desc, 400),
      expect_desc: str(p.expect_desc, 400),
      request_body: requestBody,
      fallback_on_200: fallbackOn200,
      expect_status: expectStatus,
      match_mode: matchMode,
      must_match: normalizePatternList(p.must_match, `探针「${name}」必中特征`, httpError),
      strong_match: normalizePatternList(p.strong_match, `探针「${name}」强特征`, httpError),
      counter_match: normalizePatternList(p.counter_match, `探针「${name}」反例特征`, httpError),
      pass_200_hint: str(p.pass_200_hint, 300),
    };
  });
}

export function buildProbeHttpRequest({ baseUrl, apiKey, protocol, model, body }) {
  const cleanBase = String(baseUrl || "").trim().replace(/\/+$/, "");
  const cleanModel = String(model || "").trim().replace(/^models\//i, "");
  if (!cleanBase) throw new Error("缺少站点地址 base_url");
  if (!cleanModel) throw new Error("缺少测试模型 model");

  if (protocol === "gemini_native") {
    const hasVer = /\/(v1beta|v1|publishers\/google)$/i.test(cleanBase);
    const prefix = hasVer ? cleanBase : `${cleanBase}/v1beta`;
    return {
      url: `${prefix}/models/${encodeURIComponent(cleanModel)}:generateContent`,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-goog-api-key": apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      body: body ?? {},
    };
  }
  if (protocol === "anthropic_messages") {
    const url = /\/messages$/i.test(cleanBase)
      ? cleanBase
      : /\/v1$/i.test(cleanBase)
        ? `${cleanBase}/messages`
        : `${cleanBase}/v1/messages`;
    return {
      url,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-api-key": apiKey,
        Authorization: `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
      },
      body: { model: cleanModel, ...(body ?? {}) },
    };
  }
  if (protocol === "openai_responses") {
    const url = /\/responses$/i.test(cleanBase)
      ? cleanBase
      : /\/v1$/i.test(cleanBase)
        ? `${cleanBase}/responses`
        : `${cleanBase}/v1/responses`;
    return {
      url,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "api-key": apiKey,
      },
      body: { model: cleanModel, ...(body ?? {}) },
    };
  }
  // openai_chat
  const url = /\/chat\/completions$/i.test(cleanBase)
    ? cleanBase
    : /\/v1$/i.test(cleanBase)
      ? `${cleanBase}/chat/completions`
      : `${cleanBase}/v1/chat/completions`;
  return {
    url,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "api-key": apiKey,
    },
    body: { model: cleanModel, ...(body ?? {}) },
  };
}

export function normalizeUpstreamBase(raw) {
  return String(raw || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|messages|responses|models)$/i, "");
}

function extractModelsFromPayload(json) {
  if (!json || typeof json !== "object") return null;
  let items = null;
  if (Array.isArray(json.data)) items = json.data;
  else if (Array.isArray(json.models)) items = json.models;
  else if (Array.isArray(json)) items = json;
  if (!items) return null;

  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (item && typeof item === "object" && Array.isArray(item.supportedGenerationMethods) && item.supportedGenerationMethods.length > 0) {
      if (!item.supportedGenerationMethods.includes("generateContent")) continue;
    }
    const rawId = typeof item === "string" ? item : item?.id || item?.name;
    const id = str(rawId, 150).replace(/^models\//i, "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export async function fetchUpstreamModels({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 15_000, httpError }) {
  const err = (status, msg) => (httpError ? httpError(status, msg) : Object.assign(new Error(msg), { status }));
  const cleanBase = normalizeUpstreamBase(baseUrl);
  if (!/^https?:\/\/[^/\s]+/i.test(cleanBase)) throw err(400, "上游站点 URL 需以 http:// 或 https:// 开头");
  const key = str(apiKey, 1000);
  if (!key) throw err(400, "请先提供 API Key 再获取上游模型");

  const rootNoVer = cleanBase.replace(/\/(v1beta|v1)$/i, "");
  const isV1Beta = /\/v1beta$/i.test(cleanBase);
  const candidates = [];
  const addCand = (url, tag, kind) => {
    if (!candidates.some((c) => c.url === url)) candidates.push({ url, tag, kind });
  };

  if (isV1Beta) {
    addCand(`${cleanBase}/models`, "/v1beta/models", "gemini");
    addCand(`${rootNoVer}/v1/models`, "/v1/models", "openai");
  } else {
    addCand(`${rootNoVer}/v1/models`, "/v1/models", "openai");
    addCand(`${rootNoVer}/v1beta/models`, "/v1beta/models", "gemini");
    if (cleanBase !== rootNoVer && !/\/v1$/i.test(cleanBase)) {
      addCand(`${cleanBase}/models`, "/models", "openai");
    }
  }

  let authFailed = false;
  let lastError = "";
  for (const c of candidates) {
    const headers =
      c.kind === "gemini"
        ? { Accept: "application/json", "x-goog-api-key": key, Authorization: `Bearer ${key}` }
        : {
            Accept: "application/json",
            Authorization: `Bearer ${key}`,
            "x-api-key": key,
            "api-key": key,
            "anthropic-version": "2023-06-01",
          };
    try {
      const res = await fetchImpl(c.url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      const json = parseJsonSafe(text, null);
      if (res.status === 401 || res.status === 403) {
        authFailed = true;
        lastError = `HTTP ${res.status} ${redactSecret(extractResponseMessage(json, text), key).slice(0, 120)}`;
        continue;
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status} ${redactSecret(extractResponseMessage(json, text), key).slice(0, 120)}`;
        continue;
      }
      const ids = extractModelsFromPayload(json);
      if (ids && ids.length > 0) {
        ids.sort((a, b) => a.localeCompare(b));
        return {
          models: ids.map((id) => ({ id, requested: id, label: id, source: c.tag })),
          endpoint: c.tag,
          count: ids.length,
        };
      }
      if (ids && ids.length === 0) {
        lastError = `${c.tag} 返回模型列表为空`;
      } else {
        lastError = `${c.tag} 返回格式不是标准的模型列表`;
      }
    } catch (e) {
      const aborted = e?.name === "TimeoutError" || e?.name === "AbortError";
      lastError = aborted ? "请求超时" : redactSecret(e?.cause?.message || e?.message || e, key);
    }
  }

  if (authFailed) throw err(400, "上游鉴权失败（HTTP 401/403），请检查 URL 或 API Key");
  throw err(502, `获取上游模型失败：${lastError || "接口无响应"}（仍可手动输入模型名称）`);
}

function testPatterns(patterns, text) {
  const matched = [];
  const missed = [];
  for (const raw of patterns || []) {
    try {
      const re = new RegExp(raw, "i");
      if (re.test(text)) matched.push(raw);
      else missed.push(raw);
    } catch {
      missed.push(raw);
    }
  }
  return { matched, missed };
}

function extractResponseMessage(json, rawText) {
  if (!json || typeof json !== "object") return rawText;
  const err = json.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && err.message) return String(err.message);
  if (json.message) return String(json.message);
  return rawText;
}

function summarizeBaseline(json, protocol) {
  if (!json || typeof json !== "object") return [];
  const tags = [];
  if (protocol === "gemini_native") {
    if (json.modelVersion) tags.push(`modelVersion=${json.modelVersion}`);
    const finish = json.candidates?.[0]?.finishReason;
    if (finish) tags.push(`finishReason=${finish}`);
    const tt = json.usageMetadata?.trafficType;
    if (tt) tags.push(`trafficType=${tt}`);
  } else {
    if (json.model) tags.push(`model=${json.model}`);
    if (json.id) tags.push(`id=${String(json.id).slice(0, 24)}`);
  }
  return tags;
}

export function evaluateProbeResponse({ probe, protocol, httpStatus, json, rawText }) {
  const textForMatch = String(rawText || "");
  if (probe.kind === "baseline") {
    const ok200 = httpStatus === 200;
    const hasShape =
      protocol === "gemini_native"
        ? Boolean(json && (Array.isArray(json.candidates) || json.modelVersion))
        : Boolean(json && (json.id || json.choices || json.content || json.output));
    if (ok200 && hasShape) {
      const tags = summarizeBaseline(json, protocol);
      return {
        status: "pass",
        strong_hit: false,
        counter_hit: false,
        param_stripped: false,
        status_rewritten: false,
        matched_patterns: [],
        reason: `基准连通正常（HTTP 200${tags.length ? ` · ${tags.join(" · ")}` : ""}）`,
      };
    }
    const errMsg = extractResponseMessage(json, textForMatch).slice(0, 180);
    return {
      status: "fail",
      strong_hit: false,
      counter_hit: false,
      param_stripped: false,
      status_rewritten: false,
      matched_patterns: [],
      reason: httpStatus === 200
        ? `HTTP 200 但响应结构异常：${errMsg || "非预期 JSON"}`
        : `基准请求失败（HTTP ${httpStatus || 0}）：${errMsg || "无响应"}`,
    };
  }

  // 指纹探针：先判反例特征
  const counter = testPatterns(probe.counter_match, textForMatch);
  if (counter.matched.length > 0) {
    return {
      status: "fail",
      strong_hit: false,
      counter_hit: true,
      param_stripped: false,
      status_rewritten: false,
      matched_patterns: counter.matched,
      reason: `命中非目标渠道反例特征：${counter.matched.join(" / ")}`,
    };
  }

  const must = testPatterns(probe.must_match, textForMatch);
  const strong = testPatterns(probe.strong_match, textForMatch);
  const mustSatisfied =
    probe.must_match.length === 0
      ? probe.expect_status.includes(httpStatus)
      : probe.match_mode === "any"
        ? must.matched.length > 0
        : must.missed.length === 0;

  if (mustSatisfied) {
    const statusOk = probe.expect_status.includes(httpStatus);
    const strongTag = strong.matched.length ? "（含强特征）" : "";
    const statusNote = statusOk
      ? `HTTP ${httpStatus}`
      : `特征文本命中，但状态码被中转改写为 HTTP ${httpStatus}（期望 ${probe.expect_status.join("/")}）`;
    return {
      status: "pass",
      strong_hit: strong.matched.length > 0,
      counter_hit: false,
      param_stripped: false,
      status_rewritten: !statusOk,
      matched_patterns: must.matched,
      reason: `命中特征${strongTag} · ${statusNote}`,
    };
  }

  if (httpStatus === 200) {
    return {
      status: "fail",
      strong_hit: false,
      counter_hit: false,
      param_stripped: true,
      status_rewritten: false,
      matched_patterns: [],
      reason: probe.pass_200_hint || "期望触发参数校验错误，但上游返回 HTTP 200（可能被中转吞掉参数）",
    };
  }

  const errMsg = extractResponseMessage(json, textForMatch).slice(0, 180);
  return {
    status: "fail",
    strong_hit: false,
    counter_hit: false,
    param_stripped: false,
    status_rewritten: false,
    matched_patterns: [],
    reason: `未命中目标特征（HTTP ${httpStatus || 0}）：${errMsg || "无错误信息"}`,
  };
}

export function computeRunVerdict({ steps, passRatio = 0.8, channelName }) {
  const baseline = steps.find((s) => s.kind === "baseline");
  if (baseline && baseline.status === "fail") {
    return {
      verdict: "inconclusive",
      score: 0,
      matched_count: 0,
      total_probes: steps.filter((s) => s.kind !== "baseline").length,
      summary: `基准连通性检查失败（${baseline.reason}），无法安全判定 ${channelName} 真伪，请先检查上游站点、SK 或模型是否可用。`,
    };
  }

  const fpSteps = steps.filter((s) => s.kind !== "baseline");
  const total = fpSteps.length;
  if (!total) {
    return {
      verdict: "inconclusive",
      score: 0,
      matched_count: 0,
      total_probes: 0,
      summary: `渠道「${channelName}」尚未配置指纹探针，无法完成真伪鉴定。`,
    };
  }

  const matched = fpSteps.filter((s) => s.status === "pass").length;
  const counterHit = fpSteps.filter((s) => s.counter_hit);
  const stripped = fpSteps.filter((s) => s.param_stripped);
  const ratio = matched / total;
  const score = Math.round(ratio * 100);

  if (counterHit.length > 0) {
    return {
      verdict: "fake",
      score,
      matched_count: matched,
      total_probes: total,
      summary: `判定为假（检出非目标渠道特征）：「${counterHit.map((s) => s.name).join("、")}」命中反例特征，实际疑似为其他上游渠道伪装。共命中 ${matched}/${total} 项特征。`,
    };
  }

  if (ratio >= passRatio) {
    const rewrittenCount = fpSteps.filter((s) => s.status === "pass" && s.status_rewritten).length;
    const rewriteNote = rewrittenCount ? `（其中 ${rewrittenCount} 项 HTTP 状态码被中转改写，但原生报错指纹完整保留）` : "";
    return {
      verdict: "authentic",
      score,
      matched_count: matched,
      total_probes: total,
      summary: `判定为真（官方特征吻合）：${matched}/${total} 项特征探针全部符合 ${channelName} 原生行为${rewriteNote}。`,
    };
  }

  if (matched >= 2) {
    const stripNote = stripped.length ? `；「${stripped.map((s) => s.name).join("、")}」返回 200 疑似被中转过滤参数` : "";
    return {
      verdict: "suspicious",
      score,
      matched_count: matched,
      total_probes: total,
      summary: `判定为疑似 / 非纯透传：命中 ${matched}/${total} 项特征（未达通过阈值 ${Math.round(passRatio * 100)}%）${stripNote}，建议结合详情中的原始报错文本人工复核。`,
    };
  }

  const stripNote = stripped.length ? `，其中 ${stripped.length} 项异常参数返回 HTTP 200（存在吞参数/套壳转换嫌疑）` : "";
  return {
    verdict: "fake",
    score,
    matched_count: matched,
    total_probes: total,
    summary: `判定为假（特征不符）：仅命中 ${matched}/${total} 项 ${channelName} 指纹特征${stripNote}。`,
  };
}

function parseJsonSafe(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function openVerifyDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "ops.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS verify_channels (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform_hint TEXT NOT NULL DEFAULT '',
      protocol TEXT NOT NULL DEFAULT 'gemini_native',
      summary TEXT NOT NULL DEFAULT '',
      methodology_md TEXT NOT NULL DEFAULT '',
      pass_ratio REAL NOT NULL DEFAULT 0.8,
      probes_json TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      builtin_version INTEGER NOT NULL DEFAULT 1,
      customized INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verify_account_keys (
      account_id INTEGER PRIMARY KEY,
      api_key TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verify_runs (
      id TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL,
      account_name TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL,
      sk_masked TEXT NOT NULL,
      sk_source TEXT NOT NULL DEFAULT '',
      channel_code TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      methodology_version INTEGER NOT NULL DEFAULT 1,
      model TEXT NOT NULL,
      requested_model TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      verdict TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      matched_count INTEGER NOT NULL DEFAULT 0,
      total_probes INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_verify_runs_started ON verify_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_verify_runs_account ON verify_runs(account_id, started_at DESC);
  `);

  const findCh = db.prepare("SELECT * FROM verify_channels WHERE code = ?");
  const insertCh = db.prepare(`
    INSERT INTO verify_channels
      (code, name, platform_hint, protocol, summary, methodology_md, pass_ratio, probes_json, version, is_builtin, builtin_version, customized, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 0, ?, ?, ?)
  `);
  const upgradeCh = db.prepare(`
    UPDATE verify_channels
       SET name = ?, platform_hint = ?, protocol = ?, summary = ?, methodology_md = ?, pass_ratio = ?,
           probes_json = ?, version = version + 1, builtin_version = ?, sort_order = ?, updated_at = ?
     WHERE code = ?
  `);

  const t = nowIso();
  for (const ch of BUILTIN_CHANNELS) {
    const existing = findCh.get(ch.code);
    const probesJson = JSON.stringify(ch.probes);
    if (!existing) {
      insertCh.run(
        ch.code,
        ch.name,
        ch.platform_hint,
        ch.protocol,
        ch.summary,
        ch.methodology_md,
        ch.pass_ratio,
        probesJson,
        ch.builtin_version,
        ch.sort_order,
        t,
        t,
      );
    } else if (!existing.customized && existing.builtin_version < ch.builtin_version) {
      upgradeCh.run(
        ch.name,
        ch.platform_hint,
        ch.protocol,
        ch.summary,
        ch.methodology_md,
        ch.pass_ratio,
        probesJson,
        ch.builtin_version,
        ch.sort_order,
        t,
        ch.code,
      );
    }
  }
  return db;
}

function channelView(row) {
  const probes = parseJsonSafe(row.probes_json, []);
  const fpCount = probes.filter((p) => p.kind !== "baseline" && p.enabled !== false).length;
  return {
    code: row.code,
    name: row.name,
    platform_hint: row.platform_hint,
    protocol: row.protocol,
    summary: row.summary,
    methodology_md: row.methodology_md,
    pass_ratio: Number(row.pass_ratio),
    probes,
    probe_count: probes.length,
    enabled_probe_count: probes.filter((p) => p.enabled !== false).length,
    fingerprint_count: fpCount,
    ready: fpCount > 0,
    version: row.version,
    is_builtin: !!row.is_builtin,
    builtin_version: row.builtin_version,
    customized: !!row.customized,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function runView(row, includeSteps = true) {
  const steps = parseJsonSafe(row.steps_json, []);
  const out = {
    id: row.id,
    account_id: row.account_id,
    account_name: row.account_name,
    platform: row.platform,
    base_url: row.base_url,
    sk_masked: row.sk_masked,
    sk_source: row.sk_source,
    channel_code: row.channel_code,
    channel_name: row.channel_name,
    methodology_version: row.methodology_version,
    model: row.model,
    requested_model: row.requested_model,
    status: row.status,
    verdict: row.verdict,
    score: row.score,
    matched_count: row.matched_count,
    total_probes: row.total_probes,
    summary: row.summary,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
  };
  if (includeSteps) out.steps = steps;
  return out;
}

function parseCredsObject(raw) {
  if (!raw) return {};
  if (typeof raw === "string") return parseJsonSafe(raw, {});
  return typeof raw === "object" ? raw : {};
}

export function registerVerifier({ app, wrap, httpError, dataDir, s2, pool, getAccounts, detector, fetchImpl = fetch }) {
  const db = openVerifyDb(dataDir);
  const q = {
    allChannels: db.prepare("SELECT * FROM verify_channels ORDER BY sort_order ASC, created_at ASC"),
    channel: db.prepare("SELECT * FROM verify_channels WHERE code = ?"),
    savedKey: db.prepare("SELECT api_key FROM verify_account_keys WHERE account_id = ?"),
    run: db.prepare("SELECT * FROM verify_runs WHERE id = ?"),
  };
  const mustChannel = (code) => {
    const row = q.channel.get(str(code, 50));
    if (!row) throw httpError(404, "渠道类型不存在");
    return row;
  };

  async function resolveAccountContext(accountId, apiKeyOverride = "") {
    if (!Number.isInteger(accountId) || accountId <= 0) throw httpError(400, "账号 ID 无效");
    const [accounts, full] = await Promise.all([
      getAccounts().catch(() => []),
      s2("GET", `/admin/accounts/${accountId}`),
    ]);
    if (!full) throw httpError(404, "账号不存在");
    const listItem = accounts.find((a) => a.id === accountId);
    const creds = parseCredsObject(full.credentials);
    const baseUrl = normalizeUpstreamBase(str(creds.base_url, 500));
    const mapping = creds.model_mapping && typeof creds.model_mapping === "object" ? creds.model_mapping : {};

    // 多级读取明文 SK（绝不回传前端，只用于后端向供应商站点发起检测）
    let apiKey = str(apiKeyOverride, 1000);
    let skSource = apiKey ? "manual" : "";
    if (!apiKey) {
      const saved = q.savedKey.get(accountId);
      if (saved?.api_key) {
        apiKey = saved.api_key;
        skSource = "saved_key";
      }
    }
    if (!apiKey && pool) {
      try {
        const { rows } = await pool.query("SELECT credentials FROM accounts WHERE id = $1", [accountId]);
        const dbCreds = parseCredsObject(rows?.[0]?.credentials);
        if (dbCreds.api_key) {
          apiKey = String(dbCreds.api_key).trim();
          skSource = "db";
        }
      } catch {}
    }
    if (!apiKey) {
      try {
        const exported = await s2("GET", `/admin/accounts/data?ids=${accountId}`);
        const list = Array.isArray(exported)
          ? exported
          : Array.isArray(exported?.accounts)
            ? exported.accounts
            : Array.isArray(exported?.items)
              ? exported.items
              : [];
        const matched = list.find((item) => Number(item.id) === accountId) || list[0];
        const expCreds = parseCredsObject(matched?.credentials);
        if (expCreds.api_key) {
          apiKey = String(expCreds.api_key).trim();
          skSource = "s2_export";
        }
      } catch {}
    }
    if (!apiKey && detector?.getKey) {
      const dk = detector.getKey(accountId);
      if (dk) {
        apiKey = dk;
        skSource = "detect_key";
      }
    }
    if (!apiKey && baseUrl) {
      try {
        const origin = new URL(baseUrl).origin.toLowerCase();
        for (const table of ["supplier_monitors", "supplier_wallets"]) {
          try {
            const rows = db
              .prepare(`SELECT base_url, api_key FROM ${table} WHERE api_key != '' ORDER BY id DESC`)
              .all();
            const hit = rows.find((r) => {
              try {
                return new URL(String(r.base_url || "").trim()).origin.toLowerCase() === origin;
              } catch {
                return false;
              }
            });
            if (hit?.api_key) {
              apiKey = String(hit.api_key).trim();
              skSource = "supplier_monitor";
              break;
            }
          } catch {}
        }
      } catch {}
    }

    // 聚合账号可用模型（模型映射 > 上游标准模型接口 > sub2api 账号模型接口 > 近 7 日日志）
    const [upstreamRes, s2Models, recentLogs] = await Promise.all([
      baseUrl && apiKey
        ? fetchUpstreamModels({ baseUrl, apiKey, fetchImpl, timeoutMs: 8000 }).catch(() => null)
        : Promise.resolve(null),
      s2("GET", `/admin/accounts/${accountId}/models`).catch(() => []),
      pool
        ? pool
            .query(
              `SELECT DISTINCT coalesce(nullif(btrim(upstream_model), ''), model) AS m
                 FROM usage_logs
                WHERE account_id = $1 AND created_at >= now() - interval '7 days'
                LIMIT 20`,
              [accountId],
            )
            .then((r) => r.rows.map((x) => x.m).filter(Boolean))
            .catch(() => [])
        : Promise.resolve([]),
    ]);

    const modelMap = new Map();
    const pushModel = (id, requested, source) => {
      const up = str(id, 150);
      if (!up) return;
      const req = str(requested || up, 150);
      const key = `${up}::${req}`;
      if (!modelMap.has(key)) {
        modelMap.set(key, {
          id: up,
          requested: req,
          label: req === up ? up : `${up}（映射自 ${req}）`,
          source,
        });
      }
    };
    for (const [reqName, upName] of Object.entries(mapping)) {
      pushModel(upName || reqName, reqName, "模型映射");
    }
    for (const m of upstreamRes?.models ?? []) {
      pushModel(m.id, m.id, "上游模型");
    }
    for (const item of Array.isArray(s2Models) ? s2Models : []) {
      const rawId = typeof item === "string" ? item : item?.id || item?.name;
      if (!rawId) continue;
      pushModel(mapping[rawId] || rawId, rawId, "账号模型");
    }
    for (const m of recentLogs) {
      pushModel(mapping[m] || m, m, "近7日调用");
    }

    return {
      account: {
        id: full.id || accountId,
        name: full.name || listItem?.name || `#${accountId}`,
        platform: full.platform || listItem?.platform || "",
        type: full.type || listItem?.type || "",
        status: full.status || listItem?.status || "",
        notes: full.notes ?? listItem?.notes ?? "",
        group_ids: full.group_ids || listItem?.group_ids || [],
      },
      base_url: baseUrl,
      supported: Boolean(baseUrl),
      unsupported_reason: baseUrl ? "" : "该账号在 sub2api 里没有 base_url（非 apikey 上游中转类型暂不支持）",
      api_key: apiKey,
      has_sk: Boolean(apiKey),
      sk_masked: maskSecret(apiKey),
      sk_source: skSource,
      model_mapping: mapping,
      models: [...modelMap.values()],
    };
  }

  async function sendProbeOnce({ baseUrl, apiKey, protocol, model, body }) {
    const reqSpec = buildProbeHttpRequest({ baseUrl, apiKey, protocol, model, body });
    const started = Date.now();
    let res;
    let rawText = "";
    let headers = {};
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
      try {
        res = await fetchImpl(reqSpec.url, {
          method: "POST",
          headers: reqSpec.headers,
          body: JSON.stringify(reqSpec.body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        headers = Object.fromEntries(res.headers.entries());
        rawText = await res.text();
        if (res.status !== 429) break;
      } catch (e) {
        const aborted = e?.name === "TimeoutError" || e?.name === "AbortError";
        const msg = aborted ? `请求超时 (>${TIMEOUT_MS / 1000}s)` : redactSecret(e?.cause?.message || e?.message || e, apiKey);
        return {
          url: redactSecret(reqSpec.url, apiKey),
          request_body: reqSpec.body,
          http_status: 0,
          headers: {},
          raw_text: msg,
          snippet: msg.slice(0, MAX_BODY_SNIPPET),
          json: null,
          latency_ms: Date.now() - started,
          network_error: msg,
        };
      }
    }
    const json = parseJsonSafe(rawText, null);
    const sanitizedText = redactSecret(rawText, apiKey);
    const keepHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (/^(content-type|server|via|cf-ray|x-request-id|x-goog-|x-amzn-|x-amz-|anthropic-)/i.test(k)) {
        keepHeaders[k] = redactSecret(v, apiKey);
      }
    }
    return {
      url: redactSecret(reqSpec.url, apiKey),
      request_body: reqSpec.body,
      http_status: res.status,
      headers: keepHeaders,
      raw_text: sanitizedText,
      snippet: sanitizedText.slice(0, MAX_BODY_SNIPPET),
      json,
      latency_ms: Date.now() - started,
      network_error: "",
    };
  }

  function saveRunSteps(runId, steps, extra = {}) {
    const fields = ["steps_json = ?"];
    const args = [JSON.stringify(steps)];
    for (const [k, v] of Object.entries(extra)) {
      fields.push(`${k} = ?`);
      args.push(v);
    }
    args.push(runId);
    db.prepare(`UPDATE verify_runs SET ${fields.join(", ")} WHERE id = ?`).run(...args);
  }

  async function executeVerifyRun({ runId, ctx, channel, model }) {
    const startedMs = Date.now();
    const enabledProbes = channel.probes.filter((p) => p.enabled !== false);
    const steps = enabledProbes.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      request_desc: p.request_desc,
      expect_desc: p.expect_desc,
      expect_status: p.expect_status,
      match_mode: p.match_mode,
      must_match: p.must_match,
      strong_match: p.strong_match,
      counter_match: p.counter_match,
      status: "pending",
      http_status: null,
      latency_ms: null,
      reason: "",
      strong_hit: false,
      counter_hit: false,
      param_stripped: false,
      status_rewritten: false,
      matched_patterns: [],
      request_url: "",
      request_body: p.request_body,
      response_headers: {},
      response_snippet: "",
      fallback_used: false,
    }));
    saveRunSteps(runId, steps);

    let abortRemaining = false;
    try {
      for (let i = 0; i < enabledProbes.length; i++) {
        const probe = enabledProbes[i];
        if (abortRemaining) {
          steps[i].status = "skip";
          steps[i].reason = "基准连通性失败，跳过该探针";
          saveRunSteps(runId, steps);
          continue;
        }
        steps[i].status = "running";
        saveRunSteps(runId, steps);

        let attemptRes = await sendProbeOnce({
          baseUrl: ctx.base_url,
          apiKey: ctx.api_key,
          protocol: channel.protocol,
          model,
          body: probe.request_body,
        });
        let usedFallback = false;
        if (probe.kind === "fingerprint" && attemptRes.http_status === 200 && probe.fallback_on_200) {
          usedFallback = true;
          attemptRes = await sendProbeOnce({
            baseUrl: ctx.base_url,
            apiKey: ctx.api_key,
            protocol: channel.protocol,
            model,
            body: probe.fallback_on_200,
          });
        }

        const evalRes = evaluateProbeResponse({
          probe,
          protocol: channel.protocol,
          httpStatus: attemptRes.http_status,
          json: attemptRes.json,
          rawText: attemptRes.raw_text,
        });

        steps[i] = {
          ...steps[i],
          status: evalRes.status,
          http_status: attemptRes.http_status,
          latency_ms: attemptRes.latency_ms,
          reason: usedFallback
            ? `首次请求返回 HTTP 200（模型支持该开关），已自动补发校验请求：${evalRes.reason}`
            : evalRes.reason,
          strong_hit: evalRes.strong_hit,
          counter_hit: evalRes.counter_hit,
          param_stripped: evalRes.param_stripped,
          status_rewritten: evalRes.status_rewritten,
          matched_patterns: evalRes.matched_patterns,
          request_url: attemptRes.url,
          request_body: attemptRes.request_body,
          response_headers: attemptRes.headers,
          response_snippet: attemptRes.snippet,
          fallback_used: usedFallback,
        };
        if (probe.kind === "baseline" && evalRes.status === "fail") abortRemaining = true;
        saveRunSteps(runId, steps);
      }

      const final = computeRunVerdict({
        steps,
        passRatio: channel.pass_ratio,
        channelName: channel.name,
      });
      saveRunSteps(runId, steps, {
        status: "done",
        verdict: final.verdict,
        score: final.score,
        matched_count: final.matched_count,
        total_probes: final.total_probes,
        summary: final.summary,
        finished_at: nowIso(),
        duration_ms: Date.now() - startedMs,
      });
    } catch (e) {
      saveRunSteps(runId, steps, {
        status: "error",
        verdict: "inconclusive",
        summary: `检测执行异常：${redactSecret(e?.message || e, ctx.api_key)}`,
        finished_at: nowIso(),
        duration_ms: Date.now() - startedMs,
      });
    }
  }

  // ---------- 渠道与方法论路由 ----------
  app.get("/api/verify/channels", wrap(async () => q.allChannels.all().map(channelView)));

  app.get(
    "/api/verify/channels/:code",
    wrap(async (req) => channelView(mustChannel(req.params.code))),
  );

  app.post(
    "/api/verify/channels",
    wrap(async (req) => {
      const b = req.body || {};
      const code = str(b.code, 40).toLowerCase();
      if (!CODE_RE.test(code)) throw httpError(400, "渠道编码仅支持 2-40 位小写字母、数字、下划线或短横线");
      if (q.channel.get(code)) throw httpError(409, `渠道编码「${code}」已存在`);
      const name = str(b.name, 60);
      if (!name) throw httpError(400, "渠道名称必填");
      const protocol = PROTOCOLS.has(b.protocol) ? b.protocol : "gemini_native";
      const passRatio = b.pass_ratio == null ? 0.8 : Math.min(1, Math.max(0.1, Number(b.pass_ratio) || 0.8));
      const probes = normalizeProbes(Array.isArray(b.probes) ? b.probes : [], httpError);
      const maxOrder = db.prepare("SELECT coalesce(max(sort_order), 0) AS m FROM verify_channels").get()?.m || 0;
      const t = nowIso();
      db.prepare(
        `INSERT INTO verify_channels
          (code, name, platform_hint, protocol, summary, methodology_md, pass_ratio, probes_json, version, is_builtin, builtin_version, customized, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 1, ?, ?, ?)`,
      ).run(
        code,
        name,
        str(b.platform_hint, 30),
        protocol,
        str(b.summary, 300),
        String(b.methodology_md ?? "").slice(0, 20000),
        passRatio,
        JSON.stringify(probes),
        maxOrder + 1,
        t,
        t,
      );
      return channelView(q.channel.get(code));
    }),
  );

  app.put(
    "/api/verify/channels/:code",
    wrap(async (req) => {
      const cur = mustChannel(req.params.code);
      const b = req.body || {};
      const name = "name" in b ? str(b.name, 60) : cur.name;
      if (!name) throw httpError(400, "渠道名称必填");
      const platformHint = "platform_hint" in b ? str(b.platform_hint, 30) : cur.platform_hint;
      const protocol = "protocol" in b ? (PROTOCOLS.has(b.protocol) ? b.protocol : cur.protocol) : cur.protocol;
      const summary = "summary" in b ? str(b.summary, 300) : cur.summary;
      const methodologyMd = "methodology_md" in b ? String(b.methodology_md ?? "").slice(0, 20000) : cur.methodology_md;
      const passRatio =
        "pass_ratio" in b ? Math.min(1, Math.max(0.1, Number(b.pass_ratio) || 0.8)) : Number(cur.pass_ratio);
      const probes = "probes" in b ? normalizeProbes(b.probes, httpError) : parseJsonSafe(cur.probes_json, []);
      db.prepare(
        `UPDATE verify_channels
            SET name = ?, platform_hint = ?, protocol = ?, summary = ?, methodology_md = ?,
                pass_ratio = ?, probes_json = ?, version = version + 1,
                customized = CASE WHEN is_builtin = 1 THEN 1 ELSE customized END,
                updated_at = ?
          WHERE code = ?`,
      ).run(name, platformHint, protocol, summary, methodologyMd, passRatio, JSON.stringify(probes), nowIso(), cur.code);
      return channelView(q.channel.get(cur.code));
    }),
  );

  app.post(
    "/api/verify/channels/:code/reset",
    wrap(async (req) => {
      const cur = mustChannel(req.params.code);
      const builtin = BUILTIN_CHANNELS.find((c) => c.code === cur.code);
      if (!builtin) throw httpError(400, "只有内置渠道支持恢复默认方法论");
      db.prepare(
        `UPDATE verify_channels
            SET name = ?, platform_hint = ?, protocol = ?, summary = ?, methodology_md = ?,
                pass_ratio = ?, probes_json = ?, version = version + 1, builtin_version = ?, customized = 0, updated_at = ?
          WHERE code = ?`,
      ).run(
        builtin.name,
        builtin.platform_hint,
        builtin.protocol,
        builtin.summary,
        builtin.methodology_md,
        builtin.pass_ratio,
        JSON.stringify(builtin.probes),
        builtin.builtin_version,
        nowIso(),
        cur.code,
      );
      return channelView(q.channel.get(cur.code));
    }),
  );

  app.delete(
    "/api/verify/channels/:code",
    wrap(async (req) => {
      const cur = mustChannel(req.params.code);
      if (cur.is_builtin) throw httpError(400, "内置渠道不可删除，如需修改请编辑其方法论或探针");
      db.prepare("DELETE FROM verify_channels WHERE code = ?").run(cur.code);
      return { ok: true };
    }),
  );

  // ---------- 账号站点 / SK / 可用模型解析 & 标准上游模型拉取 ----------
  app.post(
    "/api/verify/fetch-models",
    wrap(async (req) => {
      const b = req.body || {};
      if (parseInt(b.account_id, 10) > 0) {
        const accountId = parseInt(b.account_id, 10);
        const ctx = await resolveAccountContext(accountId, str(b.api_key_override || b.api_key, 1000));
        if (!ctx.supported) throw httpError(400, ctx.unsupported_reason);
        if (!ctx.has_sk) throw httpError(400, "该账号尚未配置可用 SK，请先填写测试 SK");
        const fetched = await fetchUpstreamModels({
          baseUrl: ctx.base_url,
          apiKey: ctx.api_key,
          fetchImpl,
          httpError,
        });
        const merged = [];
        const seen = new Set();
        for (const [reqName, upName] of Object.entries(ctx.model_mapping || {})) {
          const up = str(upName || reqName, 150);
          const key = `${up}::${reqName}`;
          if (!up || seen.has(key)) continue;
          seen.add(key);
          merged.push({ id: up, requested: reqName, label: reqName === up ? up : `${up}（映射自 ${reqName}）`, source: "模型映射" });
        }
        for (const m of fetched.models) {
          const key = `${m.id}::${m.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(m);
        }
        return { models: merged, endpoint: fetched.endpoint, count: merged.length };
      }
      return fetchUpstreamModels({
        baseUrl: b.base_url,
        apiKey: b.api_key || b.api_key_override,
        fetchImpl,
        httpError,
      });
    }),
  );

  app.get(
    "/api/verify/accounts/:id/inspect",
    wrap(async (req) => {
      const ctx = await resolveAccountContext(parseInt(req.params.id, 10));
      const { api_key: _drop, ...safe } = ctx;
      return safe;
    }),
  );

  app.put(
    "/api/verify/accounts/:id/key",
    wrap(async (req) => {
      const accountId = parseInt(req.params.id, 10);
      if (!Number.isInteger(accountId) || accountId <= 0) throw httpError(400, "账号 ID 无效");
      const key = str(req.body?.api_key, 1000);
      if (key) {
        db.prepare(
          "INSERT INTO verify_account_keys (account_id, api_key, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at",
        ).run(accountId, key, nowIso());
      } else {
        db.prepare("DELETE FROM verify_account_keys WHERE account_id = ?").run(accountId);
      }
      const ctx = await resolveAccountContext(accountId);
      return { has_sk: ctx.has_sk, sk_masked: ctx.sk_masked, sk_source: ctx.sk_source };
    }),
  );

  // ---------- 启动与查看检测报告 ----------
  app.post(
    "/api/verify/runs",
    wrap(async (req) => {
      const b = req.body || {};
      const channelRow = mustChannel(b.channel_code);
      const channel = channelView(channelRow);
      const enabledFp = channel.probes.filter((p) => p.kind !== "baseline" && p.enabled !== false);
      if (!enabledFp.length) {
        throw httpError(400, `渠道「${channel.name}」尚未配置启用的特征探针，请先在「方法论配置」中添加探针`);
      }

      const isManual = b.mode === "manual" || (!parseInt(b.account_id, 10) && Boolean(b.base_url));
      let ctx;
      if (isManual) {
        const cleanBaseUrl = normalizeUpstreamBase(str(b.base_url, 500));
        if (!/^https?:\/\/[^/\s]+/i.test(cleanBaseUrl)) {
          throw httpError(400, "请输入合法的上游站点 URL（需以 http:// 或 https:// 开头）");
        }
        const manualKey = str(b.api_key || b.api_key_override, 1000);
        if (!manualKey) throw httpError(400, "请输入测试 API Key (SK)");
        let host = cleanBaseUrl;
        try {
          host = new URL(cleanBaseUrl).host;
        } catch {}
        const targetName = str(b.target_name, 80) || `手动检测 (${host})`;
        ctx = {
          account: {
            id: 0,
            name: targetName,
            platform: channel.platform_hint || "",
          },
          base_url: cleanBaseUrl,
          api_key: manualKey,
          sk_masked: maskSecret(manualKey),
          sk_source: "manual",
          model_mapping: {},
        };
      } else {
        const accountId = parseInt(b.account_id, 10);
        const apiKeyOverride = str(b.api_key_override, 1000);
        if (apiKeyOverride && b.save_key && Number.isInteger(accountId) && accountId > 0) {
          db.prepare(
            "INSERT INTO verify_account_keys (account_id, api_key, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET api_key = excluded.api_key, updated_at = excluded.updated_at",
          ).run(accountId, apiKeyOverride, nowIso());
        }
        ctx = await resolveAccountContext(accountId, apiKeyOverride);
        if (!ctx.supported) throw httpError(400, ctx.unsupported_reason);
        if (!ctx.has_sk) throw httpError(400, "未能从该账号读取到 SK（api_key），请在界面上补充输入测试 SK 后重试");
      }

      const rawModel = str(b.model, 150);
      if (!rawModel) throw httpError(400, "请选择或输入用于测试的模型");
      const upstreamModel = ctx.model_mapping[rawModel] || rawModel;
      const requestedModel = str(b.requested_model, 150) || (upstreamModel !== rawModel ? rawModel : "");

      const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const startedAt = nowIso();
      db.prepare(
        `INSERT INTO verify_runs
          (id, account_id, account_name, platform, base_url, sk_masked, sk_source, channel_code, channel_name,
           methodology_version, model, requested_model, status, verdict, score, matched_count, total_probes, summary, steps_json, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'pending', 0, 0, ?, '正在初始化探针序列…', '[]', ?)`,
      ).run(
        runId,
        ctx.account.id,
        ctx.account.name,
        ctx.account.platform,
        ctx.base_url,
        ctx.sk_masked,
        ctx.sk_source,
        channel.code,
        channel.name,
        channel.version,
        upstreamModel,
        requestedModel,
        enabledFp.length,
        startedAt,
      );
      db.prepare(
        `DELETE FROM verify_runs WHERE id NOT IN (SELECT id FROM verify_runs ORDER BY started_at DESC LIMIT ${MAX_RUNS})`,
      ).run();

      // 异步执行各探针，立即返回 runId 给前端轮询实时进度
      void executeVerifyRun({ runId, ctx, channel, model: upstreamModel });
      return runView(q.run.get(runId), true);
    }),
  );

  app.get(
    "/api/verify/runs",
    wrap(async (req) => {
      const where = [];
      const params = [];
      if (req.query.channel_code) {
        where.push("channel_code = ?");
        params.push(str(req.query.channel_code, 50));
      }
      if (req.query.verdict) {
        where.push("verdict = ?");
        params.push(str(req.query.verdict, 30));
      }
      if (req.query.account_id) {
        where.push("account_id = ?");
        params.push(parseInt(req.query.account_id, 10) || 0);
      }
      if (req.query.q) {
        const kw = `%${str(req.query.q, 80)}%`;
        where.push("(account_name LIKE ? OR base_url LIKE ? OR model LIKE ? OR channel_name LIKE ?)");
        params.push(kw, kw, kw, kw);
      }
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const sql = `SELECT * FROM verify_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC LIMIT ${limit}`;
      return db.prepare(sql).all(...params).map((r) => runView(r, false));
    }),
  );

  app.get(
    "/api/verify/runs/:id",
    wrap(async (req) => {
      const row = q.run.get(str(req.params.id, 40));
      if (!row) throw httpError(404, "检测报告不存在");
      return runView(row, true);
    }),
  );

  app.delete(
    "/api/verify/runs/:id",
    wrap(async (req) => {
      db.prepare("DELETE FROM verify_runs WHERE id = ?").run(str(req.params.id, 40));
      return { ok: true };
    }),
  );
}
