import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chatJson } from "./lib/llm.js";
import { checkPack, summarize } from "./lib/verify.js";
import { GENERATE_SYSTEM, FEEDBACK_SYSTEM, generateUser } from "./lib/prompts.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MAX_BODY = 200_000; // 约 20 万字符，足够一讲讲义
const MAX_SOURCE = 60_000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("内容过长。"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("请求不是合法 JSON。"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

const send = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/api/generate") {
    const b = await readJson(req);
    const source = str(b.source, MAX_SOURCE);
    if (source.length < 200) return send(res, 400, { error: "讲义内容太短，请粘贴至少 200 字的讲义文字。" });
    const raw = await chatJson(GENERATE_SYSTEM, generateUser({
      course: str(b.course, 100) || "未命名课程",
      topic: str(b.topic, 100) || "未命名主题",
      goal: str(b.goal, 100) || "期末复习",
      source,
    }));
    const pack = checkPack(raw, source);
    return send(res, 200, { pack, summary: summarize(pack) });
  }

  if (req.method === "POST" && url.pathname === "/api/feedback") {
    const b = await readJson(req);
    const text = str(b.records, 20_000);
    if (!text) return send(res, 400, { error: "请粘贴学生反馈数据。" });
    return send(res, 200, { report: await chatJson(FEEDBACK_SYSTEM, `学生反馈数据：\n${text}`) });
  }

  if (req.method === "GET") {
    const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname); // basename 防路径穿越
    const ext = path.extname(name);
    if (!TYPES[ext]) return send(res, 404, { error: "Not found" });
    try {
      const body = await readFile(path.join(PUBLIC, name));
      res.writeHead(200, { "Content-Type": TYPES[ext] });
      return res.end(body);
    } catch { return send(res, 404, { error: "Not found" }); }
  }

  send(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => send(res, e.status ?? 500, { error: e.status ? e.message : "服务器内部错误。" }));
});

const port = Number(process.env.PORT) || 3000;
// 只监听本机：本服务没有登录认证，不要直接暴露到公网
server.listen(port, "127.0.0.1", () => console.log(`知速达已启动：http://127.0.0.1:${port}`));
