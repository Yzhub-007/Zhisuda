// 使用原生 fetch 对接兼容 chat/completions 的模型服务。

const MOCK_PACK = {
  knowledge: [
    { name: "树的高度", explain: "空树高度为 -1，单节点为 0。", confusion: "按边数计，不是按节点数。",
      quote: "The height of an empty tree is defined to be -1", status: "已核对" },
  ],
  questions: [
    { level: "基础", type: "选择", question: "讲义中空树的高度被定义为多少？",
      options: ["0", "-1", "1", "未定义"], answer: "B", explanation: "空树为 -1。",
      knowledgeName: "树的高度", ref: "§1.1 p.1-1",
      quote: "The height of an empty tree is defined to be -1", status: "已核对" },
    { level: "拓展", type: "简答", question: "（模拟）一道引用不存在的题。",
      answer: "示例", explanation: "用于演示降级。", knowledgeName: "树的高度",
      ref: "§0", quote: "this sentence is not in the lecture", status: "已核对" },
  ],
};

export function llmConfig(env = process.env) {
  return {
    baseUrl: (env.LLM_BASE_URL ?? "").replace(/\/+$/, ""),
    model: env.LLM_MODEL ?? "",
    apiKey: env.LLM_API_KEY ?? "",
    mock: env.LLM_MOCK === "1",
    jsonMode: env.LLM_JSON_MODE !== "0",
  };
}

// 用户配置只属于本次请求；不修改环境变量、不缓存密钥。
export function requestConfig(input, fallback = llmConfig()) {
  if (input === undefined) return fallback;
  const invalid = message => Object.assign(new Error(message), { status: 400 });
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("模型设置格式无效，请重新填写。");
  const field = (key, label, maximum) => {
    const value = typeof input[key] === "string" ? input[key].trim() : "";
    if (!value || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw invalid(`请填写有效的${label}。`);
    return value;
  };
  const baseUrl = field("baseUrl", "接口地址", 2048), model = field("model", "模型名称", 200), apiKey = field("apiKey", "API 密钥", 4096);
  let address;
  try { address = new URL(baseUrl); } catch { throw invalid("接口地址格式不正确，请填写完整的 https:// 地址。"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(address.hostname);
  if ((address.protocol !== "https:" && !(address.protocol === "http:" && loopback)) || address.username || address.password || address.search || address.hash) {
    throw invalid("接口需使用 HTTPS，且不包含账号、查询参数或片段；本机调试地址可以使用 HTTP。");
  }
  if (/\s/.test(apiKey)) throw invalid("API 密钥不能包含空格或换行，请只填写密钥本身。");
  if (input.jsonMode !== undefined && typeof input.jsonMode !== "boolean") throw invalid("JSON 模式设置无效。");
  return { baseUrl: address.href.replace(/\/+$/, ""), model, apiKey, jsonMode: input.jsonMode !== false, mock: false };
}

export async function chatJson(system, user, cfg = llmConfig(), timeoutMs = 120_000) {
  if (cfg.mock) return structuredClone(MOCK_PACK);
  if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) {
    const e = new Error("模型未配置：请在页面的“模型设置”中填写自己的接口地址、模型名和 API 密钥，或先使用固定样例。");
    e.status = 503;
    throw e;
  }
  let endpoint;
  try {
    endpoint = new URL(cfg.baseUrl);
    if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
    if (!endpoint.pathname.endsWith("/chat/completions")) endpoint.pathname += "/chat/completions";
  } catch { throw Object.assign(new Error("模型地址格式不正确，请使用服务商给出的兼容接口地址。"), { status: 503 }); }
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        ...(cfg.jsonMode !== false ? { response_format: { type: "json_object" } } : {}),
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error", // 不把用户密钥随服务商重定向转发到其他地址。
    });
    if (!res.ok) {
      const reasons = { 400: "请求参数或模型不兼容。若服务商不支持 JSON 模式，可在“模型设置”中取消勾选后重试。", 401: "密钥未通过验证，请在模型设置中检查。", 403: "当前密钥没有此模型的访问权限。", 404: "请核对接口地址和模型名称。", 429: "请求过于频繁或额度不足，请在服务商控制台检查。" };
      throw Object.assign(new Error(`模型服务返回 HTTP ${res.status}。${reasons[res.status] || "服务暂不可用，请稍后重试。"}`), { status: 502 });
    }
    const data = await res.json();
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === "length") throw Object.assign(new Error("模型输出被长度限制截断，请缩短材料后重试。"), { status: 502 });
    const content = choice?.message?.content;
    if (typeof content !== "string") throw Object.assign(new Error("模型没有返回文字内容，请确认选用支持对话输出的模型。"), { status: 502 });
    const parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError();
    const usage = data.usage;
    if (usage) parsed._usage = Object.fromEntries(["prompt_tokens", "completion_tokens", "total_tokens"].filter(k => Number.isFinite(usage[k])).map(k => [k, usage[k]]));
    return parsed;
  } catch (err) {
    if (err.status) throw err;
    const e = new Error(err.name === "TimeoutError" ? `模型响应超过 ${Math.ceil(timeoutMs / 1000)} 秒，请稍后重试。` : err instanceof SyntaxError ? "模型返回的内容不是合法 JSON，请重试。" : "无法连接到模型服务，请检查地址和网络；接口不能依赖重定向。");
    e.status = 502;
    throw e;
  }
}
