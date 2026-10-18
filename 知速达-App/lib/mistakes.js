// 从历史练习推导错题，不另建容易失去同步的错题数据库。
export function mistakeBook(data) {
  const rows = new Map();
  for (const attempt of data.attempts) {
    for (const result of attempt.results) {
      const state = result.type === "选择" ? (result.correct ? "掌握" : "未掌握") : result.selfAssessment;
      if (!state) continue;
      const key = `${attempt.packId}:${result.questionId}`;
      const prior = rows.get(key);
      if (state === "掌握" && !prior) continue;
      const pack = data.publications.find(p => p.id === attempt.packId);
      if (prior) rows.delete(key); // 更新时移到最前，错题本按最近练习排序。
      rows.set(key, { ...result, packId: attempt.packId, topic: pack?.topic || "复习包", course: pack?.course || "", state,
        wrongCount: (prior?.wrongCount || 0) + (state === "掌握" ? 0 : 1),
        firstWrongAt: prior?.firstWrongAt || attempt.createdAt, lastPracticedAt: attempt.createdAt });
    }
  }
  return [...rows.values()].reverse();
}
