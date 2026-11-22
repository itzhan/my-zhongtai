import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
const express = require("express");
const { registerVerifier, BUILTIN_CHANNELS } = await import("../verifier.js");

const REAL_BLOB = `gAAAAA${"A".repeat(1600)}`;
const REAL_SIG = "CAQS8QMKEggUEAEYAjgBQgh0aGlua2luZxIMMcmJC6jQEDXEKyCVGgxR2YWHJLVNUdARpdsiMBsUtHa5Pn2xLMp9W1ci";

async function boot(dataDir) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  const httpError = (status, message) => Object.assign(new Error(message), { status });
  const wrap = (fn) => (req, res) =>
    fn(req, res).then(
      (data) => res.json(data),
      (e) => res.status(e.status || 500).json({ error: e.message }),
    );
  registerVerifier({
    app,
    wrap,
    httpError,
    dataDir,
    s2: async () => {
      throw httpError(404, "unused");
    },
    pool: { query: async () => ({ rows: [] }) },
    getAccounts: async () => [],
    detector: { getKey: () => "" },
  });
  const apiServer = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { apiServer, apiBase: `http://127.0.0.1:${apiServer.address().port}` };
}

async function pollRun(apiBase, runId) {
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${apiBase}/api/verify/runs/${runId}`).then((x) => x.json());
    if (r.status && r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error("timeout waiting for run");
}

async function startRun(apiBase, channelCode, baseUrl, model, label) {
  const created = await fetch(`${apiBase}/api/verify/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "manual",
      channel_code: channelCode,
      base_url: baseUrl,
      api_key: "test-key",
      model,
      target_name: label,
    }),
  }).then(async (r) => {
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  });
  return pollRun(apiBase, created.id);
}

test("AWS Bedrock S5 handles empty origThinking (claude-opus-5-5 adaptive) and both Bedrock 400 messages", async () => {
  let s5Mode = "nonempty_sig_err";
  let seenS5Block = null;
  const mock = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const msgs = body.messages || [];
      if (msgs.length === 1) {
        // Simulate claude-opus-5-5 returning empty thinking text "" with valid signature
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        return res.end(
          JSON.stringify({
            id: "msg_bdrk_seed123456",
            type: "message",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", signature: REAL_SIG },
              { type: "text", text: "684" },
            ],
          }),
        );
      }
      const tb = msgs[1]?.content?.[0] || {};
      const hasSigKey = Object.prototype.hasOwnProperty.call(tb, "signature");
      const sig = tb.signature;
      if (!hasSigKey) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            error: {
              type: "aws_invoke_error",
              message:
                "InvokeModel: operation error Bedrock Runtime: InvokeModel, https response error StatusCode: 400, ValidationException: messages.1.content.0.thinking.signature: Field required",
            },
          }),
        );
      }
      if (sig === "") {
        seenS5Block = tb;
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        const msg =
          s5Mode === "empty_thinking_err"
            ? "InvokeModel: operation error Bedrock Runtime: InvokeModel, https response error StatusCode: 400, ValidationException: messages.1.content.0.thinking: each thinking block must contain thinking"
            : "InvokeModel: operation error Bedrock Runtime: InvokeModel, https response error StatusCode: 400, ValidationException: messages.1.content.0: Invalid `signature` in `thinking` block";
        return res.end(JSON.stringify({ error: { type: "aws_invoke_error", message: msg } }));
      }
      if (sig !== REAL_SIG) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        const op = body.stream ? "InvokeModelWithResponseStream" : "InvokeModel";
        return res.end(
          JSON.stringify({
            error: {
              type: "aws_invoke_error",
              message: `InvokeModel: operation error Bedrock Runtime: ${op}, https response error StatusCode: 400, ValidationException: messages.1.content.0: Invalid \`signature\` in \`thinking\` block`,
            },
          }),
        );
      }
      if (body.stream) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        return res.end(
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_bdrk_stream888", role: "assistant" } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
        );
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          id: "msg_bdrk_ok123",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "OK" }],
        }),
      );
    });
  });
  const port = await new Promise((resolve) => mock.listen(0, "127.0.0.1", () => resolve(mock.address().port)));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-awsb-s5-"));
  const { apiServer, apiBase } = await boot(tmpDir);
  try {
    s5Mode = "nonempty_sig_err";
    const r1 = await startRun(apiBase, "aws_bedrock", `http://127.0.0.1:${port}`, "claude-opus-5-5", "awsb-s5-fix");
    assert.equal(r1.verdict, "authentic", r1.summary);
    assert.equal(r1.score, 100);
    assert.ok(seenS5Block && seenS5Block.thinking.length > 0, "S5 should populate non-empty thinking placeholder when origThinking is empty");

    s5Mode = "empty_thinking_err";
    const r2 = await startRun(apiBase, "aws_bedrock", `http://127.0.0.1:${port}`, "claude-opus-5-5", "awsb-s5-compat");
    assert.equal(r2.verdict, "authentic", r2.summary);
    assert.equal(r2.score, 100);
  } finally {
    await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => mock.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("OpenAI Official verifier distinguishes true official, Azure impersonation, and reverse/swallow pools", async () => {
  let mode = "official";
  const mock = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      res.setHeader("content-type", "application/json");
      if (mode === "official") {
        res.setHeader("openai-organization", "org-test123");
        res.setHeader("openai-processing-ms", "123");
        res.setHeader("openai-version", "2020-10-01");
        res.setHeader("x-request-id", "req_abcdef123456");
      } else if (mode === "azure_fake_official") {
        res.setHeader("apim-request-id", "591b8d58-fa2c-48c7-9187-25dbdc0c87f8");
        res.setHeader("x-ms-region", "West US 3");
      }
      const azBody =
        mode === "azure_fake_official"
          ? {
              content_filters: [
                {
                  source_type: "prompt",
                  content_filter_results: { hate: { filtered: false, severity: "safe" } },
                  content_filter_offsets: { start_offset: 0, end_offset: 10, check_offset: 0 },
                },
              ],
            }
          : { service_tier: "default" };

      if (body.service_tier === "invalid_tier_oai_probe") {
        if (mode === "swallow" || mode === "strip_extra") {
          res.statusCode = 200;
          return res.end(JSON.stringify({ id: "resp_ok", ...azBody, output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }));
        }
        res.statusCode = 400;
        return res.end(
          JSON.stringify({
            error: {
              message: "Invalid value: 'invalid_tier_oai_probe'. Supported values are: 'auto', 'default', 'flex', 'scale', and 'priority'.",
              type: "invalid_request_error",
              param: "service_tier",
              code: "invalid_value",
            },
          }),
        );
      }

      if (body.previous_response_id) {
        if (mode === "swallow" || mode === "strip_extra") {
          res.statusCode = 200;
          return res.end(JSON.stringify({ id: "resp_ok", ...azBody, output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }));
        }
        res.statusCode = 400;
        return res.end(
          JSON.stringify({
            error: {
              message: `Previous response with id '${body.previous_response_id}' not found.`,
              type: "invalid_request_error",
              param: "previous_response_id",
              code: "previous_response_not_found",
            },
          }),
        );
      }

      const input = body.input;
      const isSeed = Boolean(body.reasoning) || (Array.isArray(body.include) && body.include.includes("reasoning.encrypted_content"));
      if (!Array.isArray(input)) {
        res.statusCode = 200;
        if (isSeed) {
          return res.end(
            JSON.stringify({
              id: "resp_seed",
              ...azBody,
              output: [
                { type: "reasoning", id: "rs_1", encrypted_content: REAL_BLOB, summary: [] },
                { type: "message", content: [{ type: "output_text", text: "READY" }] },
              ],
            }),
          );
        }
        return res.end(JSON.stringify({ id: "resp_s0", ...azBody, output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }));
      }

      const blob = input.find((x) => x?.type === "reasoning")?.encrypted_content || "";
      if (mode === "swallow") {
        res.statusCode = 200;
        return res.end(JSON.stringify({ id: "resp_sw", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }] }));
      }
      if (blob === REAL_BLOB) {
        res.statusCode = 200;
        return res.end(JSON.stringify({ id: "resp_s1", ...azBody, output: [{ type: "message", content: [{ type: "output_text", text: "AR-5" }] }] }));
      }
      res.statusCode = 400;
      return res.end(
        JSON.stringify({
          error: {
            message: "The encrypted content could not be decrypted or parsed.",
            type: "invalid_request_error",
            code: "invalid_encrypted_content",
          },
        }),
      );
    });
  });
  const port = await new Promise((resolve) => mock.listen(0, "127.0.0.1", () => resolve(mock.address().port)));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-oai-off-"));
  const { apiServer, apiBase } = await boot(tmpDir);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  try {
    const ch = BUILTIN_CHANNELS.find((c) => c.code === "openai_official");
    assert.ok(ch, "openai_official builtin channel exists");

    mode = "official";
    const okRun = await startRun(apiBase, "openai_official", baseUrl, "gpt-5.4", "true-official");
    assert.equal(okRun.verdict, "authentic", okRun.summary);
    assert.equal(okRun.score, 100);
    assert.match(okRun.summary, /OpenAI 官转纯透传/);

    mode = "azure_fake_official";
    const azRun = await startRun(apiBase, "openai_official", baseUrl, "gpt-5.4", "azure-impersonator");
    assert.equal(azRun.verdict, "fake", azRun.summary);
    assert.match(azRun.summary, /Azure OpenAI 冒充 OpenAI 官转/);

    mode = "swallow";
    const fakeRun = await startRun(apiBase, "openai_official", baseUrl, "gpt-5.4", "reverse-pool");
    assert.equal(fakeRun.verdict, "fake", fakeRun.summary);

    mode = "strip_extra";
    const stripRun = await startRun(apiBase, "openai_official", baseUrl, "gpt-5.4", "strip-params");
    assert.equal(stripRun.verdict, "suspicious", stripRun.summary);
  } finally {
    await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => mock.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
