import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docxFixture } from "./fixtures.js";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function start(directory) {
  const child = spawn(process.execPath, ["server.js"], { cwd: appDir, windowsHide: true,
    env: { ...process.env, PORT: "0", ZHISUDA_DATA_DIR: directory, LLM_MOCK: "1" } });
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("测试服务启动超时")); }, 15000);
    child.stderr.on("data", data => { output += data; });
    child.stdout.on("data", data => { output += data; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.once("error", err => { clearTimeout(timer); reject(err); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`测试服务退出 ${code}: ${output}`)); });
  });
  return { url, async close() { if (child.exitCode !== null) return; const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } };
}

test("API：生成演示→编辑→审核→发布→作答→反馈→重启恢复", async t => {
  const root = process.env.ZHISUDA_TEST_ROOT || path.resolve(appDir, "..", "..", "_verification");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "api-"));
  let service = await start(directory);
  t.after(async () => { await service.close(); });
  let cookie = "";
  const req = async (route, method = "GET", body, expected = 200) => {
    const res = await fetch(service.url + route, { method, headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    cookie = res.headers.get("set-cookie")?.split(";")[0] || cookie;
    const data = await res.json(); assert.equal(res.status, expected, JSON.stringify(data)); return data;
  };
  assert.deepEqual((await req("/api/state")).drafts, []);
  const upload = await fetch(service.url + "/api/import?name=notes.docx", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: docxFixture() });
  assert.equal(upload.status, 200);
  const imported = (await upload.json()).document;
  assert.equal(imported.kind, "docx"); assert.equal(imported.blocks.length, 3);
  assert.deepEqual((await req("/api/state")).drafts, []); // 上传预览不会产生草稿或调用模型
  await req("/api/generate", "POST", { source: "太短" }, 400);
  const nullBody = await fetch(service.url + "/api/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: "null" });
  assert.equal(nullBody.status, 400);
  const origin = await fetch(service.url + "/api/demo", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://other.example" }, body: "{}" });
  assert.equal(origin.status, 403);
  let { draft: d } = await req("/api/demo", "POST", {});
  const id = d.questions[0].id, original = d;
  ({ draft: d } = await req(`/api/drafts/${d.id}/questions/${id}`, "PATCH", { revision: d.revision, changes: { explanation: "主动回忆是在不看资料时尝试提取信息。" } }));
  await req(`/api/drafts/${d.id}/questions/${id}`, "PATCH", { revision: original.revision, review: "approved", evidenceConfirmed: true }, 409);
  await req(`/api/drafts/${d.id}/publish`, "POST", { revision: d.revision }, 422);
  for (const q of d.questions) ({ draft: d } = await req(`/api/drafts/${d.id}/questions/${q.id}`, "PATCH", { revision: d.revision, review: q.quoteFound ? "approved" : "rejected", evidenceConfirmed: q.quoteFound }));
  const { publication: p } = await req(`/api/drafts/${d.id}/publish`, "POST", { revision: d.revision });
  const duplicate = await req(`/api/drafts/${d.id}/publish`, "POST", { revision: d.revision });
  assert.equal(duplicate.publication.id, p.id);
  assert.equal(p.questions.length, 5);
  const { pack } = await req(`/api/publications/${p.id}/student`);
  assert.ok(pack.questions.every(q => !Object.hasOwn(q, "answer") && !Object.hasOwn(q, "quote")));
  const qs = pack.questions.filter(q => q.level === "标准");
  const answers = Object.fromEntries(qs.map(q => [q.id, q.type === "选择" ? "A" : "简答需要核对要点"]));
  const { attempt: a } = await req(`/api/publications/${p.id}/attempts`, "POST", { questionIds: qs.map(q => q.id), answers, nickname: "自动测试样例" });
  await req(`/api/attempts/${a.id}/feedback`, "POST", { difficulty: "合适", assessments: {} }, 422);
  await req(`/api/attempts/${a.id}/feedback`, "POST", { difficulty: "合适", assessments: { [qs[1].id]: "未掌握" }, stuck: "自动测试反馈，不是真实学生数据" });
  await req(`/api/attempts/${a.id}/feedback`, "POST", {}, 409);
  const { report } = await req(`/api/publications/${p.id}/report`);
  assert.equal(report.completed, 1); assert.equal(report.objectiveCount, 1); assert.equal(report.objectiveCorrect, 0);
  const exported = await req(`/api/publications/${p.id}/export`);
  assert.equal(exported.format, "zhisuda.review-pack.v1");
  assert.equal(Object.hasOwn(exported.publication, "source"), false);
  assert.equal(Object.hasOwn(exported.publication, "attempts"), false);
  await service.close(); service = await start(directory);
  const restored = await req("/api/state");
  assert.equal(restored.drafts[0].id, d.id); assert.equal(restored.publications[0].id, p.id);
  assert.equal((await req(`/api/publications/${p.id}/report`)).report.completed, 1);
  assert.equal(JSON.parse(await readFile(path.join(directory, "workspaces", cookie.split("=")[1], "workspace.json"), "utf8")).attempts.length, 1);
});

test("API：默认自助练习与可选人工核对分别保存，练习及未核对标识重启后保留", async t => {
  const root = process.env.ZHISUDA_TEST_ROOT || path.resolve(appDir, "..", "..", "_verification");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "self-study-"));
  let service = await start(directory);
  t.after(async () => { await service.close(); });
  let cookie = "";
  const req = async (route, method = "GET", body, expected = 200) => {
    const res = await fetch(service.url + route, { method, headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    cookie = res.headers.get("set-cookie")?.split(";")[0] || cookie;
    const result = await res.json(); assert.equal(res.status, expected, JSON.stringify(result)); return result;
  };
  let { draft: d } = await req("/api/demo", "POST", {});
  const route = `/api/drafts/${d.id}/publish`;
  const { publication: direct } = await req(route, "POST", { revision: d.revision, reviewMode: "self-study" });
  assert.equal(direct.unreviewedCount, 5); assert.equal(direct.excludedCount, 1);
  assert.equal((await req(route, "POST", { revision: d.revision, reviewMode: "self-study" })).publication.id, direct.id);
  await req(route, "POST", { revision: d.revision }, 422);
  await req(route, "POST", { revision: d.revision, reviewMode: "invalid" }, 400);
  assert.ok((await req(`/api/drafts/${d.id}`)).draft.questions.every(q => q.review === "pending"));
  const { pack } = await req(`/api/publications/${direct.id}/student`);
  assert.equal(pack.unreviewedCount, 5);
  const q = pack.questions[0];
  assert.equal((await req(`/api/publications/${pack.id}/attempts`, "POST", { questionIds: [q.id], answers: { [q.id]: "B" } })).attempt.results[0].correct, true);
  for (const q of d.questions) ({ draft: d } = await req(`/api/drafts/${d.id}/questions/${q.id}`, "PATCH", { revision: d.revision, review: q.quoteFound ? "approved" : "rejected", evidenceConfirmed: q.quoteFound }));
  const { publication: checked } = await req(route, "POST", { revision: d.revision });
  const { publication: checkedDirect } = await req(route, "POST", { revision: d.revision, reviewMode: "self-study" });
  assert.notEqual(checked.id, checkedDirect.id); assert.equal(checked.reviewMode, "reviewed"); assert.equal(checked.unreviewedCount, 0);
  const exported = await req(`/api/publications/${direct.id}/export`);
  assert.equal(exported.publication.unreviewedCount, 5); assert.ok(!Object.hasOwn(exported.publication, "source"));
  await service.close(); service = await start(directory);
  assert.equal((await req(`/api/publications/${direct.id}/student`)).pack.unreviewedCount, 5);
  assert.equal((await req("/api/state")).publications.find(p => p.id === direct.id).reviewMode, "self-study");
});
