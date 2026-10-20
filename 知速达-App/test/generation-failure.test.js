import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoInput } from "../lib/demo.js";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 故障演示：模型服务出错时，任务明确失败，已有复习包与草稿不变，服务端不自动重试（不重复扣费）。
test("生成失败：上游 500 不改变已有记录、只调用一次模型、可立即重新发起", async t => {
  let calls = 0;
  const upstream = http.createServer((req, res) => { calls++; req.resume(); res.writeHead(500); res.end("{}"); });
  const upstreamUrl = await new Promise(r => upstream.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${upstream.address().port}`)));
  t.after(() => new Promise(r => upstream.close(r)));
  const root = process.env.ZHISUDA_TEST_ROOT || path.resolve(app, "..", "..", "_verification"); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "genfail-"));
  const child = spawn(process.execPath, ["server.js"], { cwd: app, windowsHide: true, env: { ...process.env, PORT: "0", ZHISUDA_DATA_DIR: directory, LLM_MOCK: "0", LLM_API_KEY: "", LLM_BASE_URL: "", LLM_MODEL: "" } });
  t.after(async () => { if (child.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill(); await done; } });
  const base = await new Promise((resolve, reject) => {
    let out = ""; const timer = setTimeout(() => reject(new Error("测试服务启动超时")), 15000);
    child.stdout.on("data", d => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } });
    child.once("error", reject);
  });
  let cookie = "";
  const req = async (route, method = "GET", body, status = 200) => {
    const res = await fetch(base + route, { method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    cookie = res.headers.get("set-cookie")?.split(";")[0] || cookie;
    const data = await res.json(); assert.equal(res.status, status, JSON.stringify(data)); return data;
  };
  const { draft } = await req("/api/demo", "POST", {});
  const { publication } = await req(`/api/drafts/${draft.id}/publish`, "POST", { revision: draft.revision, reviewMode: "self-study" });
  const before = await req("/api/state");

  const input = demoInput(), modelConfig = { baseUrl: upstreamUrl + "/v1", model: "fixture", apiKey: "local-fixture-key" };
  const { jobId } = await req("/api/generation-jobs", "POST", { source: input.source, course: input.course, questionCount: 3, modelConfig }, 202);
  let job;
  for (let i = 0; i < 100; i++) { ({ job } = await req("/api/generation-jobs/" + jobId)); if (["done", "failed"].includes(job.stage)) break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(job.stage, "failed"); assert.match(job.error, /HTTP 500/); assert.ok(!job.error.includes("local-fixture-key"));
  await new Promise(r => setTimeout(r, 100));
  assert.equal(calls, 1, "失败后服务端不应自动重试");

  const after = await req("/api/state");
  assert.deepEqual(after.drafts.map(d => d.id), before.drafts.map(d => d.id));
  assert.deepEqual(after.publications.map(p => p.id), [publication.id]);
  assert.equal(after.activeJobId, null);
  await req(`/api/publications/${publication.id}/student`);
  // 失败任务不占用“进行中”名额，用户可立即重新发起。
  await req("/api/generation-jobs", "POST", { source: input.source, course: input.course, questionCount: 1, modelConfig }, 202);
});
