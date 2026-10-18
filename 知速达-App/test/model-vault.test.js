import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createModelVault, localSaveSupported } from "../lib/model-vault.js";
import { demoInput } from "../lib/demo.js";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function temporary() {
  const root = process.env.ZHISUDA_TEST_ROOT || path.resolve(app, "..", "..", "_verification");
  await mkdir(root, { recursive: true }); return mkdtemp(path.join(root, "vault-"));
}
async function start(t, directory) {
  const child = spawn(process.execPath, ["server.js"], { cwd: app, windowsHide: true, env: { ...process.env, PORT: "0", ZHISUDA_DATA_DIR: directory, LLM_MOCK: "0", LLM_API_KEY: "", LLM_BASE_URL: "", LLM_MODEL: "" } });
  let logs = "";
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) { const done = new Promise(resolve => child.once("exit", resolve)); child.kill(); await done; } };
  t.after(stop);
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("测试服务启动超时")), 15000);
    child.stdout.on("data", data => { logs += data; const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.stderr.on("data", data => { logs += data; });
    child.once("error", e => { clearTimeout(timer); reject(e); });
  });
  return { stop, logs: () => logs, client(cookie = "") {
    return { get cookie() { return cookie; }, async req(route, method = "GET", body, status = 200) {
      const res = await fetch(base + route, { method, headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      cookie = res.headers.get("set-cookie")?.split(";")[0] || cookie;
      const data = await res.json(); assert.equal(res.status, status, JSON.stringify(data)); return data;
    } };
  } };
}

test("本机保险库：Windows 加密、工作区绑定、损坏不覆盖、主动忘记", { skip: !localSaveSupported }, async () => {
  const directory = await temporary(), owner = "fixture-owner";
  const config = { baseUrl: "https://fixture.invalid/v1", model: "fixture-model", apiKey: "fictional-key-never-in-plaintext", jsonMode: true };
  const vault = createModelVault(directory, owner);
  assert.equal(await vault.status(), null);
  const metadata = await vault.save(config), filename = path.join(directory, "model-settings.enc.json");
  const encrypted = await readFile(filename, "utf8");
  assert.ok(!encrypted.includes(config.apiKey)); assert.ok(!JSON.stringify(metadata).includes(config.apiKey));
  const reopened = createModelVault(directory, owner);
  assert.equal((await reopened.read()).apiKey, config.apiKey);
  await assert.rejects(createModelVault(directory, "another-workspace").read(), /解锁/);
  assert.equal(await readFile(filename, "utf8"), encrypted);
  await writeFile(filename, JSON.stringify({ version: 1, saved: true, metadata, ciphertext: "not-valid-dpapi" }));
  await assert.rejects(vault.read(), /解锁/);
  assert.ok((await readFile(filename, "utf8")).includes("not-valid-dpapi"));
  await vault.forget(); assert.equal(await vault.status(), null); await assert.rejects(vault.read(), /尚未记住/);
});

test("记住 API：重启后使用、密钥不回传、不改投地址、不进入备份、其他工作区不能使用", { skip: !localSaveSupported }, async t => {
  const input = demoInput(), received = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(input.pack) } }] }));
  });
  const upstreamUrl = await new Promise(resolve => upstream.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${upstream.address().port}/v1`)));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const directory = await temporary(); let server = await start(t, directory), client = server.client();
  const config = { baseUrl: upstreamUrl, model: "fixture-model", apiKey: "fictional-encrypted-key", jsonMode: true };
  const saved = await client.req("/api/model/settings", "POST", { remember: true, modelConfig: config });
  assert.equal(saved.saved.model, config.model); assert.equal(received.length, 0);
  const before = await client.req("/api/state"); assert.ok(before.model.saved);
  assert.ok(!JSON.stringify({ saved, before }).includes(config.apiKey));
  await server.client().req("/api/generate", "POST", { source: input.source, modelConfig: { useSaved: true } }, 400);
  await client.req("/api/model/test", "POST", { modelConfig: { useSaved: true, baseUrl: "https://changed.invalid" } }, 400);
  assert.equal(received.length, 0);
  const cookie = client.cookie; await server.stop(); server = await start(t, directory); client = server.client(cookie);
  const { draft } = await client.req("/api/generate", "POST", { source: input.source, modelConfig: { useSaved: true } });
  assert.equal(received[0].auth, "Bearer " + config.apiKey);
  assert.equal(draft.generation.model, config.model);
  const backup = await client.req("/api/workspace/export");
  assert.equal(backup.drafts.length, 1); assert.ok(!JSON.stringify(backup).includes(config.apiKey));
  const raw = await readFile(path.join(directory, "workspaces", cookie.split("=")[1], "workspace.json"), "utf8");
  assert.ok(!raw.includes(config.apiKey)); assert.ok(!server.logs().includes(config.apiKey));
  await client.req("/api/model/settings", "POST", { remember: false, modelConfig: config });
  assert.equal((await client.req("/api/state")).model.saved, null);
  await client.req("/api/model/test", "POST", { modelConfig: { useSaved: true } }, 400);
  await client.req("/api/model/settings/forget", "POST", {});
  assert.equal(received.length, 1);
});

test("全部记录备份：独立恢复、幂等合并、不误收仅题目 JSON、不包含模型配置", async t => {
  const server = await start(t, await temporary()), a = server.client();
  const { draft } = await a.req("/api/demo", "POST", {});
  const { publication } = await a.req(`/api/drafts/${draft.id}/publish`, "POST", { revision: draft.revision, reviewMode: "self-study" });
  const question = publication.questions[0];
  await a.req(`/api/publications/${publication.id}/attempts`, "POST", { questionIds: [question.id], answers: { [question.id]: question.type === "选择" ? "A" : "用于备份验证的作答" } });
  const backup = await a.req("/api/workspace/export");
  assert.equal(backup.format, "zhisuda.workspace.v1"); assert.equal(backup.attempts.length, 1);
  assert.ok(!Object.hasOwn(backup, "modelConfig"));
  const b = server.client(); await b.req("/api/state");
  await b.req("/api/workspace/import", "POST", backup);
  await b.req("/api/workspace/import", "POST", backup);
  const restored = await b.req("/api/workspace/export");
  assert.deepEqual(restored.drafts, backup.drafts); assert.deepEqual(restored.publications, backup.publications); assert.deepEqual(restored.attempts, backup.attempts);
  const onlyQuestions = await a.req(`/api/publications/${publication.id}/export`);
  const rejected = await b.req("/api/workspace/import", "POST", onlyQuestions, 400); assert.match(rejected.error, /仅含题目/);
});
