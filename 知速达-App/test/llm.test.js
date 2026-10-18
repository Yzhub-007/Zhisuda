import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chatJson } from "../lib/llm.js";

test("模型适配：完整接口 URL、围栏 JSON、用量与参数兼容；错误不泄露上游正文", async t => {
  let status = 200, payload = { choices: [{ message: { content: '```json\n{"questions":[]}\n```' } }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }, captured;
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    captured = { path: req.url, body: JSON.parse(body) };
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const cfg = { baseUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions/`, model: "test-model", apiKey: "local-test-placeholder", jsonMode: false };
  const out = await chatJson("system", "user", cfg);
  assert.equal(captured.path, "/v1/chat/completions"); assert.ok(!Object.hasOwn(captured.body, "response_format"));
  assert.equal(out._usage.total_tokens, 130);
  payload = { choices: [{ finish_reason: "length", message: { content: "{}" } }] };
  await assert.rejects(chatJson("s", "u", cfg), /截断/);
  payload = { choices: [{ message: { content: "非 JSON" } }] };
  await assert.rejects(chatJson("s", "u", cfg), /合法 JSON/);
  for (const code of [401, 429, 500]) {
    status = code; payload = { error: "SECRET_INTERNAL_DETAIL" };
    await assert.rejects(chatJson("s", "u", cfg), err => err.status === 502 && err.message.includes(String(code)) && !err.message.includes("SECRET_INTERNAL_DETAIL"));
  }
  await assert.rejects(chatJson("s", "u", { ...cfg, baseUrl: "file:///secret" }), /地址格式/);
  await assert.rejects(chatJson("s", "u", { ...cfg, apiKey: "" }), /未配置/);
});
