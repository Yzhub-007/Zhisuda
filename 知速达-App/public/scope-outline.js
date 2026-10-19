// 复习范围目录：DOCX 按标题分组，PDF 每页一组；粘贴文字没有可靠结构，不分组。
// 材料较长时，生成前让学生确认“哪些部分会发送给模型”，避免误把整本资料发出去。
export const LONG_MATERIAL = 10000;

export function groupBlocks(doc) {
  if (!doc) return [];
  if (doc.kind === "pdf") return doc.blocks.map(b => ({ name: b.label, ids: [b.id], chars: b.text.length }));
  const groups = [];
  for (const b of doc.blocks) {
    const name = b.label.replace(/ · 第 \d+ 段$/, "") || "正文", last = groups.at(-1);
    if (last && last.name === name) { last.ids.push(b.id); last.chars += b.text.length; } else groups.push({ name, ids: [b.id], chars: b.text.length });
  }
  return groups;
}

export function outline(groups, scope) {
  const selected = [], skipped = [];
  for (const g of groups) (g.ids.some(id => scope.has(id)) ? selected : skipped).push({ name: g.name, chars: g.ids.every(id => scope.has(id)) ? g.chars : null, partial: !g.ids.every(id => scope.has(id)) });
  return { selected, skipped };
}

export const needsScopeConfirm = chars => chars >= LONG_MATERIAL;

// 同一份资料、同一范围确认过一次后，失败重试不再重复询问。
export const scopeKey = (doc, text, ids) => (doc?.fingerprint || `${text.length}:${text.slice(0, 40)}:${text.slice(-40)}`) + "|" + (ids ? [...ids].sort().join(",") : "all");
