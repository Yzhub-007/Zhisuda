// 从历史练习推导错题，不另建容易失去同步的错题数据库。
// 复习安排采用固定、可解释的规则，不声称是自适应算法：
//   最近一次未掌握 / 部分掌握 → 1 天后再练；
//   出错后连续答对 1 次 → 3 天后；连续 2 次 → 7 天后；连续 3 次 → 视为已稳定，不再排期。
export const REVIEW_STEPS = [1, 3, 7];
const DAY = 86_400_000;

export function reviewPlan(state, streak, lastPracticedAt) {
  if (streak >= REVIEW_STEPS.length) return { dueAt: null, reason: `出错后已连续 ${streak} 次掌握，暂不安排复习` };
  const days = REVIEW_STEPS[streak];
  const reason = streak === 0
    ? `最近一次${state === "部分掌握" ? "自评部分掌握" : "未掌握"}，${days} 天后再练`
    : `出错后已连续 ${streak} 次掌握，间隔拉长到 ${days} 天`;
  return { dueAt: new Date(Date.parse(lastPracticedAt) + days * DAY).toISOString(), reason };
}

// “今天该复习”按本机日历日判断：到期日当天任何时间打开都算到期，而不是要等满 24 小时。
function endOfDay(now) { const d = new Date(now); d.setHours(23, 59, 59, 999); return d.getTime(); }

export function mistakeBook(data, now = Date.now()) {
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
      const streak = state === "掌握" ? (prior?.streak || 0) + 1 : 0;
      rows.set(key, { ...result, packId: attempt.packId, topic: pack?.topic || "复习包", course: pack?.course || "", state, streak,
        wrongCount: (prior?.wrongCount || 0) + (state === "掌握" ? 0 : 1),
        firstWrongAt: prior?.firstWrongAt || attempt.createdAt, lastPracticedAt: attempt.createdAt });
    }
  }
  return [...rows.values()].reverse().map(row => {
    const plan = reviewPlan(row.state, row.streak, row.lastPracticedAt);
    return { ...row, ...plan, due: plan.dueAt !== null && Date.parse(plan.dueAt) <= endOfDay(now) };
  });
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
