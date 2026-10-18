import { $, api, error } from "./shared.js";

// 仅存在当前页面的 JS 内存中，不写入 localStorage / sessionStorage。
let sessionConfig = null, tested = false, serverModel = { configured: false, mode: "live" }, busy = false, testing = false, epoch = 0;
const form = $("modelForm"), dialog = $("modelDialog");
form.reset();

export const getModelConfig = () => sessionConfig ? { ...sessionConfig } : null;
export const isModelConfigured = () => Boolean(sessionConfig || serverModel.configured);
export function setServerModel(model) { serverModel = model; render(); }
export function setModelBusy(value) { busy = value; render(); }

function render() {
  $("modelStatus").textContent = sessionConfig
    ? "本页 API：" + sessionConfig.model + (tested ? " · 连接测试已通过。" : " · 尚未测试连接。") + " 刷新后需重新填写。"
    : serverModel.mode === "mock" ? "本机模拟模式：固定 AVL 树联调数据。设置自己的 API 后优先使用你的配置。"
    : serverModel.configured ? "正在使用本机预设模型。你可以填写自己的 API 替换它。"
    : "尚未配置模型接口。填写自己的 API，或先体验下方固定样例。";
  $("openModel").textContent = sessionConfig ? "修改模型设置" : "设置自己的 API";
  $("openModel").disabled = busy || testing;
  $("modelFields").disabled = testing;
  ["applyModel", "testModel", "clearModel", "closeModel"].forEach(id => { $(id).disabled = busy || testing; });
  $("clearModel").hidden = !sessionConfig;
  $("testModel").textContent = testing ? "正在测试（最多 25 秒）…" : "测试连接并使用";
}
function candidate() {
  const baseUrl = $("modelBaseUrl").value.trim(), model = $("modelName").value.trim(), apiKey = $("modelApiKey").value.trim();
  if (!baseUrl || !model || !apiKey) throw new Error("请填写接口地址、模型名称和 API 密钥。");
  let address;
  try { address = new URL(baseUrl); } catch { throw new Error("请填写完整的接口地址，例如 https://你的服务地址/v1。"); }
  if ((address.protocol !== "https:" && !(address.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(address.hostname))) || address.username || address.password || address.search || address.hash) {
    throw new Error("接口需使用 HTTPS，且不包含账号、查询参数或片段；本机调试地址可以使用 HTTP。");
  }
  if (/[\s\x00-\x1f\x7f]/.test(apiKey)) throw new Error("密钥不能含空格或换行，请只复制密钥本身。");
  return { baseUrl: address.href.replace(/\/+$/, ""), model, apiKey, jsonMode: $("modelJsonMode").checked };
}
function reset() {
  epoch++; sessionConfig = null; tested = false; form.reset();
  $("modelApiKey").type = "password"; $("toggleModelKey").textContent = "显示";
  $("toggleModelKey").setAttribute("aria-pressed", "false"); $("toggleModelKey").setAttribute("aria-label", "显示 API 密钥");
  error("modelErr"); $("modelTestStatus").textContent = ""; render();
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
form.onsubmit = event => {
  event.preventDefault(); if (testing || busy) return;
  try { sessionConfig = candidate(); tested = false; render(); error("genErr"); dialog.close(); }
  catch (e) { error("modelErr", e.message); }
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
    sessionConfig = config; tested = true; error("genErr");
    $("modelTestStatus").textContent = "连接成功，用时 " + (result.elapsedMs / 1000).toFixed(1) + " 秒；已在本页启用。测试只验证接口和 JSON 返回，不能保证题目正确；有疑问时可核对原文。";
  } catch (e) { error("modelErr", e.message); }
  finally { testing = false; render(); }
};
$("clearModel").onclick = () => { reset(); $("modelTestStatus").textContent = "本页配置已清除。"; };
window.addEventListener("pagehide", reset);
window.addEventListener("pageshow", event => { if (event.persisted) reset(); });
