export const $ = id => document.getElementById(id);
// 来自模型、课件和反馈的文本均用 textContent，不作为 HTML 执行。
export function mk(tag, value = "", cls = "") {
  const node = document.createElement(tag); node.textContent = value; if (cls) node.className = cls; return node;
}
export function error(id, message = "") { const node = $(id); node.textContent = message; node.hidden = !message; }
export async function api(url, method = "GET", body) {
  const res = await fetch(url, { method, headers: method === "GET" ? {} : { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}
export function download(filename, content, type = "application/json") {
  const href = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a"); link.href = href; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
}

// 保留原文显示，仅在匹配时统一空白与引号；避免模型文字进入 innerHTML。
export function highlightQuote(node, source, quote) {
  function normalize(value) {
    let text = "", map = [], space = false;
    for (let i = 0; i < value.length; i++) {
      let char = value[i].replace(/[‘’]/g, "'").replace(/[“”]/g, '"').toLowerCase();
      if (/\s/.test(char)) { if (space) continue; char = " "; space = true; } else space = false;
      text += char; map.push(i);
    }
    return { text, map };
  }
  const normalized = normalize(source), needle = normalize(quote || "").text.trim();
  const index = needle.length >= 6 ? normalized.text.indexOf(needle) : -1;
  if (index < 0) { node.textContent = source; return false; }
  const start = normalized.map[index], end = normalized.map[index + needle.length - 1] + 1;
  node.replaceChildren(document.createTextNode(source.slice(0, start)), mk("mark", source.slice(start, end)), document.createTextNode(source.slice(end)));
  return true;
}
