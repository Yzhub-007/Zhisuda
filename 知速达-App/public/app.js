const $ = (id) => document.getElementById(id);
// 所有来自模型的文本一律用 textContent，避免注入
const mk = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };

let pack = null;
const verdicts = []; // 与 pack.questions 对应：通过 / 修改 / 退回 / null

async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败（${r.status}）`);
  return data;
}

function showErr(id, msg) { const e = $(id); e.hidden = !msg; e.textContent = msg || ""; }

function renderPack() {
  const box = $("items"); box.replaceChildren();
  pack.questions.forEach((q, i) => {
    const c = mk("article", null, "card");
    c.append(mk("b", `${i + 1}. [${q.level ?? "?"}] ${q.question ?? ""}`));
    if (Array.isArray(q.options)) {
      const ul = mk("ul"); q.options.forEach((o) => ul.append(mk("li", String(o)))); c.append(ul);
    }
    c.append(mk("p", `答案：${q.answer ?? ""}`));
    c.append(mk("p", `解析：${q.explanation ?? ""}`));
    c.append(mk("div", `原文依据 ${q.ref ?? ""}：${q.quote ?? ""}`, "evi"));
    c.append(mk("span", q.status, `badge ${q.status === "已核对" ? "ok" : "check"}`));
    if (q.note) c.append(mk("p", q.note, "muted"));
    const acts = mk("div", null, "acts");
    ["通过", "修改", "退回"].forEach((t) => {
      const b = mk("button", t); b.setAttribute("aria-pressed", String(verdicts[i] === t));
      b.onclick = () => { verdicts[i] = verdicts[i] === t ? null : t; renderPack(); };
      acts.append(b);
    });
    c.append(acts); box.append(c);
  });
}

$("gen").onclick = async () => {
  const btn = $("gen"); showErr("genErr", "");
  btn.disabled = true; btn.textContent = "生成中，可能需要 1 分钟…";
  try {
    const d = await post("/api/generate", { course: $("course").value, topic: $("topic").value, source: $("source").value });
    pack = d.pack; verdicts.length = pack.questions.length; verdicts.fill(null);
    $("sum").textContent = `共 ${d.summary.total} 题；系统在讲义中找到引用的 ${d.summary.quoteFound} 题；需人工核验 ${d.summary.needReview} 题。“找到引用”只代表句子存在，不代表它能支持答案，仍需教师判断。`;
    $("result").hidden = false; renderPack();
  } catch (e) { showErr("genErr", e.message); }
  finally { btn.disabled = false; btn.textContent = "生成复习包"; }
};

$("exp").onclick = () => {
  if (!pack) return;
  // 防 CSV 公式注入：以 = + - @ 开头的单元格前加单引号
  const esc = (v) => { let s = String(v ?? ""); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const rows = [["编号", "档位", "题目", "答案", "原文依据", "依据状态", "教师意见"]];
  pack.questions.forEach((q, i) => rows.push([i + 1, q.level, q.question, q.answer, `${q.ref} ${q.quote}`, q.status, verdicts[i] ?? "未审核"]));
  const t = $("csv"); t.value = rows.map((r) => r.map(esc).join(",")).join("\n"); t.hidden = false; t.select();
};

$("fb").onclick = async () => {
  const btn = $("fb"); showErr("fbErr", ""); $("fbOut").replaceChildren();
  btn.disabled = true;
  try {
    const { report } = await post("/api/feedback", { records: $("records").value });
    const out = $("fbOut");
    if (report.note) out.append(mk("p", report.note, "notice"));
    const tb = mk("table"); const head = mk("tr");
    ["知识点", "典型错误", "人数", "可能原因", "讲解建议"].forEach((h) => head.append(mk("th", h)));
    tb.append(head);
    (report.common ?? []).forEach((c) => {
      const r = mk("tr");
      [c.knowledge, c.mistake, `${c.count}/${c.total}`, c.cause, c.suggestion].forEach((v) => r.append(mk("td", v)));
      tb.append(r);
    });
    out.append(tb);
    (report.individual ?? []).forEach((s) => out.append(mk("p", s, "muted")));
  } catch (e) { showErr("fbErr", e.message); }
  finally { btn.disabled = false; }
};
