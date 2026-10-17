import test from "node:test";
import assert from "node:assert/strict";
import { quoteInSource, checkEvidence, checkPack, summarize } from "../lib/verify.js";

const SOURCE = `The height of an empty tree is defined to be -1,
and the height of a single node is 0.`;

test("逐字存在的引用通过，忽略大小写和换行", () => {
  assert.equal(quoteInSource("height of an empty tree is defined to be -1", SOURCE), true);
  assert.equal(quoteInSource("THE HEIGHT OF A SINGLE NODE IS 0", SOURCE), true);
});

test("改写过或编造的引用不通过", () => {
  assert.equal(quoteInSource("an empty tree has height minus one", SOURCE), false);
  assert.equal(quoteInSource("", SOURCE), false);
});

test("过短的引用不予认可", () => {
  assert.equal(quoteInSource("tree", SOURCE), false);
});

test("模型声称已核对但引用不存在，必须降级", () => {
  const r = checkEvidence({ quote: "made up sentence here", status: "已核对" }, SOURCE);
  assert.equal(r.status, "需人工核验");
  assert.equal(r.quoteFound, false);
});

test("引用存在但模型自己标需人工核验，保持需人工核验", () => {
  const r = checkEvidence({ quote: "height of a single node is 0", status: "需人工核验" }, SOURCE);
  assert.equal(r.status, "需人工核验");
  assert.equal(r.quoteFound, true);
});

test("引用存在且已核对，保持已核对", () => {
  const r = checkEvidence({ quote: "height of a single node is 0", status: "已核对" }, SOURCE);
  assert.equal(r.status, "已核对");
});

test("checkPack 不修改入参，summarize 统计正确", () => {
  const pack = { knowledge: [], questions: [
    { quote: "height of a single node is 0", status: "已核对" },
    { quote: "not in the source at all", status: "已核对" },
  ] };
  const out = checkPack(pack, SOURCE);
  assert.equal(pack.questions[1].status, "已核对");
  const s = summarize(out);
  assert.deepEqual([s.total, s.quoteFound, s.needReview], [2, 1, 1]);
});
