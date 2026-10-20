import test from "node:test";
import assert from "node:assert/strict";
import { groupBlocks, outline, needsScopeConfirm, scopeKey, LONG_MATERIAL } from "../public/scope-outline.js";

const docx = { kind: "docx", fingerprint: "f1", blocks: [
  { id: "b1", label: "第一章 · 第 1 段", text: "a".repeat(100) }, { id: "b2", label: "第一章 · 第 2 段", text: "b".repeat(50) },
  { id: "b3", label: "第二章 · 第 3 段", text: "c".repeat(70) }, { id: "b4", label: "第三章 · 第 4 段", text: "d".repeat(30) }] };

test("范围目录：DOCX 按标题分组，PDF 按页，空资料返回空目录", () => {
  assert.deepEqual(groupBlocks(docx).map(g => [g.name, g.ids, g.chars]), [["第一章", ["b1", "b2"], 150], ["第二章", ["b3"], 70], ["第三章", ["b4"], 30]]);
  const pdf = { kind: "pdf", blocks: [{ id: "b1", label: "文件第 1 页", text: "x" }, { id: "b2", label: "文件第 3 页", text: "yy" }] };
  assert.deepEqual(groupBlocks(pdf).map(g => g.name), ["文件第 1 页", "文件第 3 页"]);
  assert.deepEqual(groupBlocks(null), []);
});

test("范围确认：区分已选、部分选中与跳过的章节；长材料才需要确认", () => {
  const { selected, skipped } = outline(groupBlocks(docx), new Set(["b1", "b3"]));
  assert.deepEqual(selected, [{ name: "第一章", chars: null, partial: true }, { name: "第二章", chars: 70, partial: false }]);
  assert.deepEqual(skipped.map(s => s.name), ["第三章"]);
  assert.equal(needsScopeConfirm(LONG_MATERIAL - 1), false); assert.equal(needsScopeConfirm(LONG_MATERIAL), true);
});

test("范围确认：同一资料同一范围只问一次，范围或资料变化后重新确认", () => {
  assert.equal(scopeKey(docx, "t", ["b3", "b1"]), scopeKey(docx, "t", ["b1", "b3"]));
  assert.notEqual(scopeKey(docx, "t", ["b1"]), scopeKey(docx, "t", ["b1", "b3"]));
  assert.notEqual(scopeKey(docx, "t", undefined), scopeKey({ ...docx, fingerprint: "f2" }, "t", undefined));
  assert.notEqual(scopeKey(null, "第一份粘贴文字", undefined), scopeKey(null, "第二份粘贴文字", undefined));
});
