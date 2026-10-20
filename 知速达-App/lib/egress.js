// 公开部署时限制“用户自填模型地址”的出网目标，防止服务端被用来访问内网、本机或云平台元数据。
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(address, prefix, "ipv4");
// 注意：Node 的 BlockList 会把 IPv4 地址按 ::ffff:0:0/96 与 IPv6 规则比较，所以这里不能列出该网段，
// 否则所有 IPv4 都会被拦截。IPv4 映射地址在 isBlockedAddress 中单独拆出再检查。
for (const [address, prefix] of [
  ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blocked.addSubnet(address, prefix, "ipv6");
blocked.addAddress("::1", "ipv6");

// ::ffff:a.b.c.d 或 ::ffff:7f00:1 形式的 IPv4 映射地址 → 取出内含的 IPv4；不是映射地址则返回 null。
function mappedIPv4(address) {
  let text = address.toLowerCase();
  const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    if ([a, b, c, d].some(part => part > 255)) return null;
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [], tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail].map(part => parseInt(part, 16));
  if (groups.length !== 8 || groups.some(Number.isNaN)) return null;
  if (groups.slice(0, 5).some(Boolean) || groups[5] !== 0xffff) return null;
  return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
}

export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  if (family === 6) {
    const embedded = mappedIPv4(address);
    if (embedded) return isBlockedAddress(embedded);
  }
  try { return blocked.check(address, family === 4 ? "ipv4" : "ipv6"); } catch { return true; }
}

const refuse = () => Object.assign(new Error("公开服务只允许访问公网 HTTPS 模型接口，不能访问本机、内网或云平台地址。"), { status: 400 });

// 解析域名并要求全部结果都是公网地址；返回要连接的那一个，调用方必须固定连接它。
export async function resolvePublicAddress(hostname, lookup = dns.lookup) {
  const bare = hostname.replace(/^\[|\]$/g, "");
  let rows;
  if (net.isIP(bare)) rows = [{ address: bare, family: net.isIP(bare) }];
  else {
    try { rows = await lookup(bare, { all: true, verbatim: true }); }
    catch { throw Object.assign(new Error("无法解析模型服务的域名，请检查接口地址。"), { status: 502 }); }
  }
  if (!rows.length || rows.some(row => isBlockedAddress(row.address))) throw refuse();
  return rows[0];
}

// 让 TLS 仍按域名校验证书，但连接只会发往刚才检查过的地址，避免检查后再次解析被换成内网地址。
export function pinnedLookup(address, family) {
  return (hostname, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

export async function readLimited(stream, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximum) { stream.destroy(); throw Object.assign(new Error("模型服务返回的内容过大，已拒绝处理。"), { status: 502 }); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 返回与 fetch 响应兼容的最小对象（ok、status、json），供 chatJson 共用后续处理。
export async function guardedFetch(endpoint, { headers, body, timeoutMs }, { lookup, maxBytes = 4 * 1024 * 1024 } = {}) {
  if (endpoint.protocol !== "https:") throw refuse();
  const target = await resolvePublicAddress(endpoint.hostname, lookup);
  const response = await new Promise((resolve, reject) => {
    let timedOut = false;
    const fail = error => reject(timedOut ? Object.assign(new Error("timeout"), { name: "TimeoutError" }) : error);
    const timer = setTimeout(() => { timedOut = true; request.destroy(); }, timeoutMs);
    const request = https.request(endpoint, {
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      lookup: pinnedLookup(target.address, target.family),
    }, res => {
      readLimited(res, maxBytes).then(
        buffer => { clearTimeout(timer); resolve({ status: res.statusCode, text: buffer.toString("utf8") }); },
        error => { clearTimeout(timer); fail(error); },
      );
    });
    request.on("error", error => { clearTimeout(timer); fail(error); });
    request.end(body);
  });
  if (response.status >= 300 && response.status < 400) {
    throw Object.assign(new Error("模型服务返回了重定向。为避免密钥被转发，接口不能依赖重定向，请填写最终地址。"), { status: 502 });
  }
  return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => JSON.parse(response.text) };
}
