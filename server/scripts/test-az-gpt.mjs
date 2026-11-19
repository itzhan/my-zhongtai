import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
const express = require("express");
const { registerVerifier, BUILTIN_CHANNELS, computeRespEncVerdict } = await import("../verifier.js");

const REAL_BLOB = `gAAAAA${"A".repeat(1600)}`;

function createMockUpstream() {
  let mode = "real";
  const replays = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !String(req.url || "").includes("/responses")) {
      res.statusCode = 404;
      return res.end("not found");
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = {};
      }
      res.setHeader("content-type", "application/json");
      if (mode === "throttle") {
        res.statusCode = 429;
        return res.end(JSON.stringify({ error: { message: "Rate limit exceeded", code: "rate_limit_exceeded" } }));
      }
      const input = body.input;
      const isSeed = Boolean(body.reasoning) || (Array.isArray(body.include) && body.include.includes("reasoning.encrypted_content"));
      if (!Array.isArray(input)) {
        if (isSeed) {
          if (mode === "no_blob") {
            res.statusCode = 200;
            return res.end(
              JSON.stringify({
                id: "resp_seed",
                output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "READY" }] }],
              }),
            );
          }
          res.statusCode = 200;
          return res.end(
            JSON.stringify({
              id: "resp_seed",
              output: [
                { type: "reasoning", id: "rs_testblob", encrypted_content: REAL_BLOB, summary: [] },
                { type: "message", role: "assistant", content: [{ type: "output_text", text: "READY" }] },
              ],
            }),
          );
        }
        res.statusCode = 200;
        return res.end(
          JSON.stringify({
            id: "resp_s0",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
          }),
        );
      }

      replays.push(body);
      const blob = input.find((item) => item?.type === "reasoning")?.encrypted_content || "";
      if (mode === "swallow") {
        res.statusCode = 200;
        return res.end(
          JSON.stringify({
            id: "resp_swallowed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
          }),
        );
      }
      if (blob === REAL_BLOB) {
        const text = mode === "s1_wrong" ? "UNKNOWN" : "AR-5";
        res.statusCode = 200;
        return res.end(
          JSON.stringify({
            id: "resp_s1",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
          }),
        );
      }
      res.statusCode = 400;
      if (mode === "washed") {
        return res.end(JSON.stringify({ error: { message: "Upstream request failed", code: "upstream_error" } }));
      }
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
  return {
    setMode: (m) => {
      mode = m;
    },
    replays,
    start: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function seedOldAzGpt(dataDir) {
  const preDb = new DatabaseSync(path.join(dataDir, "ops.db"));
  preDb.exec(`
    CREATE TABLE verify_channels (
      code TEXT PRIMARY KEY, name TEXT NOT NULL, platform_hint TEXT NOT NULL DEFAULT '',
      protocol TEXT NOT NULL DEFAULT 'gemini_native', summary TEXT NOT NULL DEFAULT '',
      methodology_md TEXT NOT NULL DEFAULT '', pass_ratio REAL NOT NULL DEFAULT 0.8,
      probes_json TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
      is_builtin INTEGER NOT NULL DEFAULT 0, builtin_version INTEGER NOT NULL DEFAULT 1,
      customized INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  preDb
    .prepare(
      `INSERT INTO verify_channels
        (code, name, platform_hint, protocol, summary, methodology_md, pass_ratio, probes_json, version, is_builtin, builtin_version, customized, sort_order, created_at, updated_at)
       VALUES ('az_gpt', 'az gpt', 'openai', 'openai_chat', 'old', 'old', 0.8, '[]', 1, 1, 1, 0, 2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
    .run();
  preDb.close();
}

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
    await new Promise((res) => setTimeout(res, 40));
  }
  throw new Error("timeout waiting for run");
}

async function startRun(apiBase, baseUrl, modeLabel) {
  const created = await fetch(`${apiBase}/api/verify/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "manual",
      channel_code: "az_gpt",
      base_url: baseUrl,
      api_key: "test-key",
      model: "gpt-5.4",
      target_name: modeLabel,
    }),
  }).then(async (r) => {
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  });
  return pollRun(apiBase, created.id);
}

test("computeRespEncVerdict routes washed 400 to suspicious, not fake", () => {
  const step = (runner, extra) => ({
    id: runner,
    name: runner,
    runner,
    kind: runner === "resp_enc_seed" ? "baseline" : "fingerprint",
    status: "pass",
    ...extra,
  });
  const washed = computeRespEncVerdict({
    channelName: "az gpt",
    steps: [
      step("resp_enc_s0", { status: "pass", round_statuses: [200, 200] }),
      step("resp_enc_seed", { status: "pass", blob_len: 1606, blob_prefix_ok: true }),
      step("resp_enc_s1", { status: "pass", s1_ar5_ok: true, round_statuses: [200, 200] }),
      ...["resp_enc_s2", "resp_enc_s3", "resp_enc_s4", "resp_enc_s5"].map((runner) =>
        step(runner, { status: "fail", round_statuses: [400, 400], has_invalid_enc_code: false, any_200: false }),
      ),
    ],
  });
  assert.equal(washed.verdict, "suspicious");
});

test("AZ GPT Responses encrypted_content S0–S5", async () => {
  const upstream = createMockUpstream();
  const upPort = await upstream.start();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-az-gpt-"));
  seedOldAzGpt(tmpDir);
  const { apiServer, apiBase } = await boot(tmpDir);
  const baseUrl = `http://127.0.0.1:${upPort}/v1`;
  try {
    const channels = await fetch(`${apiBase}/api/verify/channels`).then((r) => r.json());
    assert.equal(channels.length, BUILTIN_CHANNELS.length);
    const az = channels.find((c) => c.code === "az_gpt");
    assert.equal(az.version, 2);
    assert.equal(az.builtin_version, 2);
    assert.equal(az.protocol, "openai_responses");
    assert.equal(az.probe_count, 7);
    assert.equal(az.pass_ratio, 1);

    upstream.setMode("real");
    const real = await startRun(apiBase, baseUrl, "real");
    assert.equal(real.verdict, "authentic", real.summary);
    assert.deepEqual(real.steps.find((s) => s.id === "az_s0").round_statuses, [200, 200]);
    assert.equal(real.steps.find((s) => s.id === "az_seed").blob_prefix_ok, true);
    assert.equal(real.steps.find((s) => s.id === "az_s1").s1_ar5_ok, true);
    for (const id of ["az_s2", "az_s3", "az_s4", "az_s5"]) {
      const step = real.steps.find((s) => s.id === id);
      assert.deepEqual(step.round_statuses, [400, 400], id);
      assert.equal(step.has_invalid_enc_code, true, id);
    }
    const s1Body = JSON.stringify(real.steps.find((s) => s.id === "az_s1").request_body);
    assert.equal(/AR-?5/.test(s1Body), false);
    assert.equal(real.steps.find((s) => s.id === "az_s4").request_body.input[0].encrypted_content, "AAAA");
    assert.equal(upstream.replays.some((b) => /AR-?5/.test(JSON.stringify(b.input))), false);

    upstream.setMode("swallow");
    const swallowed = await startRun(apiBase, baseUrl, "swallow");
    assert.equal(swallowed.verdict, "fake", swallowed.summary);
    assert.equal(swallowed.steps.find((s) => s.id === "az_s3").any_200, true);

    upstream.setMode("washed");
    const washed = await startRun(apiBase, baseUrl, "washed");
    assert.equal(washed.verdict, "suspicious", washed.summary);
    assert.equal(washed.steps.find((s) => s.id === "az_s5").has_invalid_enc_code, false);
    assert.deepEqual(washed.steps.find((s) => s.id === "az_s5").round_statuses, [400, 400]);

    upstream.setMode("no_blob");
    const noBlob = await startRun(apiBase, baseUrl, "no-blob");
    assert.equal(noBlob.verdict, "fake", noBlob.summary);
    assert.equal(noBlob.steps.find((s) => s.id === "az_seed").no_blob_200, true);
    assert.equal(noBlob.steps.find((s) => s.id === "az_s1").status, "skip");

    upstream.setMode("s1_wrong");
    const wrong = await startRun(apiBase, baseUrl, "s1-wrong");
    assert.equal(wrong.verdict, "fake", wrong.summary);
    assert.equal(wrong.steps.find((s) => s.id === "az_s1").s1_wrong_answer, true);
    assert.equal(wrong.steps.find((s) => s.id === "az_s2").status, "pass");

    upstream.setMode("throttle");
    const throttled = await startRun(apiBase, baseUrl, "throttle");
    assert.equal(throttled.verdict, "inconclusive", throttled.summary);
    assert.equal(throttled.steps.find((s) => s.id === "az_s0").env_error, true);
    assert.equal(throttled.steps.find((s) => s.id === "az_seed").status, "skip");
  } finally {
    await new Promise((resolve) => apiServer.close(resolve));
    await upstream.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
