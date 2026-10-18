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
  const root = process.env.ZHISUDA_TEST_ROOT || path.resolve(app, "..", "..", "_verification"); await mkdir(root, { recursive: true });
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

  const { history } = await first("/api/history"), other = await second("/api/history");
  assert.equal(history.length, 3); assert.equal(other.history.length, 0);
  assert.equal(history[0].writtenTotal, 1); assert.equal(history[0].writtenAssessed, 1);
  assert.equal(history[1].objectiveCorrect, 1); assert.equal(history[2].objectiveCorrect, 0);
});

test("学习与测试：先作答才给单题反馈，核对不增加场次，完成后保留模式与自评", async t => {
  const service = await start(); t.after(() => service.close());
  const req = client(service.url), other = client(service.url);
  const { draft } = await req("/api/demo", "POST", {});
  const { publication: pack } = await req(`/api/drafts/${draft.id}/publish`, "POST", { revision: draft.revision, reviewMode: "self-study" });
  const route = `/api/publications/${pack.id}`;
  const written = pack.questions.find(q => q.type === "简答"), choice = pack.questions.find(q => q.type === "选择");
  const payload = { questionIds: [written.id], answers: { [written.id]: "我的回答" } };
  await req(route + "/check", "POST", { questionIds: [written.id], answers: {} }, 422);
  await req(route + "/check", "POST", { questionIds: [written.id, choice.id], answers: {} }, 400);
  await other(route + "/check", "POST", payload, 404);
  const { result } = await req(route + "/check", "POST", payload);
  assert.equal(result.questionId, written.id); assert.equal(result.answer, written.answer); assert.equal(result.quote, written.quote);
  assert.equal((await req("/api/history")).history.length, 0);
  assert.equal((await req("/api/mistakes")).mistakes.length, 0);
  const { attempt } = await req(route + "/attempts", "POST", { ...payload, practiceMode: "study", assessments: { [written.id]: "部分掌握" }, submissionId: randomUUID() });
  assert.equal(attempt.practiceMode, "study"); assert.equal(attempt.results[0].selfAssessment, "部分掌握");
  assert.equal((await req("/api/mistakes")).mistakes[0].state, "部分掌握");
  const testInput = { questionIds: [choice.id], answers: { [choice.id]: choice.answer }, practiceMode: "test", submissionId: randomUUID() };
  const testAttempt = (await req(route + "/attempts", "POST", testInput)).attempt;
  const repeat = (await req(route + "/attempts", "POST", testInput)).attempt;
  assert.equal(testAttempt.id, repeat.id);
  const { history } = await req("/api/history");
  assert.deepEqual(history.map(h => h.practiceMode), ["test", "study"]);
  assert.equal(history[1].writtenAssessed, 1);
  assert.equal((await req("/api/attempts/" + attempt.id)).attempt.results[0].selfAssessment, "部分掌握");
  await req(route + "/attempts", "POST", { ...payload, practiceMode: "invalid" }, 400);
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

test("范围选择：只使用所选章节，未选内容不进入草稿，非法范围被拒绝", async t => {
  const service = await start(); t.after(() => service.close()); const req = client(service.url);
  const part = (name, n) => `${name}的核心概念是${"记忆需要反复提取并结合例子理解，".repeat(n)}`;
  const blocks = [part("第一章", 8), part("第二章", 8), part("第三章", 8)].map((text, i) => ({ text, label: `第 ${i + 1} 段` }));
  const source = blocks.map(b => b.text).join("\n\n"), sourceDocument = { name: "讲义", kind: "text", blocks };
  const base = { source, sourceDocument, course: "测试课", questionCount: 1 };
  const finish = async payload => {
    const { jobId } = await req("/api/generation-jobs", "POST", payload, 202); let job;
    for (let i = 0; i < 50; i++) { ({ job } = await req("/api/generation-jobs/" + jobId)); if (["done", "failed"].includes(job.stage)) break; await new Promise(r => setTimeout(r, 20)); }
    return job;
  };
  await req("/api/generation-jobs", "POST", { ...base, blockIds: [] }, 400);
  await req("/api/generation-jobs", "POST", { ...base, blockIds: ["b99"] }, 400);
  await req("/api/generation-jobs", "POST", { source, questionCount: 1, blockIds: ["b1"] }, 400);
  const job = await finish({ ...base, blockIds: ["b2", "b3"] });
  if (job.stage === "failed") assert.fail(job.error);
  const { draft } = await req("/api/drafts/" + job.draftId);
  assert.deepEqual(draft.sourceDocument.blocks.map(b => b.label), ["第 2 段", "第 3 段"]);
  assert.ok(!draft.source.includes("第一章")); assert.deepEqual(draft.generation.scope, { selected: 2, total: 3 });
});

test("题型与难度组合：只生成所选组合，非法取值被拒绝", async t => {
  const service = await start(); t.after(() => service.close()); const req = client(service.url), input = demoInput();
  const base = { source: input.source, course: input.course, questionCount: 5 };
  await req("/api/generation-jobs", "POST", { ...base, questionTypes: [] }, 400);
  await req("/api/generation-jobs", "POST", { ...base, questionTypes: ["判断"] }, 400);
  await req("/api/generation-jobs", "POST", { ...base, levels: "基础" }, 400);
  const { jobId } = await req("/api/generation-jobs", "POST", { ...base, questionTypes: ["选择"], levels: ["基础", "标准"] }, 202); let job;
  for (let i = 0; i < 50; i++) { ({ job } = await req("/api/generation-jobs/" + jobId)); if (["done", "failed"].includes(job.stage)) break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(job.stage, "done", job.error);
  const { draft } = await req("/api/drafts/" + job.draftId);
  assert.ok(draft.questions.length >= 1);
  assert.ok(draft.questions.every(q => q.type === "选择" && ["基础", "标准"].includes(q.level)));
  assert.deepEqual(draft.generation.questionTypes, ["选择"]);
});
