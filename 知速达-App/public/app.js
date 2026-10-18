import { $, mk, api, error, download, highlightQuote } from "./shared.js";
import { getModelConfig, isModelConfigured, setServerModel, setModelBusy } from "./model-settings.js";
import { readSession, writeSession, sessionKey } from "./practice-storage.js";
let draft = null, selected = null, reportId = null, workspaceBusy = false, publications = [], sourceDocument = null, importBusy = false, generating = false;
let latestGeneration = null, generationClock = null;
const edits = new Map(), editing = new Set();
const reviewNames = { pending: "待审核", approved: "已通过", rejected: "已退回" };
const modeName = mode => mode === "demo" ? "固定演示样例" : mode === "mock" ? "固定模拟结果（不随材料变化）" : "模型生成 · 待人工核验";
const store = (key, value) => { try { localStorage.setItem("zhisuda." + key, value); } catch {} };
const restored = key => { try { return localStorage.getItem("zhisuda." + key); } catch { return null; } };
const value = id => $(id).value.trim();

function showView(view) {
  ["importView", "review", "emptyReview", "libraryView"].forEach(id => { $(id).hidden = true; });
  $(view === "import" ? "importView" : view === "library" ? "libraryView" : draft ? "review" : "emptyReview").hidden = false;
  ["Import", "Review", "Library"].forEach(name => {
    const active = name.toLowerCase() === view, button = $("nav" + name);
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  store("lastView", view);
}
["Import", "Review", "Library"].forEach(name => { $("nav" + name).onclick = () => showView(name.toLowerCase()); });
$("emptyImport").onclick = () => showView("import");

async function refreshState() {
  const state = await api("/api/state");
  const select = $("draftSelect");
  select.replaceChildren(new Option(state.drafts.length ? "选择一份草稿" : "还没有草稿", ""));
  state.drafts.forEach(d => select.append(new Option(d.course + " · " + d.topic + "（通过 " + d.approved + "/" + d.total + "）", d.id)));
  if (draft) select.value = draft.id;
  publications = state.publications; setServerModel(state.model);
  $("noPublications").hidden = publications.length > 0;
  $("publicationList").replaceChildren(...publications.map(p => {
    const session = readSession(p.id);
    const answered = Object.values(session?.answers || {}).filter(v => String(v).trim()).length;
    const li = mk("li"), link = mk("a", p.topic + " · " + p.total + " 道题" + (session?.attemptId ? " · 查看上次结果" : answered ? ` · 继续练习（已答 ${answered} 题）` : " · 开始练习"));
    link.href = "/student.html?pack=" + encodeURIComponent(p.id);
    li.append(link, mk("p", p.course + " · " + modeName(p.mode) + " · " + (p.reviewMode === "self-study" ? "自助练习" : "人工核对") + " · " + new Date(p.createdAt).toLocaleString("zh-CN"), "small muted"));
    const actions = mk("div", "", "actions");
    const report = mk("button", "查看学习记录", "button secondary"); report.onclick = () => loadReport(p.id).catch(e => error("actionErr", e.message));
    const exp = mk("button", "仅导出题目 JSON", "button secondary"); exp.title = "含题目、答案和引用；恢复记录请使用上方“备份全部学习记录”。"; exp.onclick = () => exportPublication(p.id).catch(e => error("actionErr", e.message));
    const copy = mk("button", "复制本机链接", "button secondary"); copy.onclick = async () => {
      try { await navigator.clipboard.writeText(link.href); copy.textContent = "已复制"; }
      catch { error("actionErr", "请复制此本地练习链接：" + link.href); }
    };
    actions.append(report, exp, copy); li.append(actions); return li;
  }));
  updateGenerate(); return state;
}
function scopeChars() { return sourceDocument ? sourceDocument.blocks.filter(b => scope.has(b.id)).reduce((n, b) => n + b.text.length, 0) : value("source").length; }
const checked = name => [...document.querySelectorAll(`input[name=${name}]:checked`)].map(i => i.value);
// 全选等同不限制，不向服务端发送，保持旧行为。
function mixPayload() {
  const types = checked("qtype"), levels = checked("qlevel");
  return { ...(types.length < 2 ? { questionTypes: types } : {}), ...(levels.length < 3 ? { levels } : {}) };
}
function updateGenerate() { $("gen").disabled = generating || !checked("qtype").length || !checked("qlevel").length || importBusy || value("source").length < 200 || scopeChars() < 200; }
function previewImport() {
  const count = value("source").length;
  $("sourceCount").textContent = sourceDocument ? sourceDocument.name + " · " + count.toLocaleString() + " 字符 · " + sourceDocument.blocks.length + (sourceDocument.kind === "pdf" ? " 个有文字的页面" : " 个非空段落") : count ? count.toLocaleString() + " 字符 · 按粘贴文字定位" : "尚未导入资料";
  $("togglePreview").hidden = !sourceDocument;
  $("importWarnings").hidden = !sourceDocument?.warnings?.length;
  $("importWarnings").textContent = sourceDocument?.warnings?.join(" ") || "";
  $("importPreview").replaceChildren(...(sourceDocument?.blocks || []).map(block => {
    const article = mk("article"); article.append(mk("h3", block.label), mk("p", block.text)); return article;
  }));
  if (!sourceDocument) $("importPreview").hidden = true;
  updateGenerate();
}
// 章节／页面选择：DOCX 按标题分组，PDF 每页一组；粘贴文字没有可靠结构，不提供。
let scope = new Set(), scopeGroups = [];
function groupBlocks(doc) {
  if (doc.kind === "pdf") return doc.blocks.map(b => ({ name: b.label, ids: [b.id], chars: b.text.length }));
  const groups = [];
  for (const b of doc.blocks) {
    const name = b.label.replace(/ · 第 \d+ 段$/, "") || "正文", last = groups.at(-1);
    if (last && last.name === name) { last.ids.push(b.id); last.chars += b.text.length; } else groups.push({ name, ids: [b.id], chars: b.text.length });
  }
  return groups;
}
function scopeBlockIds() { return sourceDocument && scopeGroups.length > 1 && scope.size < sourceDocument.blocks.length ? [...scope] : undefined; }
function renderScope() {
  const show = Boolean(sourceDocument) && scopeGroups.length > 1;
  $("scopeBox").hidden = !show; if (!show) return;
  $("scopeHint").textContent = sourceDocument.kind === "pdf" ? "按 PDF 页面选择；只有选中的页面会发送给模型，也只会从这些页面出题。" : "按文档标题选择；只有选中的章节会发送给模型，也只会从这些章节出题。";
  $("scopeList").replaceChildren(...scopeGroups.map(g => {
    const label = mk("label", "", "scope-item"), box = document.createElement("input");
    box.type = "checkbox"; box.checked = g.ids.every(id => scope.has(id));
    box.onchange = () => { g.ids.forEach(id => box.checked ? scope.add(id) : scope.delete(id)); renderScope(); updateGenerate(); };
    const text = mk("span", g.name); text.append(mk("small", `${g.chars.toLocaleString()} 字符`)); label.append(box, text); return label;
  }));
  const chars = sourceDocument.blocks.filter(b => scope.has(b.id)).reduce((n, b) => n + b.text.length, 0);
  $("scopeSummary").textContent = `已选 ${scope.size} / ${sourceDocument.blocks.length} 个${sourceDocument.kind === "pdf" ? "页面" : "段落"} · ${chars.toLocaleString()} 字符` + (chars < 200 ? "（不足 200 字，请多选）" : "");
}
function resetScope() { scopeGroups = sourceDocument ? groupBlocks(sourceDocument) : []; scope = new Set(sourceDocument?.blocks.map(b => b.id) || []); renderScope(); }
document.querySelectorAll("input[name=qtype],input[name=qlevel]").forEach(i => i.addEventListener("change", updateGenerate));
$("scopeAll").onclick = () => { scope = new Set(sourceDocument.blocks.map(b => b.id)); renderScope(); updateGenerate(); };
$("scopeNone").onclick = () => { scope = new Set(); renderScope(); updateGenerate(); };
$("source").oninput = () => {
  if (sourceDocument && value("source") !== sourceDocument.text) {
    sourceDocument = null; resetScope(); $("importStatus").textContent = "你已修改提取文字，来源改为粘贴文字定位；重新上传文件可以恢复文件位置。";
  }
  previewImport();
};
$("togglePreview").onclick = () => { $("importPreview").hidden = !$("importPreview").hidden; $("togglePreview").textContent = $("importPreview").hidden ? "按位置预览原文" : "收起位置预览"; };
async function importFile(file) {
  if (!file || importBusy || generating) return;
  error("genErr");
  if (!/\.(pdf|docx)$/i.test(file.name)) { error("genErr", "请选择 DOCX 或文字版 PDF 文件。"); return; }
  if (file.size > 12 * 1024 * 1024) { error("genErr", "文件超过 12 MB，请按章节拆分后再上传。"); return; }
  importBusy = true; $("fileInput").disabled = true; $("source").disabled = true; $("importStatus").textContent = "正在本机提取文字，请稍候…"; updateGenerate();
  try {
    const res = await fetch("/api/import?name=" + encodeURIComponent(file.name), { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || "导入失败，请重试。");
    sourceDocument = data.document; resetScope(); $("source").value = sourceDocument.text; $("importPreview").hidden = false; $("togglePreview").textContent = "收起位置预览";
    if (!value("topic")) $("topic").value = file.name.replace(/\.(docx|pdf)$/i, "");
    $("importStatus").textContent = "提取完成，尚未发送到模型。请检查下方文字及位置预览。";
    previewImport();
  } catch (e) { $("importStatus").textContent = "本次导入未完成，原有预览仍保留。"; error("genErr", e.message); }
  finally { importBusy = false; $("fileInput").disabled = false; $("source").disabled = false; $("fileInput").value = ""; updateGenerate(); }
}
$("fileInput").onchange = e => importFile(e.target.files[0]);
["dragenter", "dragover"].forEach(name => $("dropZone").addEventListener(name, event => { event.preventDefault(); $("dropZone").classList.add("dragging"); }));
["dragleave", "drop"].forEach(name => $("dropZone").addEventListener(name, event => { event.preventDefault(); $("dropZone").classList.remove("dragging"); }));
$("dropZone").addEventListener("drop", event => { if (event.dataTransfer.files.length > 1) { error("genErr", "请一次导入一个文件，先完成这一讲。"); return; } importFile(event.dataTransfer.files[0]); });

async function loadDraft(id) {
  if (!id) return;
  draft = (await api("/api/drafts/" + encodeURIComponent(id))).draft;
  edits.clear(); editing.clear(); selected = draft.questions.find(q => q.review === "pending")?.id || draft.questions[0].id;
  store("lastDraft", id); renderDraft();
}
function renderList() {
  $("questionCount").textContent = draft.questions.length + " 题";
  $("questionList").replaceChildren(...draft.questions.map((q, i) => {
    const button = mk("button", "", "question-item" + (q.id === selected ? " active" : ""));
    button.dataset.id = q.id; button.disabled = workspaceBusy; button.setAttribute("aria-pressed", String(q.id === selected));
    const meta = mk("span", "", "item-meta"); meta.append(mk("span", String(i + 1).padStart(2, "0") + " / " + q.level), mk("span", q.type));
    button.append(meta, mk("strong", (edits.get(q.id) || q).question), mk("span", edits.has(q.id) ? "有未保存修改" : reviewNames[q.review], "item-status " + q.review));
    button.onclick = () => { selected = q.id; error("actionErr"); renderDraft(); };
    return button;
  }));
}
function formField(label, name, current, multiline = false) {
  const wrap = mk("label", "", "field"), control = document.createElement(multiline ? "textarea" : "input");
  wrap.append(mk("span", label)); control.name = name; control.value = current || ""; if (multiline) control.rows = 3;
  control.maxLength = name === "quote" ? 2000 : name === "options" ? 6000 : name === "knowledgeName" ? 200 : 6000;
  wrap.append(control); return wrap;
}
function collectEdits(form, q) {
  const changes = {};
  form.querySelectorAll("[name]").forEach(node => { changes[node.name] = node.name === "options" ? node.value.split("\n").map(v => v.trim()).filter(Boolean) : node.value.trim(); });
  if (Object.keys(changes).some(key => JSON.stringify(changes[key]) !== JSON.stringify(q[key]))) edits.set(q.id, changes); else edits.delete(q.id);
  updatePublish(); return changes;
}
async function mutate(q, payload, afterSave = false) {
  if (workspaceBusy) return;
  workspaceBusy = true; error("actionErr"); renderDraft();
  try {
    draft = (await api("/api/drafts/" + draft.id + "/questions/" + q.id, "PATCH", { revision: draft.revision, ...payload })).draft;
    if (afterSave) { edits.delete(q.id); editing.delete(q.id); }
    if (payload.review) selected = draft.questions.find(item => item.review === "pending" && item.id !== q.id)?.id || q.id;
    await refreshState();
  } catch (e) { error("actionErr", e.message); }
  finally { workspaceBusy = false; renderDraft(); }
}
function renderQuestion(q) {
  const index = draft.questions.findIndex(item => item.id === q.id);
  const card = mk("article", "", "question-card current"), heading = mk("div", "", "question-heading");
  heading.append(mk("span", String(index + 1).padStart(2, "0") + " / " + q.level + " · " + q.type, "eyebrow"), mk("span", reviewNames[q.review], "badge" + (q.review === "approved" ? "" : " warn"))); card.append(heading);
  const editMode = editing.has(q.id), values = { ...q, ...edits.get(q.id) };
  if (editMode) {
    card.append(mk("p", "保存后会重新进入待审核状态。原文位置会随引用自动核对。", "small muted"));
    const form = mk("div", "", "editor-grid");
    form.append(formField("题目", "question", values.question, true));
    if (q.type === "选择") form.append(formField("选项（每行一个）", "options", values.options.join("\n"), true));
    form.append(formField("参考答案" + (q.type === "选择" ? "（单个大写字母）" : ""), "answer", values.answer, q.type !== "选择"), formField("解析", "explanation", values.explanation, true), formField("知识点", "knowledgeName", values.knowledgeName), formField("原文引用（逐字复制）", "quote", values.quote, true));
    const actions = mk("div", "", "edit-actions"), save = mk("button", "保存修改", "button primary"), cancel = mk("button", "退出编辑", "button secondary"), state = mk("p", "", "unsaved-label");
    const update = () => { save.disabled = workspaceBusy || !edits.has(q.id); cancel.disabled = workspaceBusy; state.textContent = edits.has(q.id) ? "有未保存修改 · 暂不能审核或发布" : ""; };
    form.oninput = () => { collectEdits(form, q); update(); renderList(); };
    form.querySelectorAll("input,textarea").forEach(el => { el.disabled = workspaceBusy; });
    save.onclick = () => { collectEdits(form, q); if (edits.has(q.id)) mutate(q, { changes: edits.get(q.id) }, true); };
    cancel.onclick = () => { if (edits.has(q.id)) { error("actionErr", "请先保存修改；也可点击下方“撤销未保存修改”恢复已保存版本。"); return; } editing.delete(q.id); renderDraft(); };
    actions.append(save, cancel);
    const undo = mk("button", "撤销未保存修改", "text-button"); undo.disabled = workspaceBusy; undo.onclick = () => { edits.delete(q.id); editing.delete(q.id); renderDraft(); };
    update(); card.append(form, state, actions, undo);
  } else {
    card.append(mk("h2", q.question));
    if (q.type === "选择") {
      const options = mk("ol", "", "reading-options");
      q.options.forEach((option, i) => { const li = mk("li"); li.append(mk("b", String.fromCharCode(65 + i)), mk("span", option)); options.append(li); }); card.append(options);
    }
    const answer = mk("div", "", "answer-panel"); answer.append(mk("div", "参考答案", "answer-label"), mk("strong", q.answer), mk("p", q.explanation)); card.append(answer);
  }
  const evidence = mk("button", "", "evidence-link");
  evidence.append(mk("span", q.quoteFound ? "↗ 查看原文依据 · " + (q.evidenceConfirmed ? "已人工确认" : "待判断支持性") : "未找到原文 · 暂不能通过", "evidence-label"), mk("span", q.ref, "small muted"), mk("span", "“" + q.quote + "”", "quote"));
  evidence.onclick = () => { switchTab(true); focusSource(); }; card.append(evidence);
  if (!q.quoteFound || q.note && q.review !== "approved") card.append(mk("p", !q.quoteFound ? "请编辑引用，或退回这道题。找到原句后还需要人工判断它是否支持答案。" : q.note, "review-warning"));
  if (!editMode) {
    const controls = mk("div", "", "question-actions"), confirm = mk("label", "", "confirm"), checkbox = document.createElement("input");
    checkbox.type = "checkbox"; checkbox.checked = q.evidenceConfirmed === true; checkbox.disabled = workspaceBusy || !q.quoteFound;
    confirm.append(checkbox, mk("span", "我已核对：引用内容足以支持答案"));
    const buttons = mk("div", "", "review-buttons"), approve = mk("button", "通过并审核下一题", "button primary"), reject = mk("button", "退回这道题", "button reject");
    approve.disabled = workspaceBusy || !q.quoteFound; reject.disabled = workspaceBusy;
    approve.onclick = () => { if (!checkbox.checked) { error("actionErr", "请先核对原文，并勾选引用足以支持答案。"); return; } mutate(q, { review: "approved", evidenceConfirmed: true }); };
    reject.onclick = () => mutate(q, { review: "rejected", evidenceConfirmed: false });
    buttons.append(approve, reject); controls.append(confirm, buttons); card.append(controls);
  }
  const bottom = mk("div", "", "question-bottom"), edit = mk("button", editMode ? "正在编辑" : "编辑这道题", "text-button"), next = mk("button", index < draft.questions.length - 1 ? "下一题 →" : "回到第一题 →", "text-button");
  edit.disabled = workspaceBusy || editMode; edit.onclick = () => { editing.add(q.id); renderDraft(); };
  next.disabled = workspaceBusy; next.onclick = () => { selected = draft.questions[(index + 1) % draft.questions.length].id; renderDraft(); };
  bottom.append(edit, next); card.append(bottom); return card;
}
function sourceBlocks() { return draft.sourceDocument?.blocks || draft.source.split(/\n\s*\n/).map((text, i) => ({ id: "b" + (i + 1), label: "第 " + (i + 1) + " 段", text })); }
function renderSource(q) {
  $("sourceName").textContent = draft.sourceDocument?.name || "本次课程文字";
  $("sourceLocation").textContent = q.ref;
  const ids = new Set(q.sourceLocations?.map(l => l.id) || []);
  $("sourcePreview").replaceChildren(...sourceBlocks().map(block => {
    const article = mk("article", "", "source-block"), p = mk("p"); article.dataset.block = block.id;
    const found = highlightQuote(p, block.text, q.quote);
    if (found || ids.has(block.id)) article.classList.add("matched");
    article.append(mk("h3", block.label), p); return article;
  }));
  requestAnimationFrame(() => focusSource(false));
}
function focusSource(scrollPage = true) {
  const target = $("sourcePreview").querySelector(".matched");
  if (target) $("sourcePreview").scrollTop = target.offsetTop - $("sourcePreview").offsetTop - 16;
  if (scrollPage && matchMedia("(max-width:700px)").matches) $("sourcePane").scrollIntoView({ block: "start", behavior: "smooth" });
}
function switchTab(source) {
  $("reviewGrid").classList.toggle("show-source", source);
  $("tabQuestion").setAttribute("aria-pressed", String(!source)); $("tabSource").setAttribute("aria-pressed", String(source));
}
$("tabQuestion").onclick = () => switchTab(false); $("tabSource").onclick = () => { switchTab(true); focusSource(false); };
function updatePublish() {
  if (!draft) return;
  const counts = { approved: 0, rejected: 0, pending: 0 }; draft.questions.forEach(q => counts[q.review]++);
  $("reviewStat").textContent = "已处理 " + (counts.approved + counts.rejected) + " / " + draft.questions.length + " 题 · 通过 " + counts.approved + " · 退回 " + counts.rejected;
  $("reviewProgress").max = draft.questions.length; $("reviewProgress").value = counts.approved + counts.rejected;
  $("publish").disabled = workspaceBusy || edits.size > 0 || counts.pending > 0 || counts.approved === 0;
  $("practiceNow").disabled = workspaceBusy || edits.size > 0 || generating;
  $("publishHint").textContent = edits.size ? "请先保存所有修改，再开始练习。" : counts.pending ? "还有 " + counts.pending + " 道未人工核对的题目；可以直接练习，也可以继续核对。" : counts.approved ? "可保存 " + counts.approved + " 道已人工核对的题目；退回题不会进入练习。" : "直接练习会自动排除已退回和引用无法定位的题目。";
  const pub = publications.find(p => p.draftId === draft.id && p.draftRevision === draft.revision);
  $("studentLink").hidden = !pub;
  if (pub) $("studentLink").href = "/student.html?pack=" + encodeURIComponent(pub.id);
}
function renderDraft() {
  if (!draft) return;
  $("draftSelect").value = draft.id; $("draftSelect").disabled = workspaceBusy || generating;
  $("draftMeta").textContent = draft.topic;
  const duration = draft.generation ? " · 生成 " + (draft.generation.elapsedMs / 1000).toFixed(1) + " 秒" + (draft.generation.usage?.total_tokens ? " · " + draft.generation.usage.total_tokens + " tokens" : "") : "";
  $("draftMode").textContent = draft.course + " · " + modeName(draft.mode) + " · 修订 " + draft.revision + duration;
  if (!draft.questions.some(q => q.id === selected)) selected = draft.questions[0].id;
  renderList(); const q = draft.questions.find(q => q.id === selected);
  $("items").replaceChildren(renderQuestion(q)); renderSource(q); updatePublish();
}
$("draftSelect").onchange = event => {
  if (edits.size || workspaceBusy) { event.target.value = draft.id; error("actionErr", "请先保存当前修改，再切换草稿。"); return; }
  loadDraft(event.target.value).catch(e => error("actionErr", e.message));
};
async function create(kind) {
  if (generating || workspaceBusy || importBusy) return;
  if (edits.size) { error("genErr", "请先保存工作台中的修改，再创建新草稿。"); return; }
  if (kind !== "demo" && !isModelConfigured()) { error("genErr", "真实模型尚未配置。请点击“设置自己的 API”填写，或先载入固定样例。"); return; }
  const questionCount = Number($("requestedQuestions").value);
  if (kind !== "demo" && (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 30)) { error("genErr", "请选择 1—30 之间的整数题数。"); return; }
  generating = true; workspaceBusy = true; setModelBusy(true); error("genErr"); $("demo").disabled = true; updateGenerate(); renderDraft(); $("source").disabled = true; $("fileInput").disabled = true;
  const button = kind === "demo" ? $("demo") : $("gen"), label = button.textContent; button.textContent = kind === "demo" ? "正在载入…" : "生成中，请稍候（最多 120 秒）…";
  try {
    const modelConfig = getModelConfig();
    const payload = kind === "demo" ? {} : { questionCount, course: value("course"), topic: value("topic"), goal: value("goal"), source: value("source"), ...(sourceDocument ? { sourceDocument } : {}), ...(scopeBlockIds() ? { blockIds: scopeBlockIds() } : {}), ...mixPayload(), ...(modelConfig ? { modelConfig } : {}) };
    let result;
    if (kind === "demo") result = await api("/api/demo", "POST", payload);
    else {
      showGeneration({ stage: "prepare", startedAt: Date.now() });
      const { jobId } = await api("/api/generation-jobs", "POST", payload);
      store("activeJob", jobId); store("jobPracticeMode", value("practiceMode"));
      result = await waitGeneration(jobId);
      store("activeJob", "");
    }
    draft = result.draft; selected = draft.questions[0].id; edits.clear(); editing.clear(); store("lastDraft", draft.id);
    await refreshState(); renderDraft(); switchTab(false); showView("review"); window.scrollTo({ top: 0, behavior: "smooth" });
    if (value("practiceMode") === "direct") {
      try { await startDirectPractice(); }
      catch (e) { error("actionErr", "草稿已保存。" + e.message); }
    }
  } catch (e) {
    error("genErr", e.message);
    if (kind !== "demo") showGeneration({ ...latestGeneration, stage: "failed", error: e.message });
  }
  finally { finishGeneration(); generating = false; workspaceBusy = false; setModelBusy(false); button.textContent = label; $("demo").disabled = false; $("source").disabled = false; $("fileInput").disabled = false; updateGenerate(); renderDraft(); }
}
function showGeneration(job) {
  const first = !latestGeneration || (["done", "failed"].includes(latestGeneration.stage) && !["done", "failed"].includes(job.stage));
  latestGeneration = job;
  const labels = { prepare: "1 / 4 · 准备课程材料", model: "2 / 4 · 模型正在生成题目", validate: "3 / 4 · 核对题目与原文引用", save: "4 / 4 · 保存复习包", done: "生成完成，草稿已保存", failed: "本次生成未完成" };
  $("generationStage").textContent = labels[job.stage];
  $("generationSummary").hidden = false;
  $("generationSummaryText").textContent = labels[job.stage] + (job.error ? "：" + job.error : "");
  $("openGeneration").hidden = ["done", "failed"].includes(job.stage);
  const step = ({ prepare: 0, model: 1, validate: 2, save: 3, done: 4, failed: 0 })[job.stage];
  $("generationProgress").classList.toggle("is-waiting", job.stage === "model");
  $("generationProgress").setAttribute("aria-valuetext", labels[job.stage]);
  if (job.stage === "model") $("generationProgress").removeAttribute("aria-valuenow");
  else $("generationProgress").setAttribute("aria-valuenow", String(step));
  $("generationFill").style.width = job.stage === "model" ? "42%" : (step * 25) + "%";
  [...$("generationSteps").children].forEach((node, i) => { node.classList.toggle("complete", i < step); node.classList.toggle("current", i === step); });
  const updateTime = () => { $("generationTime").textContent = `已用 ${Math.max(0, Math.floor((Date.now() - latestGeneration.startedAt) / 1000))} 秒 · 模型请求最多等待 120 秒`; };
  updateTime();
  if (!generationClock && !["done", "failed"].includes(job.stage)) generationClock = setInterval(updateTime, 1000);
  if (first && !$("generationPanel").open && !["done", "failed"].includes(job.stage)) $("generationPanel").showModal();
}
function finishGeneration() { clearInterval(generationClock); generationClock = null; $("generationPanel").close(); }
$("minimizeGeneration").onclick = () => $("generationPanel").close();
$("openGeneration").onclick = () => $("generationPanel").showModal();
async function waitGeneration(jobId) {
  while (true) {
    const { job } = await api("/api/generation-jobs/" + encodeURIComponent(jobId)); showGeneration(job);
    if (job.stage === "failed") { store("activeJob", ""); throw new Error(job.error); }
    if (job.stage === "done") return api("/api/drafts/" + job.draftId);
    await new Promise(resolve => setTimeout(resolve, 800));
  }
}
$("legacyFile").onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error("备份超过 20 MB，请保留原件并联系维护者分批迁移。");
    const backup = JSON.parse(await file.text());
    await api("/api/workspace/import", "POST", backup);
    await refreshState();
    let restoredCount = 0, browserFailed = false;
    for (const item of Array.isArray(backup.browserPractice) ? backup.browserPractice : []) {
      if (!validPracticeId(item.id) || !item.data || item.data.version !== 1 || typeof item.data.answers !== "object" || !item.data.answers) continue;
      const current = readSession(item.id);
      if (current && current.savedAt >= (item.data.savedAt || 0)) continue;
      try { writeSession(item.id, item.data); restoredCount++; } catch { browserFailed = true; }
    }
    $("legacyStatus").textContent = "已恢复并合并学习记录，原文件和已有记录均保留。" + (restoredCount ? ` 已恢复 ${restoredCount} 份暂存练习。` : "") + (browserFailed ? " 但浏览器未能保存部分暂存答案，请保留备份。" : "");
    await refreshState();
  } catch (e) { $("legacyStatus").textContent = "未完成导入：" + e.message; }
  event.target.value = "";
};
function validPracticeId(id) { return typeof id === "string" && publications.some(p => id === p.id || id.startsWith(p.id + ":only:") || id.startsWith(p.id + ":attempt:")); }
$("backupWorkspace").onclick = async () => {
  $("backupWorkspace").disabled = true;
  try {
    const backup = await api("/api/workspace/export");
    backup.browserPractice = [];
    const packIds = new Set(backup.publications.map(p => p.id));
    let browserComplete = true;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i), id = key?.slice(sessionKey("").length);
        if (!key?.startsWith(sessionKey("")) || !packIds.has(id?.split(/:only:|:attempt:/)[0])) continue;
        const data = readSession(id); if (data) backup.browserPractice.push({ id, data });
      }
    } catch { browserComplete = false; }
    const content = JSON.stringify(backup, null, 2);
    if (new Blob([content]).size > 20 * 1024 * 1024) throw new Error("记录已超过当前 20 MB 恢复限制。请保留应用 data 文件夹，联系维护者分批备份。");
    download("知速达-全部学习记录-" + new Date().toISOString().slice(0, 10) + ".json", content);
    $("legacyStatus").textContent = "已开始下载备份，请在浏览器的下载列表确认保存位置。日常使用无需导入；换环境或找不回记录时再恢复。" + (browserComplete ? "" : " 浏览器存储不可用：本次仅备份电脑中已保存的记录，未包含暂存答案。");
  } catch (e) { $("legacyStatus").textContent = "备份未完成：" + e.message; }
  finally { $("backupWorkspace").disabled = false; }
};
$("gen").onclick = () => create("live"); $("demo").onclick = () => create("demo");
async function startDirectPractice() {
  const { publication } = await api("/api/drafts/" + draft.id + "/publish", "POST", { revision: draft.revision, reviewMode: "self-study" });
  store("lastView", "library");
  location.assign("/student.html?pack=" + encodeURIComponent(publication.id));
}
$("practiceNow").onclick = async () => {
  if (!draft || workspaceBusy || generating || edits.size) { error("actionErr", "请先保存题目修改，再开始练习。"); return; }
  workspaceBusy = true; renderDraft(); $("practiceNow").disabled = true;
  try { await startDirectPractice(); }
  catch (e) { error("actionErr", e.message); }
  finally { workspaceBusy = false; renderDraft(); $("practiceNow").disabled = false; }
};
$("publish").onclick = async () => {
  if (workspaceBusy || edits.size) return;
  workspaceBusy = true; error("actionErr"); renderDraft();
  try {
    const result = await api("/api/drafts/" + draft.id + "/publish", "POST", { revision: draft.revision });
    await refreshState(); await loadReport(result.publication.id);
  } catch (e) { error("actionErr", e.message); }
  finally { workspaceBusy = false; renderDraft(); }
};
async function loadReport(id) {
  reportId = id;
  const { report } = await api("/api/publications/" + id + "/report");
  $("report").hidden = false;
  const publication = publications.find(p => p.id === id);
  $("reportTitle").textContent = publication ? publication.topic : "学生练习概览";
  $("reportStat").textContent = "反馈完成 " + report.completed + "/" + report.totalAttempts + " 次 · 已反馈的客观题 " + report.objectiveCorrect + "/" + report.objectiveCount + " 题答对";
  $("reportNote").textContent = report.note;
  $("reportList").replaceChildren(...(report.common.length ? report.common.map(row => {
    const li = mk("li"); li.append(mk("b", row.knowledge + " · " + row.count + "/" + row.total), mk("p", row.question + " · " + row.measure, "small muted"), mk("p", row.suggestion, "small")); return li;
  }) : [mk("li", "尚未收到反馈。学生完成作答和自评后，再刷新报告。", "muted")]));
  $("reportComments").replaceChildren(...report.comments.map(c => mk("p", c.nickname + "：" + c.text, "small")));
  showView("library");
}
async function exportPublication(id) { download("知速达-发布包-" + id.slice(0, 8) + ".json", JSON.stringify(await api("/api/publications/" + id + "/export"), null, 2)); }
$("refreshReport").onclick = () => { if (reportId) loadReport(reportId).catch(e => error("actionErr", e.message)); };
$("exportReview").onclick = () => {
  if (!draft) return;
  const cell = value => { let s = String(value ?? ""); if (/^\s*[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const rows = [["编号", "档位", "题目", "选项", "答案", "解析", "知识点", "来源位置", "原文引用", "找到引用", "人工确认支持答案", "审核结果"]];
  draft.questions.forEach((q, i) => rows.push([i + 1, q.level, q.question, q.options.join(" / "), q.answer, q.explanation, q.knowledgeName, q.ref, q.quote, q.quoteFound ? "是" : "否", q.evidenceConfirmed ? "是" : "否", reviewNames[q.review]]));
  download("知速达-题目核对.csv", "\ufeff" + rows.map(row => row.map(cell).join(",")).join("\r\n"), "text/csv;charset=utf-8");
};
window.addEventListener("beforeunload", event => { if (edits.size) { event.preventDefault(); event.returnValue = ""; } });
async function init() {
  const state = await refreshState(), id = state.drafts.find(d => d.id === restored("lastDraft"))?.id || state.drafts[0]?.id;
  const requestedView = new URLSearchParams(location.search).get("view");
  const view = requestedView || restored("lastView") || "import";
  if (id) await loadDraft(id);
  previewImport(); showView(["import", "review", "library"].includes(view) ? view : "import");
  const jobId = state.activeJobId || restored("activeJob");
  if (jobId) {
    generating = true; workspaceBusy = true; setModelBusy(true); updateGenerate(); renderDraft(); $("demo").disabled = true;
    showGeneration({ stage: "prepare", startedAt: Date.now() });
    try {
      const result = await waitGeneration(jobId); draft = result.draft; store("activeJob", ""); store("lastDraft", draft.id);
      selected = draft.questions[0].id; await refreshState(); renderDraft(); showView("review");
      if (restored("jobPracticeMode") === "direct") await startDirectPractice();
    } catch (e) { store("activeJob", ""); showGeneration({ ...latestGeneration, stage: "failed", error: e.message + " 不会自动重新调用模型。" }); error("genErr", e.message + " 不会自动重新调用模型。"); }
    finally { finishGeneration(); generating = false; workspaceBusy = false; setModelBusy(false); $("demo").disabled = false; updateGenerate(); renderDraft(); }
  }
}
init().catch(e => error("actionErr", e.message));
