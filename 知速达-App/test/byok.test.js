import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requestConfig, chatJson } from "../lib/llm.js";
import { demoInput } from "../lib/demo.js";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const loopback = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

test("用户 API：校验地址及密钥，不降级到共享配置，不修改原配置", () => {
  const fallback = { mock: true, apiKey: "local-fixture-owner" };
  const input = { baseUrl: "https://relay.example/v1/", model: "course-model", apiKey: "local-fixture-user", jsonMode: false, mock: true };
  const cfg = requestConfig(input, fallback);
  assert.equal(cfg.mock, false); assert.equal(cfg.baseUrl, "https://relay.example/v1");
  assert.equal(cfg.apiKey, input.apiKey); assert.equal(cfg.jsonMode, false);
  assert.deepEqual(fallback, { mock: true, apiKey: "local-fixture-owner" });
  assert.equal(requestConfig(undefined, fallback), fallback);
  for (const bad of [null, [], {}, { ...input, baseUrl: "file:///private" }, { ...input, baseUrl: "http://relay.example/v1" }, { ...input, baseUrl: "https://relay.example/v1?key=secret" }, { ...input, baseUrl: "https://name:pass@relay.example" }, { ...input, apiKey: "bad\r\nheader" }, { ...input, apiKey: "two parts" }, { ...input, model: "" }, { ...input, apiKey: "x".repeat(4097) }, { ...input, jsonMode: "false" }]) {
    assert.throws(() => requestConfig(bad, fallback), err => err.status === 400);
  }
  assert.equal(requestConfig({ ...input, baseUrl: "http://127.0.0.1:8000/v1" }).mock, false);
});

test("用户 API：拒绝跟随重定向，不把密钥转发到重定向目标", async t => {
  let forwarded = 0;
  const destination = http.createServer((req, res) => { forwarded++; res.end("{}"); });
  const target = await loopback(destination);
  const redirect = http.createServer((req, res) => { res.writeHead(307, { Location: target + "/private" }); res.end(); });
  const baseUrl = await loopback(redirect);
  t.after(() => Promise.all([new Promise(resolve => redirect.close(resolve)), new Promise(resolve => destination.close(resolve))]));
  await assert.rejects(chatJson("s", "u", { baseUrl, model: "fixture", apiKey: "local-fixture-only" }), /重定向/);
  assert.equal(forwarded, 0);
});

test("用户 API：连接测试无课程、并发配置独立、密钥不进入状态／磁盘／发布导出", async t => {
  const requests = [], input = demoInput();
  const upstream = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body); requests.push({ auth: req.headers.authorization, payload });
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization === "Bearer local-fixture-rejected") { res.writeHead(401); res.end(JSON.stringify({ error: "local-fixture-rejected" })); return; }
    const testRequest = payload.messages[0].content.includes("接口连接测试");
    const content = testRequest ? { ok: true } : input.pack;
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 20 } }));
  });
  const upstreamUrl = await loopback(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const root = process.env.ZHISUDA_TEST_ROOT || path.resolve(app, "..", "..", "_verification"); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "byok-"));
  const child = spawn(process.execPath, ["server.js"], { cwd: app, windowsHide: true, env: { ...process.env, PORT: "0", ZHISUDA_DATA_DIR: directory, LLM_MOCK: "0", LLM_API_KEY: "", LLM_BASE_URL: "", LLM_MODEL: "" } });
  let logs = "";
  t.after(async () => { if (child.exitCode === null) { const done = new Promise(resolve => child.once("exit", resolve)); child.kill(); await done; } });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("测试服务启动超时")), 15000);
    child.stdout.on("data", data => { logs += data; const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.stderr.on("data", data => { logs += data; });
    child.once("error", err => { clearTimeout(timer); reject(err); });
  });
  let cookie = "";
  const req = async (route, method = "GET", body, status = 200) => {
    const res = await fetch(base + route, { method, headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    cookie = res.headers.get("set-cookie")?.split(";")[0] || cookie;
    const result = await res.json(); assert.equal(res.status, status, JSON.stringify(result)); return result;
  };
  const configA = { baseUrl: upstreamUrl + "/v1", model: "fixture-model-a", apiKey: "local-fixture-key-a", jsonMode: false };
  const configB = { ...configA, model: "fixture-model-b", apiKey: "local-fixture-key-b", jsonMode: true };
  const before = await req("/api/state"); assert.equal(before.model.configured, false);
  const connection = await req("/api/model/test", "POST", { modelConfig: configA, source: "不应发送的课程" });
  assert.equal(connection.connected, true);
  assert.ok(!JSON.stringify(requests[0]).includes("不应发送的课程"));
  assert.ok(!Object.hasOwn(requests[0].payload, "response_format"));
  await req("/api/model/test", "POST", {}, 400);
  const denied = await req("/api/model/test", "POST", { modelConfig: { ...configA, apiKey: "local-fixture-rejected" } }, 502);
  assert.ok(!JSON.stringify(denied).includes("local-fixture-rejected"));
  assert.deepEqual((await req("/api/state")).drafts, []);
  const outputs = await Promise.all([configA, configB].map(modelConfig => req("/api/generate", "POST", { source: input.source, course: input.course, modelConfig })));
  assert.deepEqual(outputs.map(o => o.draft.generation.model), ["fixture-model-a", "fixture-model-b"]);
  assert.ok(outputs.every(o => o.draft.mode === "live"));
  for (const config of [configA, configB]) {
    const used = requests.find(r => r.payload.model === config.model && r.payload.messages[0].content.includes("接口连接测试") === false);
    assert.equal(used.auth, "Bearer " + config.apiKey);
    assert.equal(Object.hasOwn(used.payload, "response_format"), config.jsonMode);
  }
  await req("/api/generate", "POST", { source: input.source }, 503); // 不会复用上一个人的密钥
  let draft = outputs[0].draft;
  for (const q of draft.questions) ({ draft } = await req(`/api/drafts/${draft.id}/questions/${q.id}`, "PATCH", { revision: draft.revision, review: q.quoteFound ? "approved" : "rejected", evidenceConfirmed: q.quoteFound }));
  const { publication } = await req(`/api/drafts/${draft.id}/publish`, "POST", { revision: draft.revision });
  const exported = await req(`/api/publications/${publication.id}/export`);
  const state = await req("/api/state"), persisted = await readFile(path.join(directory, "workspaces", cookie.split("=")[1], "workspace.json"), "utf8");
  assert.equal(state.model.configured, false);
  for (const key of [configA.apiKey, configB.apiKey, "local-fixture-rejected"]) {
    assert.ok(!JSON.stringify({ outputs, connection, exported, state }).includes(key));
    assert.ok(!persisted.includes(key)); assert.ok(!logs.includes(key));
  }
  assert.ok(!persisted.includes(upstreamUrl));
});
