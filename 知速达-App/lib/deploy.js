// 部署相关配置：默认保持本机模式；只有明确设置 ZHISUDA_PUBLIC=1 才启用公开部署行为。

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const list = value => String(value ?? "").split(",").map(item => item.trim()).filter(Boolean);

export function deployConfig(env = process.env) {
  const publicMode = env.ZHISUDA_PUBLIC === "1";
  const host = env.ZHISUDA_HOST?.trim() || (publicMode ? "0.0.0.0" : "127.0.0.1");
  // 扩大监听范围必须同时承诺公开部署的来源校验、出网限制和限流，避免只改一个变量就暴露本机版。
  if (!LOOPBACK.has(host) && !publicMode) {
    throw new Error("ZHISUDA_HOST 设为非本机地址时，必须同时设置 ZHISUDA_PUBLIC=1。");
  }

  const origins = new Set();
  for (const item of list(env.ZHISUDA_ALLOWED_ORIGINS)) {
    let address;
    try {
      if (item.includes("*")) throw new Error("wildcard");
      address = new URL(item);
    } catch { throw new Error(`ZHISUDA_ALLOWED_ORIGINS 含无效来源：${item}。请填写完整的 https://域名，不接受通配符。`); }
    if (address.protocol !== "https:" || address.pathname !== "/" || address.search || address.hash || address.username || address.password) {
      throw new Error(`ZHISUDA_ALLOWED_ORIGINS 只接受不带路径的 https 来源：${item}`);
    }
    origins.add(address.origin);
  }
  // 未配置来源名单时不拒绝启动：创空间的域名要建好空间后才知道，改用同源校验（见 originAllowed）。

  const hopsText = env.ZHISUDA_TRUSTED_PROXY_HOPS;
  const proxyHops = hopsText === undefined || hopsText === "" ? 0 : Number(hopsText);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5) throw new Error("ZHISUDA_TRUSTED_PROXY_HOPS 需要是 0—5 的整数。");

  // 创空间可能把应用嵌在其他域名的页面里，此时 Strict 的 cookie 不会随请求发送，工作区会反复被重建。
  // 公开模式默认 None（必须配合 Secure）；写请求仍由上面的精确 Origin 白名单保护。可用 Lax 或 Strict 覆盖。
  const sameSite = env.ZHISUDA_COOKIE_SAMESITE?.trim() || (publicMode ? "None" : "Strict");
  if (!["None", "Lax", "Strict"].includes(sameSite)) throw new Error("ZHISUDA_COOKIE_SAMESITE 只能是 None、Lax 或 Strict。");

  return { publicMode, host, origins, proxyHops, sameSite };
}

// 公开模式下写请求的来源校验。
// - 配置了 ZHISUDA_ALLOWED_ORIGINS：只接受名单内的精确来源。
// - 未配置：只接受同源，即 Origin 等于 https://<访问域名>。访问域名取 Host，或代理转发的 X-Forwarded-Host。
//   其他网站的页面发来的请求，Origin 是它自己的域名，与目标 Host 对不上，因此仍被拒绝。
// 没有 Origin 头的请求不由本函数处理（与本机模式一致，由 JSON Content-Type 等条件限制）。
export function originAllowed(origin, req, config) {
  if (config.origins.size) return config.origins.has(origin);
  const forwarded = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
  return [req.headers.host, forwarded].filter(Boolean).some(host => origin === `https://${host}`);
}

// 只信任明确数量的反向代理：X-Forwarded-For 从右往左数，右侧由我们自己的代理追加。
// 不配置时只用 TCP 对端地址，伪造该请求头不会改变限流对象。
export function clientAddress(req, proxyHops = 0) {
  const direct = req.socket?.remoteAddress || "unknown";
  if (!proxyHops) return direct;
  const parts = String(req.headers["x-forwarded-for"] ?? "").split(",").map(item => item.trim()).filter(Boolean);
  return parts.length >= proxyHops ? parts[parts.length - proxyHops] : direct;
}

// 固定窗口计数；返回 true 表示本次放行。
export function createLimiter(max, windowMs, now = Date.now) {
  const rows = new Map();
  return key => {
    const time = now();
    let row = rows.get(key);
    if (!row || time >= row.reset) { row = { count: 0, reset: time + windowMs }; rows.set(key, row); }
    row.count++;
    if (rows.size > 5000) for (const [name, value] of rows) if (time >= value.reset) rows.delete(name);
    return row.count <= max;
  };
}
