// 难度、题型、知识点三组筛选取交集。skip 用于统计某一组各选项的数量：应用另外两组的当前选择。
export const ALL = "全部";
export function matchesFilters(q, filters, skip) {
  return (skip === "level" || filters.level === ALL || q.level === filters.level)
    && (skip === "type" || filters.type === ALL || q.type === filters.type)
    && (skip === "knowledge" || filters.knowledge === ALL || q.knowledgeName === filters.knowledge);
}
export function filterQuestions(questions, filters) { return questions.filter(q => matchesFilters(q, filters)); }
export function optionCount(questions, filters, skip, field, item) {
  return questions.filter(q => matchesFilters(q, filters, skip) && (item === ALL || q[field] === item)).length;
}
