// 对接任意兼容 OpenAI chat/completions 的大模型。零依赖。

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
  };
}

export async function chatJson(system, user, cfg = llmConfig(), timeoutMs = 120_000) {
  if (cfg.mock) return structuredClone(MOCK_PACK);
  if (!cfg.baseUrl || !cfg.model || !cfg.apiKey) {
    const e = new Error("模型未配置：请在 .env 中填写 LLM_BASE_URL、LLM_MODEL、LLM_API_KEY，或设置 LLM_MOCK=1。");
    e.status = 503;
    throw e;
  }
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = new Error(err.name === "TimeoutError" ? "模型响应超时。" : "无法连接到模型服务。");
    e.status = 502;
    throw e;
  }
  if (!res.ok) {
    // 不把上游返回体原样透出，避免泄露内部信息
    const e = new Error(`模型服务返回错误（HTTP ${res.status}）。`);
    e.status = 502;
    throw e;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error("模型返回的内容不是合法 JSON，请重试。");
    e.status = 502;
    throw e;
  }
}
