import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { importDocument, attachLocation, textDocument, validateDocument, MAX_FILE } from "../lib/sources.js";
import { createDraft, updateQuestion, publishDraft } from "../lib/workflow.js";
import { docxFixture, pdfFixture } from "./fixtures.js";

test("DOCX：标题和段落定位；合并 run，忽略删除文本，不编造页码", async () => {
  const doc = await importDocument(docxFixture(), "课程笔记.docx");
  assert.equal(doc.kind, "docx"); assert.equal(doc.blocks.length, 3);
  assert.match(doc.blocks[1].label, /第一章 绪论 · 第 2 段/);
  assert.match(doc.blocks[1].text, /自编材料。\t包括/);
  assert.ok(!doc.text.includes("删除的旧定义"));
  assert.ok(doc.blocks.every(block => !Object.hasOwn(block, "page")));
  assert.deepEqual(validateDocument(doc, doc.text), doc);
  const visual = await importDocument(docxFixture('<w:p><w:r><w:t>正文保留。</w:t><w:drawing><a:t xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">图内文字不当成正文</a:t></w:drawing></w:r><m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>公式不当成正文</m:t></m:r></m:oMath></w:p>'), "含图片公式.docx");
  assert.equal(visual.text, "正文保留。");
  assert.match(visual.warnings.join(" "), /1 个图形和 1 个公式对象/);
});

test("PDF：按真实文件页序定位，跳过空白页时不重新编号", async () => {
  const doc = await importDocument(pdfFixture(["Retrieval practice uses active recall.", "", "Spaced practice spreads learning over time."]), "notes.pdf");
  assert.equal(doc.blocks.length, 2);
  assert.deepEqual(doc.blocks.map(b => b.page), [1, 3]);
  assert.equal(doc.blocks[1].label, "文件第 3 页");
  assert.match(doc.warnings.join(" "), /第 2 页未提取到文字/);
  assert.match(doc.text, /active recall/);
});

test("导入：拒绝无文字、伪造格式、压缩炸弹、非法 XML、过大文件和过长文字", async () => {
  await assert.rejects(importDocument(pdfFixture([""]), "scan.pdf"), /文字识别/);
  await assert.rejects(importDocument(Buffer.from("invalid"), "x.pdf"), /有效的 PDF/);
  await assert.rejects(importDocument(Buffer.from("invalid"), "x.docx"), /有效的 DOCX/);
  await assert.rejects(importDocument(Buffer.from("invalid"), "x.exe"), /目前支持/);
  await assert.rejects(importDocument(Buffer.alloc(MAX_FILE + 1), "large.pdf"), /12 MB/);
  const oversized = Buffer.from(zipSync({ "word/document.xml": strToU8("x".repeat(9 * 1024 * 1024)) }));
  await assert.rejects(importDocument(oversized, "bomb.docx"), /内部文字数据过大/);
  await assert.rejects(importDocument(docxFixture("<w:p><w:t>invalid"), "bad.docx"), /XML 结构无效/);
  await assert.rejects(importDocument(docxFixture(`<w:p><w:r><w:t>${"文字".repeat(31000)}</w:t></w:r></w:p>`), "long.docx"), /没有截断材料/);
});

test("溯源：重新计算位置，编辑引用时更新定位；发布仅保留短引用和来源摘要", async () => {
  const doc = await importDocument(docxFixture(), "自己的笔记.docx");
  let draft = createDraft({ source: doc.text, sourceDocument: doc }, { questions: [{ type: "简答", level: "基础", question: "这份材料如何描述研究对象？", answer: "心理过程与行为", explanation: "根据本次笔记。", knowledgeName: "研究对象", quote: "心理学研究心理过程与行为。", ref: "第 999 页", status: "已核对" }] });
  const id = draft.questions[0].id;
  assert.equal(draft.questions[0].sourceLocations[0].id, "b2");
  assert.ok(!draft.questions[0].ref.includes("999"));
  draft = updateQuestion(draft, id, { revision: draft.revision, changes: { quote: "保留的新定义。" } });
  assert.equal(draft.questions[0].sourceLocations[0].id, "b3");
  draft = updateQuestion(draft, id, { revision: draft.revision, review: "approved", evidenceConfirmed: true });
  const pack = publishDraft(draft, draft.revision);
  assert.equal(pack.sourceName, "自己的笔记.docx");
  assert.equal(pack.sourceFingerprint, doc.fingerprint);
  assert.ok(!Object.hasOwn(pack, "sourceDocument")); assert.ok(!Object.hasOwn(pack, "source"));
});

test("溯源：篡改预览失配会被拒绝；相邻段引用可以定位两段", () => {
  const doc = textDocument("这是用于测试的第一段。\n\n这是用于测试的第二段。");
  assert.throws(() => validateDocument(doc, "改变了文字"), /预览文字已改变/);
  const item = attachLocation({ quote: "第一段。\n\n这是用于测试的第二段。", quoteFound: true, ref: "模型自造位置" }, doc);
  assert.equal(item.sourceLocations.length, 2);
});
