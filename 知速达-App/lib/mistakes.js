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

// 练习历史：每次提交一行，得分只统计客观题，简答题单独列自评，不合成“总分”。
export function attemptHistory(data) {
  return [...data.attempts].reverse().map(attempt => {
    const pack = data.publications.find(p => p.id === attempt.packId);
    const objective = attempt.results.filter(r => r.type === "选择");
    const written = attempt.results.filter(r => r.type === "简答");
    return { id: attempt.id, packId: attempt.packId, practiceMode: attempt.practiceMode || "test", topic: pack?.topic || "复习包", course: pack?.course || "", createdAt: attempt.createdAt,
      total: attempt.results.length, objectiveTotal: objective.length, objectiveCorrect: objective.filter(r => r.correct).length,
      writtenTotal: written.length, writtenAssessed: written.filter(r => r.selfAssessment).length };
  });
}
