import { $, api, error } from "./shared.js";

// 临时密钥仅在页面内存中；记住后网页只持有 useSaved 标识，不取回密钥。
let sessionConfig = null, savedMeta = null, tested = false, serverModel = { configured: false, mode: "live" }, busy = false, testing = false, epoch = 0;
const form = $("modelForm"), dialog = $("modelDialog");
form.reset();

export const getModelConfig = () => sessionConfig ? { ...sessionConfig } : null;
export const isModelConfigured = () => Boolean(sessionConfig || serverModel.configured);
export function setServerModel(model) {
  serverModel = model; savedMeta = model.saved || null;
  if (sessionConfig?.useSaved && !savedMeta) sessionConfig = null;
  if (!sessionConfig && savedMeta) { sessionConfig = { useSaved: true }; fillSaved(); }
  render();
}
export function setModelBusy(value) { busy = value; render(); }

function fillSaved() {
  $("modelBaseUrl").value = savedMeta.baseUrl; $("modelName").value = savedMeta.model;
  $("modelJsonMode").checked = savedMeta.jsonMode; $("rememberModel").checked = true;
  $("modelApiKey").value = "";
}

function render() {
  $("modelStatus").textContent = serverModel.settingsError || (sessionConfig?.useSaved
    ? "已在这台电脑加密记住：" + savedMeta.model + "。刷新或关闭后重开可直接使用，无需再次填写密钥。"
    : sessionConfig ? "仅本次使用：" + sessionConfig.model + (tested ? " · 连接测试已通过。" : " · 尚未测试连接。") + " 刷新或离开后需重新填写。"
    : serverModel.mode === "mock" ? "本机模拟模式：固定 AVL 树联调数据。设置自己的 API 后优先使用你的配置。"
    : serverModel.configured ? "正在使用本机预设模型。你可以填写自己的 API 替换它。"
    : "尚未配置模型接口。填写自己的 API，或先体验下方固定样例。");
  $("openModel").textContent = sessionConfig ? "修改模型设置" : "设置自己的 API";
  $("openModel").disabled = busy || testing;
  $("modelFields").disabled = testing;
  ["applyModel", "testModel", "clearModel", "closeModel"].forEach(id => { $(id).disabled = busy || testing; });
  $("clearModel").hidden = !sessionConfig && !savedMeta && !serverModel.settingsError;
  $("clearModel").textContent = savedMeta || serverModel.settingsError ? "忘记这台电脑上保存的 API" : "清除本次 API 设置";
  $("rememberModel").disabled = !serverModel.localSaveSupported;
  $("rememberHint").textContent = serverModel.localSaveSupported ? "适合自己的电脑。刷新、关闭网页或重启知速达后，仍可直接生成。" : "此系统暂不支持加密记住。仅本次使用的密钥会在离开页面后清除。";
  $("modelApiKey").placeholder = savedMeta ? "已加密保存；继续使用时留空" : "粘贴服务商提供的密钥";
  $("modelKeyHint").textContent = savedMeta ? "留空会继续使用已保存配置；修改接口地址、模型或保存方式时，请重新输入密钥。" : "密钥用于调用模型。不要填写登录密码，也不要把密钥发给组员。";
  $("applyModel").textContent = testing ? "正在处理…" : "保存设置并使用";
  $("testModel").textContent = testing ? "正在处理（连接测试最多 25 秒）…" : "测试连接并保存设置";
}
function candidate() {
  const baseUrl = $("modelBaseUrl").value.trim(), model = $("modelName").value.trim(), apiKey = $("modelApiKey").value.trim();
  if (!baseUrl || !model) throw new Error("请填写接口地址和模型名称。");
  let address;
  try { address = new URL(baseUrl); } catch { throw new Error("请填写完整的接口地址，例如 https://你的服务地址/v1。"); }
  if ((address.protocol !== "https:" && !(address.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(address.hostname))) || address.username || address.password || address.search || address.hash) {
    throw new Error("接口需使用 HTTPS，且不包含账号、查询参数或片段；本机调试地址可以使用 HTTP。");
  }
  if (/[\s\x00-\x1f\x7f]/.test(apiKey)) throw new Error("密钥不能含空格或换行，请只复制密钥本身。");
  const normalized = address.href.replace(/\/+$/, ""), jsonMode = $("modelJsonMode").checked;
  if (!apiKey && savedMeta) {
    if (normalized !== savedMeta.baseUrl || model !== savedMeta.model || jsonMode !== savedMeta.jsonMode || !$("rememberModel").checked) throw new Error("修改已保存配置时，请重新填写密钥，再保存。");
    return { useSaved: true };
  }
  if (!apiKey) throw new Error("请粘贴服务商提供的 API 密钥。");
  return { baseUrl: normalized, model, apiKey, jsonMode };
}
function reset() {
  epoch++; sessionConfig = null; tested = false; form.reset();
  $("modelApiKey").type = "password"; $("toggleModelKey").textContent = "显示";
  $("toggleModelKey").setAttribute("aria-pressed", "false"); $("toggleModelKey").setAttribute("aria-label", "显示 API 密钥");
  error("modelErr"); $("modelTestStatus").textContent = ""; render();
}
async function apply(config) {
  const remember = $("rememberModel").checked;
  const result = await api("/api/model/settings", "POST", { modelConfig: config, remember });
  savedMeta = result.saved; serverModel.saved = savedMeta; serverModel.settingsError = "";
  sessionConfig = remember ? { useSaved: true } : config;
  if (remember) fillSaved();
  error("genErr");
}
$("openModel").onclick = () => { error("modelErr"); dialog.showModal(); };
$("closeModel").onclick = () => dialog.close();
dialog.addEventListener("cancel", event => { if (testing) event.preventDefault(); });
dialog.addEventListener("close", () => {
  $("modelApiKey").type = "password"; $("toggleModelKey").textContent = "显示";
  $("toggleModelKey").setAttribute("aria-pressed", "false"); $("toggleModelKey").setAttribute("aria-label", "显示 API 密钥");
});
$("toggleModelKey").onclick = () => {
  const show = $("modelApiKey").type === "password";
  $("modelApiKey").type = show ? "text" : "password";
  $("toggleModelKey").textContent = show ? "隐藏" : "显示";
  $("toggleModelKey").setAttribute("aria-pressed", String(show));
  $("toggleModelKey").setAttribute("aria-label", show ? "隐藏 API 密钥" : "显示 API 密钥");
};
form.onsubmit = async event => {
  event.preventDefault(); if (testing || busy) return;
  try { const config = candidate(); testing = true; render(); await apply(config); tested = false; dialog.close(); }
  catch (e) { error("modelErr", e.message); }
  finally { testing = false; render(); }
};
form.addEventListener("input", () => { error("modelErr"); $("modelTestStatus").textContent = sessionConfig ? "表单修改尚未启用，请点击下方按钮使用新配置。" : ""; });
$("testModel").onclick = async () => {
  if (testing || busy) return;
  error("modelErr"); $("modelTestStatus").textContent = "";
  let config;
  try { config = candidate(); } catch (e) { error("modelErr", e.message); return; }
  const startedEpoch = epoch;
  testing = true; render();
  try {
    const result = await api("/api/model/test", "POST", { modelConfig: config });
    if (epoch !== startedEpoch) return;
    await apply(config); tested = true;
    $("modelTestStatus").textContent = "连接成功，用时 " + (result.elapsedMs / 1000).toFixed(1) + " 秒；" + (savedMeta ? "已加密记住，下次无需重填。" : "已启用，仅本次使用。") + "连接测试不能保证题目正确，有疑问时可核对原文。";
  } catch (e) { error("modelErr", e.message); }
  finally { testing = false; render(); }
};
$("clearModel").onclick = async () => {
  if (busy || testing) return;
  if ((savedMeta || serverModel.settingsError) && !confirm("让知速达忘记已保存的 API？下次生成需要重新填写，复习包和学习记录不受影响。")) return;
  try {
    testing = true; render();
    if (savedMeta || serverModel.settingsError) await api("/api/model/settings/forget", "POST", {});
    savedMeta = null; serverModel.saved = null; serverModel.settingsError = ""; reset();
    $("modelTestStatus").textContent = "API 设置已清除。复习包和学习记录仍在。";
  } catch (e) { error("modelErr", e.message); }
  finally { testing = false; render(); }
};
window.addEventListener("pagehide", () => { epoch++; sessionConfig = null; $("modelApiKey").value = ""; });
window.addEventListener("pageshow", async event => {
  if (event.persisted) { reset(); try { setServerModel((await api("/api/state")).model); } catch (e) { error("genErr", e.message); } }
});
