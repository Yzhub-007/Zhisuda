import test from "node:test";
import assert from "node:assert/strict";
import { saveImportDraft, loadImportDraft, clearImportDraft, IMPORT_KEY } from "../public/import-draft.js";

const memory = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };
const doc = { name: "讲义", kind: "docx", text: "第一段\n\n第二段", blocks: [{ id: "b1", text: "第一段", label: "§1" }, { id: "b2", text: "第二段", label: "§2" }] };

test("导入暂存：恢复文字、表单、文件位置与范围，不含密钥字段", () => {
  const s = memory();
  saveImportDraft(s, { source: doc.text, course: "心理学", topic: "记忆", goal: "期末", sourceDocument: doc, scope: new Set(["b2"]), apiKey: "should-not-save" });
  assert.ok(!s.getItem(IMPORT_KEY).includes("should-not-save"));
  const r = loadImportDraft(s);
  assert.equal(r.source, doc.text); assert.equal(r.course, "心理学"); assert.equal(r.sourceDocument.name, "讲义"); assert.deepEqual(r.scope, ["b2"]);
  clearImportDraft(s); assert.equal(loadImportDraft(s), null);
});

test("导入暂存：文字与文件位置不一致时退回粘贴文字，未知范围被丢弃，损坏数据忽略", () => {
  const s = memory();
  saveImportDraft(s, { source: "改过的文字", sourceDocument: doc, scope: new Set(["b1"]) });
  const r = loadImportDraft(s); assert.equal(r.sourceDocument, null); assert.equal(r.scope, null);
  saveImportDraft(s, { source: doc.text, sourceDocument: doc, scope: new Set(["b1", "b99"]) });
  assert.deepEqual(loadImportDraft(s).scope, ["b1"]);
  s.setItem(IMPORT_KEY, "{broken"); assert.equal(loadImportDraft(s), null);
  s.setItem(IMPORT_KEY, JSON.stringify({ version: 2, source: "x" })); assert.equal(loadImportDraft(s), null);
});
