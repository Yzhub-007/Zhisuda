import test from "node:test";
import assert from "node:assert/strict";
import { filterQuestions, optionCount, ALL } from "../public/filters.js";

const qs = [
  { id: 1, level: "基础", type: "选择", knowledgeName: "记忆" },
  { id: 2, level: "基础", type: "简答", knowledgeName: "注意" },
  { id: 3, level: "标准", type: "选择", knowledgeName: "注意" },
  { id: 4, level: "拓展", type: "简答", knowledgeName: "记忆" },
];
const none = { level: ALL, type: ALL, knowledge: ALL };

test("筛选：不选时显示全部，三组条件取交集", () => {
  assert.equal(filterQuestions(qs, none).length, 4);
  assert.deepEqual(filterQuestions(qs, { ...none, level: "基础", type: "选择" }).map(q => q.id), [1]);
  assert.deepEqual(filterQuestions(qs, { level: "基础", type: "简答", knowledge: "记忆" }), []);
});

test("筛选：各选项数量应用另外两组的选择，当前组不自我限制", () => {
  const filters = { ...none, type: "选择" };
  assert.equal(optionCount(qs, filters, "level", "level", "基础"), 1);
  assert.equal(optionCount(qs, filters, "level", "level", ALL), 2);
  assert.equal(optionCount(qs, filters, "type", "type", "简答"), 2);
  assert.equal(optionCount(qs, { ...none, knowledge: "记忆" }, "level", "level", "标准"), 0);
});
