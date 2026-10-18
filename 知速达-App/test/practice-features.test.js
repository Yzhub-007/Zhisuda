import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { demoInput } from "../lib/demo.js";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function start() {
  const root = path.resolve(app, "..", "..", "_verification"); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "features-"));
  const child = spawn(process.execPath, ["server.js"], { cwd: app, windowsHide: true, env: { ...process.env, PORT: "0", ZHISUDA_DATA_DIR: directory, LLM_MOCK: "1" } });
  const url = await new Promise((resolve, reject) => {
    let output = ""; const timer = setTimeout(() => reject(new Error("测试服务启动超时")), 15000);
    child.stdout.on("data", data => { output += data; const found = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (found) { clearTimeout(timer); resolve(found[0]); } });
    child.stderr.on("data", data => { output += data; }); child.once("error", reject);
  });
  return { url, async close() { if (child.exitCode === null) { const done = new Promise(resolve => child.once("exit", resolve)); child.kill(); await done; } } };
}
function client(base) {
  let cookie = "";
  return async (route, method = "GET", body, status = 200) => {
    const res = await fetch(base + route, { method, headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    cookie = res.headers.get("set-cookie")?.split(";")[0] || cookie;
    const data = await res.json(); assert.equal(res.status, status, JSON.stringify(data)); return data;
  };
}

test("练习：工作区隔离、幂等提交、错题收录与重做掌握", async t => {
  const service = await start(); t.after(() => service.close());
  const first = client(service.url), second = client(service.url);
  let { draft } = await first("/api/demo", "POST", {});
  const { publication } = await first(`/api/drafts/${draft.id}/publish`, "POST", { revision: draft.revision, reviewMode: "self-study" });
  const { pack } = await first(`/api/publications/${publication.id}/student`);
  assert.deepEqual((await second("/api/state")).publications, []);
  await second(`/api/publications/${publication.id}/student`, "GET", undefined, 404);

  const choice = pack.questions.find(q => q.type === "选择"), submissionId = randomUUID();
  const wrong = await first(`/api/publications/${pack.id}/attempts`, "POST", { questionIds: [choice.id], answers: { [choice.id]: "A" }, submissionId });
  const repeated = await first(`/api/publications/${pack.id}/attempts`, "POST", { questionIds: [choice.id], answers: { [choice.id]: "A" }, submissionId });
  assert.equal(repeated.attempt.id, wrong.attempt.id);
  assert.equal((await first("/api/mistakes")).mistakes[0].state, "未掌握");
  await first(`/api/publications/${pack.id}/attempts`, "POST", { questionIds: [choice.id], answers: { [choice.id]: "B" }, submissionId: randomUUID() });
  const mastered = (await first("/api/mistakes")).mistakes.find(m => m.questionId === choice.id);
  assert.equal(mastered.state, "掌握"); assert.equal(mastered.wrongCount, 1);

  const written = pack.questions.find(q => q.type === "简答");
  const { attempt } = await first(`/api/publications/${pack.id}/attempts`, "POST", { questionIds: [written.id], answers: { [written.id]: "我的自测回答" }, submissionId: randomUUID() });
  await first(`/api/attempts/${attempt.id}/assessments`, "PATCH", { assessments: { [written.id]: "部分掌握" } });
  assert.equal((await first("/api/mistakes")).mistakes.find(m => m.questionId === written.id).state, "部分掌握");
});

test("生成任务：校验自选题数并返回真实阶段与题数", async t => {
  const service = await start(); t.after(() => service.close()); const req = client(service.url), input = demoInput();
  await req("/api/generation-jobs", "POST", { source: input.source, questionCount: 0 }, 400);
  const { jobId } = await req("/api/generation-jobs", "POST", { source: input.source, course: input.course, questionCount: 1 }, 202);
  let job;
  for (let i = 0; i < 20; i++) {
    ({ job } = await req("/api/generation-jobs/" + jobId));
    if (["done", "failed"].includes(job.stage)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(job.stage, "done");
  const { draft } = await req("/api/drafts/" + job.draftId);
  assert.equal(draft.questions.length, 1); assert.equal(draft.generation.requestedCount, 1);
});
