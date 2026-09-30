// 深度检测：用你手动录入的 Key + 账号在 sub2api 里的 base_url，直接请求上游，
// 检查连通/模型/thinking 块/多轮续接/Bedrock 特征。每 5 分钟跑一次（分组开启时），也可手动触发。
// 这里用原生 fetch 而不是 SDK：要看原始 SSE 事件、消息 ID 和响应头，且上游是各家中转。
import fs from "node:fs";
import path from "node:path";

const OLD_THINKING = /haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|opus-4-2|sonnet-4-2|claude-3/; // 仍用 budget_tokens 的旧模型
const now = () => Date.now();

export function createDetector({ s2, pool, dataDir, getGroupCfg, allGroupCfgs, getAccounts, log }) {
  const KEYS_FILE = path.join(dataDir, "detect-keys.json");
  const RESULTS_FILE = path.join(dataDir, "detect-results.json");
  const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
  const saveJson = (f, v) => { fs.writeFileSync(f + ".tmp", JSON.stringify(v, null, 2)); fs.renameSync(f + ".tmp", f); };
  const keys = load(KEYS_FILE, {}); // accountId -> key
  const results = load(RESULTS_FILE, {}); // accountId -> [最近 30 次结果]
  const running = new Set();
  let alerts = [];

  const mask = (k) => (k ? k.slice(0, 6) + "…" + k.slice(-4) : "");
  const thinkingFor = (model) => (OLD_THINKING.test(model) ? { type: "enabled", budget_tokens: 1024 } : { type: "adaptive", display: "summarized" });

  async function call(baseUrl, key, body, { stream } = {}) {
    const started = now();
    const res = await fetch(baseUrl.replace(/\/+$/, "") + "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ ...body, stream: !!stream }),
      signal: AbortSignal.timeout(120000),
    });
    const headers = Object.fromEntries(res.headers.entries());
    if (!stream) {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, headers, json, text: text.slice(0, 800), ms: now() - started };
    }
    // 流式：按事件组装内容块，记录首字时间
    const msg = { id: null, model: null, content: [], usage: {}, stop_reason: null };
    const events = new Set();
    let ttft = null, buf = "", errText = "";
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        events.add(ev.type + (ev.delta?.type ? ":" + ev.delta.type : ""));
        if (ev.type === "message_start") Object.assign(msg, { id: ev.message?.id, model: ev.message?.model, usage: ev.message?.usage || {} });
        else if (ev.type === "content_block_start") msg.content[ev.index] = { ...ev.content_block };
        else if (ev.type === "content_block_delta") {
          if (ttft == null) ttft = now() - started;
          const b = msg.content[ev.index] || (msg.content[ev.index] = {});
          const d = ev.delta;
          if (d.type === "thinking_delta") b.thinking = (b.thinking || "") + d.thinking;
          else if (d.type === "signature_delta") b.signature = (b.signature || "") + d.signature;
          else if (d.type === "text_delta") b.text = (b.text || "") + d.text;
          else if (d.type === "input_json_delta") b._json = (b._json || "") + d.partial_json;
        } else if (ev.type === "message_delta") {
          msg.stop_reason = ev.delta?.stop_reason;
          Object.assign(msg.usage, ev.usage || {});
        } else if (ev.type === "error") errText = JSON.stringify(ev.error || ev).slice(0, 500);
      }
    }
    for (const b of msg.content) {
      if (b && b.type === "tool_use") {
        try { b.input = b._json ? JSON.parse(b._json) : b.input || {}; } catch { b.input = {}; }
        delete b._json;
      }
    }
    if (res.status >= 400 && !errText) errText = buf.slice(0, 500);
    return { status: res.status, headers, msg, events: [...events], ttft, ms: now() - started, errText };
  }

  async function runOne(aid, reason = "手动") {
    if (running.has(aid)) throw Object.assign(new Error("该账号正在检测中"), { status: 409 });
    const key = keys[aid];
    if (!key) throw Object.assign(new Error("还没有给这个账号录入检测 Key"), { status: 400 });
    running.add(aid);
    const checks = [];
    const add = (name, level, detail) => checks.push({ name, level, detail }); // level: pass / warn / fail / info
    const started = now();
    let account, cfg;
    try {
      lastAccounts = await getAccounts();
      account = lastAccounts.find((a) => a.id === aid);
      if (!account) throw new Error("账号不存在");
      const full = await s2("GET", `/admin/accounts/${aid}`);
      const baseUrl = full?.credentials?.base_url;
      if (!baseUrl) throw new Error("该账号在 sub2api 里没有 base_url（非 apikey 类型账号暂不支持）");
      cfg = detectCfgFor(aid);
      const mapping = full?.credentials?.model_mapping || {};
      const up = (m) => mapping[m] || m; // 直连上游要用映射后的模型名

      // 0. 模型覆盖：分组最近 24 小时客户最常用的模型逐个发极小请求
      let top = [];
      if (cfg.gid) {
        const { rows } = await pool.query(
          `SELECT coalesce(nullif(btrim(requested_model), ''), model) AS m, count(*) n FROM usage_logs
            WHERE group_id = $1 AND created_at >= now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
          [cfg.gid]
        );
        top = rows.map((r) => r.m);
      }
      const want = [...new Set([cfg.model, ...top])].slice(0, 7);
      const cover = await Promise.all(
        want.map(async (m) => {
          const r = await call(baseUrl, key, { model: up(m), max_tokens: 32, messages: [{ role: "user", content: "hi" }] }).catch((e) => ({ status: 0, text: e.message }));
          const msg = r.json?.error?.message || r.text || "";
          const kind = r.status === 200 ? "ok" : /model_not_found|no available channel|not.{0,10}(found|support)|无可用渠道|不支持/i.test(msg) ? "unsupported" : [401, 403].includes(r.status) ? "auth" : "error";
          return { m, status: r.status, kind, msg: msg.slice(0, 160) };
        })
      );
      const auth = cover.find((x) => x.kind === "auth");
      if (auth) throw new Error(`Key 无效或无权限：HTTP ${auth.status} ${auth.msg}`);
      const okModels = cover.filter((x) => x.kind === "ok").map((x) => x.m);
      const bad = cover.filter((x) => x.kind !== "ok");
      const fmt = (x) => `${x.m}${up(x.m) !== x.m ? `→${up(x.m)}` : ""}`;
      const mainOk = okModels.includes(cfg.model);
      add(
        "模型覆盖",
        !mainOk ? "fail" : bad.length ? "warn" : "pass",
        `可用：${okModels.map((m) => fmt({ m })).join("、") || "无"}${bad.length ? `；不可用：${bad.map((x) => `${fmt(x)}（${x.kind === "unsupported" ? "上游无此模型渠道" : `HTTP ${x.status}`}）`).join("、")}` : ""}${!mainOk ? `。分组检测模型 ${cfg.model} 不可用，客户请求这个模型会失败` : ""}`
      );
      if (!okModels.length) throw new Error(`没有任何模型可用：${bad.map((x) => `${x.m} HTTP ${x.status} ${x.msg}`).join("；").slice(0, 400)}`);
      const model = mainOk ? cfg.model : okModels.find((m) => /opus/.test(m)) || okModels[0];
      if (!mainOk) add("检测模型", "info", `${cfg.model} 不可用，以下 thinking 相关检测改用 ${model}`);
      const tools = [{ name: "get_weather", description: "查询城市天气", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];
      // 需要推理的题，且推理结果决定调用哪个工具：自适应思考下太简单的题模型会直接不思考
      const q = {
        role: "user",
        content: "有一个三位数，各位数字之和是 18，百位数字比个位数字大 2，十位数字是个位数字的 2 倍。先推理出这个数；如果它是偶数就用 get_weather 查北京天气，否则查上海天气。拿到结果后用一句话告诉我。",
      };

      // 1. 流式首轮：连通、模型、thinking 块、工具调用（没思考就用 effort=max 再试一次）
      const first = { model: up(model), max_tokens: 8000, thinking: thinkingFor(model), tools, messages: [q] };
      let r1 = await call(baseUrl, key, first, { stream: true });
      let retried = false;
      const hasThinking = (r) => r.msg?.content?.some((b) => b?.type === "thinking" || b?.type === "redacted_thinking");
      if (r1.status === 200 && !r1.errText && !hasThinking(r1) && !OLD_THINKING.test(model)) {
        const r1b = await call(baseUrl, key, { ...first, output_config: { effort: "max" } }, { stream: true });
        if (r1b.status === 200 && !r1b.errText) { r1 = r1b; retried = true; }
      }
      if (r1.status !== 200 || r1.errText) {
        add("连通性", "fail", `HTTP ${r1.status}：${r1.errText || "无响应内容"}`);
      } else {
        add("连通性", "pass", `HTTP 200，首字 ${r1.ttft ?? "-"}ms，总耗时 ${r1.ms}ms`);
        const m = r1.msg;
        add("返回模型", m.model && (m.model.includes(up(model)) || up(model).includes(m.model)) ? "pass" : "warn", `请求 ${up(model)}，返回 ${m.model || "（空）"}`);
        const th = m.content.filter((b) => b?.type === "thinking");
        const red = m.content.filter((b) => b?.type === "redacted_thinking");
        const sumLen = th.reduce((s, b) => s + (b.thinking || "").length, 0);
        if (!th.length && !red.length) add("thinking 块", "fail", `推理题开启 thinking${retried ? "，并用 effort=max 重试" : ""}后，响应里仍然没有 thinking 块`);
        else add("thinking 块", "pass", `${th.length} 个 thinking 块${red.length ? `、${red.length} 个 redacted_thinking` : ""}${retried ? "（首次未思考，effort=max 重试后出现）" : ""}`);
        if (th.length) {
          const noSig = th.filter((b) => !b.signature);
          add("thinking 签名", noSig.length ? "fail" : "pass", noSig.length ? `${noSig.length} 个 thinking 块签名为空` : `签名齐全（${th.map((b) => b.signature.length).join(" / ")} 字符）`);
          if (!r1.events.includes("content_block_delta:signature_delta")) add("签名流事件", "warn", "流式响应里没有 signature_delta 事件");
          if (!OLD_THINKING.test(model))
            add("思考摘要", sumLen ? "pass" : "warn", sumLen ? `请求了 display=summarized，返回摘要 ${sumLen} 字` : "请求了 display=summarized 但思考文字为空，上游可能丢了 display 参数（不影响签名和续接）");
        }
        // Bedrock 特征（只作为证据）
        const ev = [];
        if (/^msg_bdrk_/.test(m.id || "")) ev.push(`消息 ID ${m.id.slice(0, 16)}…`);
        const amzn = Object.keys(r1.headers).filter((h) => h.startsWith("x-amzn") || h.startsWith("x-amz-"));
        if (amzn.length) ev.push(`响应头 ${amzn.join(", ")}`);
        const other = /^msg_vrtx_/.test(m.id || "") ? "Vertex" : null;
        if (cfg.expect === "bedrock") add("Bedrock 特征", ev.length ? "pass" : "warn", ev.length ? ev.join("；") : `未发现 Bedrock 特征（消息 ID：${m.id || "空"}${other ? "，疑似 " + other : ""}）。中转可能改写了 ID，需结合其他项判断`);
        else add("上游特征", "info", ev.length ? `Bedrock：${ev.join("；")}` : `消息 ID：${m.id || "空"}`);

        // 2. 多轮续接：原样带回上一轮内容 + 工具结果
        const tu = m.content.find((b) => b?.type === "tool_use");
        if (!tu) add("多轮续接", "warn", "模型这轮没有调用工具，跳过续接检测");
        else {
          const assistant = m.content.filter(Boolean).map((b) => {
            if (b.type === "thinking") return { type: "thinking", thinking: b.thinking || "", signature: b.signature || "" };
            if (b.type === "redacted_thinking") return { type: "redacted_thinking", data: b.data };
            if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
            return { type: "text", text: b.text || "" };
          }).filter((b) => b.type !== "text" || b.text);
          const r2 = await call(baseUrl, key, {
            model: up(model), max_tokens: 8000, thinking: thinkingFor(model), tools,
            messages: [q, { role: "assistant", content: assistant }, { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: "北京：晴，22°C" }] }],
          });
          if (r2.status === 200 && r2.json?.content) add("多轮续接", "pass", `${th.length ? "带回 thinking 块后" : "（本轮未思考）"}续接成功（${r2.ms}ms，stop_reason=${r2.json.stop_reason}）`);
          else {
            const sig = /signature/i.test(r2.text);
            add("多轮续接", "fail", `${sig ? "thinking 签名校验不通过，客户多轮对话会报 Invalid signature" : "续接请求失败"}：HTTP ${r2.status} ${r2.text.slice(0, 300)}`);
          }
        }
      }

    } catch (e) {
      add("检测异常", "fail", e.message);
    } finally {
      running.delete(aid);
    }
    const verdict = checks.some((c) => c.level === "fail") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "pass";
    const r = { at: new Date().toISOString(), reason, model: cfg?.model, expect: cfg?.expect, verdict, ms: now() - started, checks };
    (results[aid] ||= []).unshift(r);
    results[aid] = results[aid].slice(0, 30);
    saveJson(RESULTS_FILE, results);
    const bad = checks.filter((c) => c.level === "fail");
    if (verdict === "fail") log({ level: "alert", account_id: aid, account_name: account?.name, msg: `深度检测不通过：${bad.map((c) => `${c.name}（${c.detail.slice(0, 80)}）`).join("；")}` });
    else log({ level: "info", account_id: aid, account_name: account?.name, msg: `深度检测${verdict === "pass" ? "通过" : "有警告"}（${r.ms}ms）` });
    refreshAlerts(await getAccounts().catch(() => []));
    return r;
  }

  // 账号的检测配置：取它所在的、开启了深度检测的第一个分组
  function detectCfgFor(aid) {
    const acc = lastAccounts.find((a) => a.id === aid);
    const gids = acc?.group_ids || [];
    const g = gids.map((gid) => ({ gid, c: getGroupCfg(gid) })).find((x) => x.c?.detect) || gids.map((gid) => ({ gid, c: getGroupCfg(gid) })).find((x) => x.c);
    return { gid: g?.gid, model: g?.c?.probeModel || allGroupCfgs().defaultModel, expect: g?.c?.detectExpect || "any" };
  }

  let lastAccounts = [];
  function refreshAlerts(accounts) {
    if (accounts?.length) lastAccounts = accounts;
    alerts = [];
    for (const [aid, list] of Object.entries(results)) {
      const r = list[0];
      if (!r || !keys[aid]) continue;
      const a = lastAccounts.find((x) => x.id === +aid);
      if (r.verdict === "fail")
        alerts.push({ level: "critical", account_id: +aid, msg: `账号「${a?.name || aid}」深度检测不通过：${r.checks.filter((c) => c.level === "fail").map((c) => c.name).join("、")}` });
    }
  }

  let loopRunning = false;
  async function tick() {
    if (loopRunning) return;
    loopRunning = true;
    try {
      const accounts = await getAccounts();
      lastAccounts = accounts;
      const { groups } = allGroupCfgs();
      const targets = new Set();
      for (const [gid, c] of Object.entries(groups)) {
        if (!c.detect) continue;
        for (const a of accounts) if (a.group_ids.includes(+gid) && keys[a.id]) targets.add(a.id);
      }
      const list = [...targets];
      for (let i = 0; i < list.length; i += 3) await Promise.all(list.slice(i, i + 3).map((aid) => runOne(aid, "定时").catch(() => {})));
      refreshAlerts(accounts);
    } finally {
      loopRunning = false;
    }
  }

  return {
    get alerts() { return alerts; },
    keyInfo: (aid) => (keys[aid] ? { has_key: true, key_masked: mask(keys[aid]) } : { has_key: false }),
    latest: (aid) => results[aid]?.[0] || null,
    history: (aid) => results[aid] || [],
    isRunning: (aid) => running.has(aid),
    setKey(aid, key) {
      key = String(key || "").trim();
      if (key) keys[aid] = key;
      else { delete keys[aid]; delete results[aid]; saveJson(RESULTS_FILE, results); }
      saveJson(KEYS_FILE, keys);
      refreshAlerts();
    },
    run: runOne,
    start() {
      const loop = async () => { await tick().catch((e) => console.error("[detector]", e)); setTimeout(loop, 5 * 60000); };
      setTimeout(loop, 60000);
    },
  };
}
