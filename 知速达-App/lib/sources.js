import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { getDocumentProxy } from "unpdf";
import { quoteInSource } from "./verify.js";

export const MAX_FILE = 12 * 1024 * 1024;
export const MAX_SOURCE = 60_000;
const fail = (message, status = 422) => Object.assign(new Error(message), { status });
const clean = value => String(value ?? "").replace(/\u0000/g, "").trim();
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false, processEntities: true, trimValues: false });

export function textDocument(source, name = "粘贴的课程文字") {
  return makeDocument(name, "text", clean(source).split(/\n\s*\n/).filter(Boolean).map((text, index) => ({ text: clean(text), label: `第 ${index + 1} 段` })));
}

function makeDocument(name, kind, blocks, warnings = []) {
  blocks = blocks.filter(b => b.text).map((b, i) => ({ ...b, id: `b${i + 1}` }));
  const text = blocks.map(b => b.text).join("\n\n");
  if (!text) throw fail("没有提取到可用文字。扫描版 PDF 请先进行文字识别（OCR），或改用 Word／粘贴文字。");
  if (text.length > MAX_SOURCE) throw fail("提取的文字超过 60000 字符，请按章节拆分文件后导入；本次没有截断材料。", 413);
  return { name: clean(name).slice(0, 180), kind, blocks, text, characters: text.length, warnings,
    fingerprint: createHash("sha256").update(text).digest("hex").slice(0, 16) };
}

// 对浏览器回传的结构再次检查；位置是文字提取位置，不承诺与排版视觉位置一致。
export function validateDocument(input, source) {
  if (!input) return textDocument(source);
  if (!["docx", "pdf", "text"].includes(input.kind) || !Array.isArray(input.blocks) || input.blocks.length > 4000) throw fail("材料位置数据无效，请重新导入。");
  const blocks = input.blocks.map(b => {
    if (!b || typeof b.text !== "string" || typeof b.label !== "string" || b.text.length > MAX_SOURCE) throw fail("材料段落数据无效。");
    return { text: clean(b.text), label: clean(b.label).slice(0, 220), ...(Number.isInteger(b.page) && b.page > 0 ? { page: b.page } : {}) };
  });
  const doc = makeDocument(input.name, input.kind, blocks, Array.isArray(input.warnings) ? input.warnings.slice(0, 12).map(w => clean(w).slice(0, 400)) : []);
  if (doc.text !== clean(source)) throw fail("预览文字已改变，请重新导入以保留文件位置，或使用粘贴文字模式。");
  return doc;
}

// 只保留学生选中的章节／页面：按原顺序截取，位置标签沿用原文件，不重新编号。
export function scopeDocument(document, blockIds) {
  if (!Array.isArray(blockIds) || !blockIds.length || blockIds.length > 4000 || blockIds.some(id => typeof id !== "string")) throw fail("请至少选择一个章节或页面作为复习范围。", 400);
  const wanted = new Set(blockIds), known = new Set(document.blocks.map(b => b.id));
  if ([...wanted].some(id => !known.has(id))) throw fail("所选范围与当前资料不一致，请重新选择。", 400);
  const blocks = document.blocks.filter(b => wanted.has(b.id)).map(({ text, label, page }) => ({ text, label, ...(page ? { page } : {}) }));
  const note = `本次只使用你选择的 ${blocks.length} / ${document.blocks.length} 个${document.kind === "pdf" ? "页面" : "段落"}，其余内容未发送给模型。`;
  return makeDocument(document.name, document.kind, blocks, [...document.warnings, note]);
}

function findNodes(nodes, key) {
  const result = [];
  for (const node of nodes || []) for (const [tag, children] of Object.entries(node)) {
    if (tag === key) result.push(node);
    else if (Array.isArray(children)) result.push(...findNodes(children, key));
  }
  return result;
}
function xmlText(nodes) {
  let result = "";
  for (const node of nodes || []) for (const [tag, children] of Object.entries(node)) {
    if (tag === "#text") result += children;
    else if (tag === "w:tab") result += "\t";
    else if (tag === "w:br" || tag === "w:cr") result += "\n";
    else if (!["w:del", "w:instrText", "w:pPr", "w:rPr", "w:drawing", "w:pict", "m:oMath", "m:oMathPara"].includes(tag) && Array.isArray(children)) result += xmlText(children);
  }
  return result;
}

function extractDocx(buffer, name) {
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw fail("文件不是有效的 DOCX，请在 Word 中另存为 .docx 后重试。");
  // 只解压必要 XML，预先限制声明大小，避免压缩文件无界展开。
  const files = unzipSync(new Uint8Array(buffer), { filter: entry => {
    if (!["word/document.xml", "word/styles.xml"].includes(entry.name)) return false;
    if (entry.originalSize > 8 * 1024 * 1024) throw fail("Word 内部文字数据过大，请按章节拆分。");
    return true;
  } });
  if (!files["word/document.xml"]) throw fail("DOCX 中缺少正文，请重新保存文件。");
  const parse = bytes => {
    const xml = strFromU8(bytes);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw fail("Word XML 结构无效，无法安全读取。");
    return parser.parse(xml);
  };
  const headingStyles = new Set();
  if (files["word/styles.xml"]) for (const style of findNodes(parse(files["word/styles.xml"]), "w:style")) {
    const attrs = style[":@"] || {};
    const names = findNodes(style["w:style"], "w:name").map(n => n[":@"]?.["w:val"] || "");
    if (names.some(n => /heading|标题/i.test(n)) || findNodes(style["w:style"], "w:outlineLvl").length) headingStyles.add(attrs["w:styleId"]);
  }
  const tree = parse(files["word/document.xml"]), blocks = [];
  let heading = "正文", paragraph = 0;
  for (const p of findNodes(tree, "w:p")) {
    const text = clean(xmlText(p["w:p"]));
    if (!text) continue;
    paragraph++;
    const style = findNodes(p["w:p"], "w:pStyle")[0]?.[":@"]?.["w:val"] || "";
    if (headingStyles.has(style) || /heading|标题/i.test(style) || findNodes(p["w:p"], "w:outlineLvl").length) heading = text.slice(0, 90);
    blocks.push({ text, label: `${heading} · 第 ${paragraph} 段` });
  }
  const drawings = findNodes(tree, "w:drawing").length + findNodes(tree, "w:pict").length;
  const equations = findNodes(tree, "m:oMath").length;
  return makeDocument(name, "docx", blocks, ["Word 使用正文标题与非空段落序号定位；不推测页码。表格按段落读取，批注、页眉页脚未提取，请对照原文件检查。", ...(drawings || equations ? [`检测到 ${drawings} 个图形和 ${equations} 个公式对象，本次没有识别它们的内容；如包含知识点，请补充为文字后再生成。`] : [])]);
}

async function extractPdf(buffer, name) {
  if (!buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw fail("文件不是有效的 PDF。");
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  try {
    if (pdf.numPages > 200) throw fail("单次最多读取 200 页，请按章节拆分 PDF。");
    const blocks = [], blank = [];
    let characters = 0;
    for (let page = 1; page <= pdf.numPages; page++) {
      const item = await pdf.getPage(page);
      const content = await item.getTextContent();
      let text = "";
      for (const run of content.items) if (typeof run.str === "string") text += run.str + (run.hasEOL ? "\n" : " ");
      text = clean(text.replace(/[ \t]+\n/g, "\n"));
      if (!text) blank.push(page);
      else { blocks.push({ text, label: `文件第 ${page} 页`, page }); characters += text.length; }
      item.cleanup();
      if (characters > MAX_SOURCE) throw fail("提取的文字超过 60000 字符，请按章节拆分 PDF；本次没有截断材料。", 413);
    }
    return makeDocument(name, "pdf", blocks, ["页码表示 PDF 文件顺序，不一定等于书上印刷页码。分栏、表格、公式的阅读顺序请在生成前检查。", ...(blank.length ? [`第 ${blank.slice(0, 20).join("、")}${blank.length > 20 ? "等" : ""} 页未提取到文字，可能是空白或扫描图片；这些页没有进入生成材料。`] : [])]);
  } finally { await pdf.loadingTask.destroy(); }
}

export async function importDocument(buffer, filename) {
  if (!buffer.length || buffer.length > MAX_FILE) throw fail("请选择 12 MB 以内的文件。", 413);
  const name = clean(filename).split(/[\\/]/).at(-1);
  try {
    if (/\.docx$/i.test(name)) return extractDocx(buffer, name);
    if (/\.pdf$/i.test(name)) return await extractPdf(buffer, name);
    throw fail("目前支持 .docx 和文字版 .pdf；其他格式请复制文字后粘贴。");
  } catch (err) {
    if (err.status) throw err;
    if (err.name === "PasswordException") throw fail("PDF 需要密码，请在本机解除密码后再导入。");
    throw fail("文件解析失败。请确认文件可正常打开，再另存为 DOCX／文字版 PDF 重试。");
  }
}

export function attachLocation(item, document) {
  const matches = document.blocks.filter(b => quoteInSource(item.quote, b.text));
  // 引用跨相邻段落时保留两段，避免伪造模型页码。
  if (!matches.length) for (let i = 0; i < document.blocks.length - 1; i++) {
    const pair = document.blocks.slice(i, i + 2);
    if (quoteInSource(item.quote, pair.map(b => b.text).join("\n\n"))) { matches.push(...pair); break; }
  }
  const sourceLocations = matches.map(({ id, label, page }) => ({ id, label, ...(page ? { page } : {}) }));
  return { ...item, sourceLocations, ref: matches.length ? [...new Set(matches.map(b => b.label))].join("；").slice(0, 300) : item.quoteFound ? "跨段引用 · 请全文核对" : "未定位到原文" };
}
