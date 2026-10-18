import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chatJson, llmConfig, requestConfig } from "./lib/llm.js";
import { summarize } from "./lib/verify.js";
import { GENERATE_SYSTEM, FEEDBACK_SYSTEM, generateUser } from "./lib/prompts.js";
import { createDraft, feedbackReport, publishDraft, saveFeedback, studentPack, submitAttempt, updateQuestion } from "./lib/workflow.js";
import { demoInput } from "./lib/demo.js";
import { createStore } from "./lib/store.js";
import { importDocument, validateDocument, MAX_FILE } from "./lib/sources.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MAX_BODY = 900_000; // 含提取文字和位置数据；中文 UTF-8 通常每字3字节
const MAX_SOURCE = 60_000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const DATA = process.env.ZHISUDA_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const store = createStore(DATA);
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0, tooLarge = false;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
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

async function getDraft(id) {
  const data = await store.read();
  const draft = data.drafts.find(item => item.id === id);
  if (!draft) throw Object.assign(new Error("草稿不存在或已被删除。"), { status: 404 });
  return { data, draft };
}

async function getPublication(id) {
  const data = await store.read();
  const publication = data.publications.find(item => item.id === id);
  if (!publication) throw Object.assign(new Error("复习包不存在。"), { status: 404 });
  return { data, publication };
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (!["GET", "HEAD"].includes(req.method)) {
    // 本地工作台也拒绝来自其他网站的写请求，防止意外写入或触发模型调用。
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: "请从本地工作台发起请求。" });
    const allowed = url.pathname === "/api/import" ? req.headers["content-type"] === "application/octet-stream" : req.headers["content-type"]?.startsWith("application/json");
    if (!allowed) return send(res, 415, { error: "请求格式不正确，请从页面重新操作。" });
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
    const cfg = requestConfig(b.modelConfig), started = Date.now();
    // 测试不使用课程资料，也不创建草稿；只核对兼容接口能返回 JSON 对象。
    await chatJson("这是接口连接测试。请只返回 JSON 对象，不要使用 Markdown。", '请返回 {"ok":true}。', cfg, 25_000);
    return send(res, 200, { connected: true, elapsedMs: Date.now() - started });
  }

  if (req.method === "POST" && url.pathname === "/api/generate") {
    const b = await readJson(req);
    const cfg = requestConfig(b.modelConfig);
    if (typeof b.source === "string" && b.source.length > MAX_SOURCE) return send(res, 413, { error: "单次材料不超过60000字符，请按讲次拆分。" });
    const source = str(b.source, MAX_SOURCE);
    if (source.length < 200) return send(res, 400, { error: "讲义内容太短，请粘贴至少 200 字的讲义文字。" });
    const sourceDocument = validateDocument(b.sourceDocument, source);
    const started = Date.now();
    const raw = await chatJson(GENERATE_SYSTEM, generateUser({
      course: str(b.course, 100) || "未命名课程",
      topic: str(b.topic, 100) || "未命名主题",
      goal: str(b.goal, 100) || "期末复习",
      source: sourceDocument.text,
      sourceDocument,
    }), cfg);
    const draft = createDraft({ course: b.course, topic: b.topic, goal: b.goal, source: sourceDocument.text, sourceDocument }, raw, cfg.mock ? "mock" : "live");
    draft.generation = { elapsedMs: Date.now() - started, model: cfg.mock ? "固定模拟数据" : cfg.model, usage: raw._usage || null };
    await store.update(data => { data.drafts.push(draft); });
    return send(res, 200, { draft, summary: summarize(draft) });
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
    return send(res, 200, {
      drafts: [...data.drafts].reverse().map(d => ({ id: d.id, course: d.course, topic: d.topic, mode: d.mode, revision: d.revision, updatedAt: d.updatedAt, total: d.questions.length, approved: d.questions.filter(q => q.review === "approved").length })),
      publications: [...data.publications].reverse().map(p => ({ id: p.id, course: p.course, topic: p.topic, mode: p.mode, reviewMode: p.reviewMode || "reviewed", unreviewedCount: p.unreviewedCount || 0, draftId: p.draftId, draftRevision: p.draftRevision, createdAt: p.createdAt, total: p.questions.length })),
      model: { mode: llmConfig().mock ? "mock" : "live", configured: llmConfig().mock || Boolean(llmConfig().apiKey && llmConfig().baseUrl && llmConfig().model) },
    });
  }

  if (req.method === "GET" && /^\/api\/drafts\/[^/]+$/.test(url.pathname)) {
    const { draft } = await getDraft(pathPart(url, 3));
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
    const { publication } = await getPublication(pathPart(url, 3));
    return send(res, 200, { pack: studentPack(publication) });
  }

  if (req.method === "GET" && /^\/api\/publications\/[^/]+\/export$/.test(url.pathname)) {
    const { publication } = await getPublication(pathPart(url, 3));
    // 教师归档包含题目答案和短引用，不导出完整课程材料与学生反馈。
    return send(res, 200, { format: "zhisuda.review-pack.v1", publication });
  }

  if (req.method === "GET" && /^\/api\/publications\/[^/]+\/report$/.test(url.pathname)) {
    const { data, publication } = await getPublication(pathPart(url, 3));
    return send(res, 200, { report: feedbackReport(publication, data.attempts) });
  }

  if (req.method === "POST" && /^\/api\/publications\/[^/]+\/attempts$/.test(url.pathname)) {
    const b = await readJson(req);
    const { publication } = await getPublication(pathPart(url, 3));
    const attempt = submitAttempt(publication, b);
    await store.update(data => { data.attempts.push(attempt); });
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
    return send(res, 200, { report: await chatJson(FEEDBACK_SYSTEM, `学生反馈数据：\n${text}`, requestConfig(b.modelConfig)) });
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
