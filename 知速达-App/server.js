import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chatJson, llmConfig } from "./lib/llm.js";
import { summarize } from "./lib/verify.js";
import { GENERATE_SYSTEM, FEEDBACK_SYSTEM, generateUser } from "./lib/prompts.js";
import { createDraft, feedbackReport, publishDraft, saveAssessments, saveFeedback, studentPack, submitAttempt, updateQuestion } from "./lib/workflow.js";
import { mistakeBook, attemptHistory } from "./lib/mistakes.js";
import { demoInput } from "./lib/demo.js";
import { createStore } from "./lib/store.js";
import { createModelVault, localSaveSupported, resolveModelConfig } from "./lib/model-vault.js";
import { importDocument, validateDocument, scopeDocument, MAX_FILE } from "./lib/sources.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MAX_BODY = 900_000; // 含提取文字和位置数据；中文 UTF-8 通常每字3字节
const MAX_SOURCE = 60_000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const DATA = process.env.ZHISUDA_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const stores = new Map(), vaults = new Map(), jobs = new Map();
function workspace(req, res) {
  let token = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith("zhisuda_workspace="))?.slice(18);
  if (!/^[0-9a-f-]{36}$/.test(token || "")) {
    token = randomUUID();
    res.setHeader("Set-Cookie", `zhisuda_workspace=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
  }
  const directory = path.join(DATA, "workspaces", token);
  if (!stores.has(token)) stores.set(token, createStore(directory));
  if (!vaults.has(token)) vaults.set(token, createModelVault(directory, token));
  return { store: stores.get(token), vault: vaults.get(token), token };
}
let importing = false;

function readBuffer(req, maximum) {
  return new Promise((resolve, reject) => {
    let size = 0, tooLarge = false;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > maximum) { if (!tooLarge) reject(Object.assign(new Error("文件超过 12 MB，请按章节拆分。"), { status: 413 })); tooLarge = true; chunks.length = 0; }
      else if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => { if (!tooLarge) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
    req.on("aborted", () => reject(Object.assign(new Error("上传已中断。"), { status: 400 })));
  });
}

function readJson(req, maximum = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0, tooLarge = false;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maximum) {
        if (!tooLarge) reject(Object.assign(new Error("内容过长。"), { status: 413 }));
        tooLarge = true; chunks.length = 0; return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
        resolve(body);
      }
      catch { reject(Object.assign(new Error("请求不是合法 JSON。"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

const send = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(obj));
};

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const pathPart = (url, index) => decodeURIComponent(url.pathname.split("/")[index] ?? "");

async function getDraft(store, id) {
  const data = await store.read();
  const draft = data.drafts.find(item => item.id === id);
  if (!draft) throw Object.assign(new Error("草稿不存在或已被删除。"), { status: 404 });
  return { data, draft };
}

async function getPublication(store, id) {
  const data = await store.read();
  const publication = data.publications.find(item => item.id === id);
  if (!publication) throw Object.assign(new Error("复习包不存在。"), { status: 404 });
  return { data, publication };
}

async function handle(req, res) {
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(req.headers.host || "")) return send(res, 403, { error: "请使用本机地址打开知速达。" });
  const url = new URL(req.url, "http://localhost");
  if (!["GET", "HEAD"].includes(req.method)) {
    // 本地工作台也拒绝来自其他网站的写请求，防止意外写入或触发模型调用。
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: "请从本地工作台发起请求。" });
    const allowed = url.pathname === "/api/import" ? req.headers["content-type"] === "application/octet-stream" : req.headers["content-type"]?.startsWith("application/json");
    if (!allowed) return send(res, 415, { error: "请求格式不正确，请从页面重新操作。" });
  }

  const { store, vault, token } = workspace(req, res);

  if (req.method === "GET" && url.pathname === "/api/workspace/export") {
    const { schema, drafts, publications, attempts } = await store.read();
    return send(res, 200, { format: "zhisuda.workspace.v1", exportedAt: new Date().toISOString(), schema, drafts, publications, attempts });
  }

  if (req.method === "POST" && url.pathname === "/api/model/settings") {
    const b = await readJson(req);
    if (typeof b.remember !== "boolean" || !b.modelConfig) return send(res, 400, { error: "请选择 API 保存方式并填写设置。" });
    const config = await resolveModelConfig(b.modelConfig, vault);
    if (!b.remember && b.modelConfig.useSaved) return send(res, 400, { error: "切换为仅本次使用时，请重新填写密钥。" });
    if (b.remember) return send(res, 200, { saved: await vault.save(config) });
    if (await vault.status()) await vault.forget();
    return send(res, 200, { saved: null });
  }

  if (req.method === "POST" && url.pathname === "/api/model/settings/forget") {
    await readJson(req); await vault.forget();
    return send(res, 200, { forgotten: true });
  }

  if (req.method === "GET" && /^\/api\/generation-jobs\/[^/]+$/.test(url.pathname)) {
    const job = jobs.get(pathPart(url, 3));
    if (!job || job.owner !== token) return send(res, 404, { error: "生成任务不存在，可能服务已重启。请先到复习包和草稿中检查，再决定是否重新生成。" });
    const { owner, ...visible } = job;
    return send(res, 200, { job: visible });
  }

  if (req.method === "GET" && url.pathname === "/api/mistakes") return send(res, 200, { mistakes: mistakeBook(await store.read()) });

  if (req.method === "GET" && url.pathname === "/api/history") return send(res, 200, { history: attemptHistory(await store.read()) });

  if (req.method === "GET" && /^\/api\/attempts\/[^/]+$/.test(url.pathname)) {
    const attempt = (await store.read()).attempts.find(a => a.id === pathPart(url, 3));
    return attempt ? send(res, 200, { attempt }) : send(res, 404, { error: "练习记录不存在。" });
  }

  if (req.method === "PATCH" && /^\/api\/attempts\/[^/]+\/assessments$/.test(url.pathname)) {
    const input = await readJson(req);
    let attempt;
    await store.update(data => {
      const index = data.attempts.findIndex(a => a.id === pathPart(url, 3));
      if (index < 0) throw Object.assign(new Error("练习记录不存在。"), { status: 404 });
      attempt = saveAssessments(data.attempts[index], input); data.attempts[index] = attempt;
    });
    return send(res, 200, { attempt });
  }

  if (req.method === "POST" && url.pathname === "/api/workspace/import") {
    // 仅导入用户在浏览器主动选择的备份，绝不自动认领旧版共享数据。
    const old = await readJson(req, 20 * 1024 * 1024);
    if (old.format === "zhisuda.review-pack.v1") return send(res, 400, { error: "这是仅含题目的 JSON，不能恢复学习记录。请选择“备份全部学习记录”下载的文件，或旧版 workspace.json。" });
    if (old.schema !== 1 || ![old.drafts, old.publications, old.attempts].every(Array.isArray)) return send(res, 400, { error: "请选择“备份全部学习记录”下载的 JSON，或旧版 workspace.json。" });
    const valid = old.drafts.every(d => typeof d.id === "string" && Array.isArray(d.questions) && typeof d.source === "string") && old.publications.every(p => typeof p.id === "string" && Array.isArray(p.questions)) && old.attempts.every(a => typeof a.id === "string" && Array.isArray(a.results));
    if (!valid) return send(res, 400, { error: "备份格式不完整，未导入。" });
    await store.update(data => {
      for (const key of ["drafts", "publications", "attempts"]) {
        const known = new Set(data[key].map(row => row.id));
        for (const item of old[key]) if (!known.has(item.id)) { data[key].push(item); known.add(item.id); }
      }
    });
    return send(res, 200, { imported: true });
  }

  if (req.method === "POST" && url.pathname === "/api/import") {
    if (importing) return send(res, 429, { error: "已有文件正在解析，请稍后再试。" });
    importing = true;
    try {
      const buffer = await readBuffer(req, MAX_FILE);
      const document = await importDocument(buffer, url.searchParams.get("name") || "");
      return send(res, 200, { document });
    } finally { importing = false; }
  }

  if (req.method === "POST" && url.pathname === "/api/model/test") {
    const b = await readJson(req);
    if (b.modelConfig === undefined) return send(res, 400, { error: "请先填写自己的模型设置。" });
    const cfg = await resolveModelConfig(b.modelConfig, vault), started = Date.now();
    // 测试不使用课程资料，也不创建草稿；只核对兼容接口能返回 JSON 对象。
    await chatJson("这是接口连接测试。请只返回 JSON 对象，不要使用 Markdown。", '请返回 {"ok":true}。', cfg, 25_000);
    return send(res, 200, { connected: true, elapsedMs: Date.now() - started });
  }

  if (req.method === "POST" && ["/api/generate", "/api/generation-jobs"].includes(url.pathname)) {
    const b = await readJson(req);
    const cfg = await resolveModelConfig(b.modelConfig, vault);
    if (typeof b.source === "string" && b.source.length > MAX_SOURCE) return send(res, 413, { error: "单次材料不超过60000字符，请按讲次拆分。" });
    const source = str(b.source, MAX_SOURCE);
    if (source.length < 200) return send(res, 400, { error: "讲义内容太短，请粘贴至少 200 字的讲义文字。" });
    const fullDocument = validateDocument(b.sourceDocument, source);
    let sourceDocument = fullDocument;
    if (b.blockIds !== undefined) {
      if (!b.sourceDocument) return send(res, 400, { error: "按章节选择范围需要先导入 DOCX 或 PDF 文件。" });
      sourceDocument = scopeDocument(fullDocument, b.blockIds);
      if (sourceDocument.text.length < 200) return send(res, 400, { error: "所选范围不足 200 字，请多选几个章节或页面。" });
    }
    const questionCount = b.questionCount === undefined ? 6 : b.questionCount;
    if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 30) return send(res, 400, { error: "题数需要是 1—30 的整数。" });
    // 题型、难度组合：只接受已知取值的非空子集；不传表示不限制。
    const pick = (value, allowed, label) => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || !value.length || value.some(v => !allowed.includes(v))) throw Object.assign(new Error(`${label}选择无效，请至少选择一项。`), { status: 400 });
      return allowed.filter(v => value.includes(v));
    };
    let questionTypes, levels;
    try { questionTypes = pick(b.questionTypes, ["选择", "简答"], "题型"); levels = pick(b.levels, ["基础", "标准", "拓展"], "难度"); }
    catch (e) { return send(res, 400, { error: e.message }); }
    const active = [...jobs.values()].find(j => j.owner === token && !["done", "failed"].includes(j.stage));
    if (active) return send(res, 409, { error: "已有生成任务，请先等待它完成。", jobId: active.id });
    const started = Date.now();
    const run = async (job) => {
    if (job) job.stage = "model";
    const raw = await chatJson(GENERATE_SYSTEM, generateUser({
      course: str(b.course, 100) || "未命名课程",
      topic: str(b.topic, 100) || "未命名主题",
      goal: str(b.goal, 100) || "期末复习",
      source: sourceDocument.text,
      sourceDocument,
      questionCount, questionTypes, levels,
    }), cfg);
    if (job) job.stage = "validate";
    // 模型多返回时不超过所选题数；少返回时不复制或编造题目补齐。
    // 模型不遵守题型／难度限制时，在服务端过滤掉，不让越界题目进入复习包。
    if (Array.isArray(raw.questions)) {
      const before = raw.questions.length;
      raw.questions = raw.questions.filter(q => (!questionTypes || questionTypes.includes(q?.type)) && (!levels || levels.includes(q?.level))).slice(0, questionCount);
      raw._offLimit = Math.max(0, before - raw.questions.length);
    }
    const draft = createDraft({ course: b.course, topic: b.topic, goal: b.goal, source: sourceDocument.text, sourceDocument }, raw, cfg.mock ? "mock" : "live");
    draft.generation = { requestedCount: questionCount, questionTypes: questionTypes || null, levels: levels || null, scope: b.blockIds === undefined ? null : { selected: sourceDocument.blocks.length, total: fullDocument.blocks.length }, elapsedMs: Date.now() - started, model: cfg.mock ? "固定模拟数据" : cfg.model, usage: raw._usage || null };
    if (job) job.stage = "save";
    await store.update(data => { data.drafts.push(draft); });
    return draft;
    };
    if (url.pathname === "/api/generate") {
      const draft = await run(); return send(res, 200, { draft, summary: summarize(draft) });
    }
    for (const [key, job] of jobs) if (["done", "failed"].includes(job.stage) && Date.now() - job.startedAt > 3_600_000) jobs.delete(key);
    const job = { id: randomUUID(), owner: token, stage: "prepare", startedAt: started, requestedCount: questionCount };
    jobs.set(job.id, job);
    send(res, 202, { jobId: job.id });
    void run(job).then(draft => { job.stage = "done"; job.draftId = draft.id; }).catch(e => { job.stage = "failed"; job.error = e.status ? e.message : "生成失败，原有资料与复习包未改变。"; });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/demo") {
    await readJson(req);
    const input = demoInput();
    const draft = createDraft(input, input.pack, "demo");
    await store.update(data => { data.drafts.push(draft); });
    return send(res, 200, { draft, summary: summarize(draft) });
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    const data = await store.read();
    let saved = null, settingsError = "";
    try { saved = await vault.status(); } catch (e) { settingsError = e.message; }
    return send(res, 200, {
      activeJobId: [...jobs.values()].find(j => j.owner === token && !["done", "failed"].includes(j.stage))?.id || null,
      drafts: [...data.drafts].reverse().map(d => ({ id: d.id, course: d.course, topic: d.topic, mode: d.mode, revision: d.revision, updatedAt: d.updatedAt, total: d.questions.length, approved: d.questions.filter(q => q.review === "approved").length })),
      publications: [...data.publications].reverse().map(p => ({ id: p.id, course: p.course, topic: p.topic, mode: p.mode, reviewMode: p.reviewMode || "reviewed", unreviewedCount: p.unreviewedCount || 0, draftId: p.draftId, draftRevision: p.draftRevision, createdAt: p.createdAt, total: p.questions.length })),
      model: { mode: llmConfig().mock ? "mock" : "live", configured: llmConfig().mock || Boolean(llmConfig().apiKey && llmConfig().baseUrl && llmConfig().model), saved, localSaveSupported, settingsError },
    });
  }

  if (req.method === "GET" && /^\/api\/drafts\/[^/]+$/.test(url.pathname)) {
    const { draft } = await getDraft(store, pathPart(url, 3));
    return send(res, 200, { draft, summary: summarize(draft) });
  }

  if (req.method === "PATCH" && /^\/api\/drafts\/[^/]+\/questions\/[^/]+$/.test(url.pathname)) {
    const b = await readJson(req);
    const draftId = pathPart(url, 3), questionId = pathPart(url, 5);
    let updated;
    await store.update(data => {
      const draft = data.drafts.find(item => item.id === draftId);
      if (!draft) throw Object.assign(new Error("草稿不存在或已被删除。"), { status: 404 });
      updated = updateQuestion(draft, questionId, b);
      data.drafts[data.drafts.findIndex(item => item.id === draftId)] = updated;
    });
    return send(res, 200, { draft: updated, summary: summarize(updated) });
  }

  if (req.method === "POST" && /^\/api\/drafts\/[^/]+\/publish$/.test(url.pathname)) {
    const b = await readJson(req);
    let publication;
    await store.update(data => {
      const draft = data.drafts.find(item => item.id === pathPart(url, 3));
      if (!draft) throw Object.assign(new Error("草稿不存在或已被删除。"), { status: 404 });
      const candidate = publishDraft(draft, Number(b.revision), b.reviewMode);
      publication = data.publications.find(p => p.draftId === draft.id && p.draftRevision === draft.revision && (p.reviewMode || "reviewed") === candidate.reviewMode);
      if (!publication) { publication = candidate; data.publications.push(publication); }
    });
    return send(res, 200, { publication });
  }

  if (req.method === "GET" && /^\/api\/publications\/[^/]+\/student$/.test(url.pathname)) {
    const { publication } = await getPublication(store, pathPart(url, 3));
    return send(res, 200, { pack: studentPack(publication) });
  }

  if (req.method === "GET" && /^\/api\/publications\/[^/]+\/export$/.test(url.pathname)) {
    const { publication } = await getPublication(store, pathPart(url, 3));
    // 教师归档包含题目答案和短引用，不导出完整课程材料与学生反馈。
    return send(res, 200, { format: "zhisuda.review-pack.v1", publication });
  }

  if (req.method === "GET" && /^\/api\/publications\/[^/]+\/report$/.test(url.pathname)) {
    const { data, publication } = await getPublication(store, pathPart(url, 3));
    return send(res, 200, { report: feedbackReport(publication, data.attempts) });
  }

  if (req.method === "POST" && /^\/api\/publications\/[^/]+\/check$/.test(url.pathname)) {
    const b = await readJson(req);
    if (!Array.isArray(b.questionIds) || b.questionIds.length !== 1) return send(res, 400, { error: "学习模式请逐题作答后核对。" });
    const { publication } = await getPublication(store, pathPart(url, 3));
    const checked = submitAttempt(publication, { ...b, practiceMode: "study" });
    return send(res, 200, { result: checked.results[0] });
  }

  if (req.method === "POST" && /^\/api\/publications\/[^/]+\/attempts$/.test(url.pathname)) {
    const b = await readJson(req);
    const { publication } = await getPublication(store, pathPart(url, 3));
    let attempt = submitAttempt(publication, b);
    if (b.submissionId !== undefined && !/^[0-9a-f-]{36}$/.test(b.submissionId)) return send(res, 400, { error: "练习提交标识无效，请刷新后重试。" });
    if (b.submissionId) attempt.submissionId = b.submissionId;
    await store.update(data => {
      const existing = b.submissionId && data.attempts.find(a => a.packId === publication.id && a.submissionId === b.submissionId);
      if (existing) {
        if (JSON.stringify(existing.results.map(r => [r.questionId, r.response])) !== JSON.stringify(attempt.results.map(r => [r.questionId, r.response]))) throw Object.assign(new Error("这次练习已提交，请恢复结果或开始新一轮练习。"), { status: 409 });
        attempt = existing;
      } else data.attempts.push(attempt);
    });
    return send(res, 200, { attempt });
  }

  if (req.method === "POST" && /^\/api\/attempts\/[^/]+\/feedback$/.test(url.pathname)) {
    const b = await readJson(req);
    let attempt;
    await store.update(data => {
      const i = data.attempts.findIndex(item => item.id === pathPart(url, 3));
      if (i < 0) throw Object.assign(new Error("练习记录不存在。"), { status: 404 });
      attempt = saveFeedback(data.attempts[i], b);
      data.attempts[i] = attempt;
    });
    return send(res, 200, { attempt });
  }

  if (req.method === "POST" && url.pathname === "/api/feedback") {
    const b = await readJson(req);
    const text = str(b.records, 20_000);
    if (!text) return send(res, 400, { error: "请粘贴学生反馈数据。" });
    return send(res, 200, { report: await chatJson(FEEDBACK_SYSTEM, `学生反馈数据：\n${text}`, await resolveModelConfig(b.modelConfig, vault)) });
  }

  if (req.method === "GET") {
    if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname); // basename 防路径穿越
    const ext = path.extname(name);
    if (!TYPES[ext]) return send(res, 404, { error: "Not found" });
    try {
      const body = await readFile(path.join(PUBLIC, name));
      res.writeHead(200, { "Content-Type": TYPES[ext], "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      return res.end(body);
    } catch { return send(res, 404, { error: "Not found" }); }
  }

  send(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => send(res, e.status ?? 500, { error: e.status ? e.message : "服务器内部错误。" }));
});

const port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT 需要是0—65535之间的整数。");
// 只监听本机：本服务没有登录认证，不要直接暴露到公网
server.listen(port, "127.0.0.1", () => console.log(`知速达已启动：http://127.0.0.1:${server.address().port}`));
server.on("error", e => { console.error(e.code === "EADDRINUSE" ? "端口正在被占用，请关闭另一个知速达窗口，或使用其他 PORT 重试。" : "服务启动失败，请检查端口和数据目录。"); process.exitCode = 1; });
