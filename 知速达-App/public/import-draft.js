// 导入页暂存：课程文字、文件位置、范围和表单只存在当前浏览器，生成失败或刷新后不用重新导入。
// 不含 API 密钥；用户可随时“清空资料”。
export const IMPORT_KEY = "zhisuda.importDraft";
const str = (v, max) => typeof v === "string" ? v.slice(0, max) : "";

export function saveImportDraft(storage, input) {
  const data = { version: 1, savedAt: Date.now(), source: str(input.source, 60000), course: str(input.course, 100), topic: str(input.topic, 100), goal: str(input.goal, 200),
    sourceDocument: input.sourceDocument || null, scope: input.scope ? [...input.scope] : null };
  storage.setItem(IMPORT_KEY, JSON.stringify(data));
}

export function loadImportDraft(storage) {
  let data;
  try { data = JSON.parse(storage.getItem(IMPORT_KEY)); } catch { return null; }
  if (!data || data.version !== 1 || typeof data.source !== "string" || !data.source) return null;
  const doc = data.sourceDocument;
  // 文件位置必须与文字一致，否则退回粘贴文字定位，避免引用标到错误位置。
  const validDoc = doc && typeof doc === "object" && Array.isArray(doc.blocks) && doc.text === data.source && doc.blocks.every(b => b && typeof b.id === "string" && typeof b.text === "string");
  const ids = validDoc ? new Set(doc.blocks.map(b => b.id)) : null;
  return { source: data.source, course: str(data.course, 100), topic: str(data.topic, 100), goal: str(data.goal, 200), savedAt: data.savedAt,
    sourceDocument: validDoc ? doc : null,
    scope: validDoc && Array.isArray(data.scope) ? data.scope.filter(id => ids.has(id)) : null };
}

export function clearImportDraft(storage) { storage.removeItem(IMPORT_KEY); }
