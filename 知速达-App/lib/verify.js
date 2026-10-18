// 依据核对：检查模型给出的原文短句是否真的出现在讲义里。
// 这是“资料溯源”的核心：找不到的一律降级为“需人工核验”。

const normalize = (s) =>
  String(s ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export function quoteInSource(quote, source) {
  const q = normalize(quote);
  if (q.length < 6) return false; // 太短的“引用”没有核验意义
  return normalize(source).includes(q);
}

// 对一道题或一个知识点做核对，返回新对象，不修改入参
export function checkEvidence(item, source) {
  const found = quoteInSource(item.quote, source);
  const claimed = item.status === "已核对";
  let status = "需人工核验";
  let note = item.note ?? "";
  if (found && claimed) status = "已核对";
  else if (!found && !note.includes("系统未在讲义中找到该引用")) note = `${note} 系统未在讲义中找到该引用，已降级。`.trim();
  return { ...item, status, quoteFound: found, note };
}

export function checkPack(pack, source) {
  return {
    ...pack,
    knowledge: (pack.knowledge ?? []).map((k) => checkEvidence(k, source)),
    questions: (pack.questions ?? []).map((q) => checkEvidence(q, source)),
  };
}

export function summarize(pack) {
  const qs = pack.questions ?? [];
  const found = qs.filter((q) => q.quoteFound).length;
  return {
    total: qs.length,
    quoteFound: found,
    needReview: qs.filter((q) => q.status !== "已核对").length,
    // 注意：这只是“引用是否存在”，不等于“引用能支持答案”，后者必须人工判断
    quoteFoundRate: qs.length ? Number((found / qs.length).toFixed(2)) : null,
  };
}
