import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deployConfig, clientAddress, createLimiter } from "../lib/deploy.js";
import { isBlockedAddress, resolvePublicAddress, guardedFetch, pinnedLookup } from "../lib/egress.js";
import { chatJson, requestConfig } from "../lib/llm.js";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("部署配置：默认仅本机；非本机监听必须同时开启公开模式并列出精确来源", () => {
  const local = deployConfig({});
  assert.equal(local.publicMode, false); assert.equal(local.host, "127.0.0.1"); assert.equal(local.sameSite, "Strict");
  assert.throws(() => deployConfig({ ZHISUDA_HOST: "0.0.0.0" }), /ZHISUDA_PUBLIC=1/);
  // 未配置来源名单也能启动（创空间域名要建好空间后才知道），此时改用同源校验。
  const noList = deployConfig({ ZHISUDA_PUBLIC: "1" });
  assert.equal(noList.publicMode, true); assert.equal(noList.origins.size, 0);
  for (const bad of ["*", "https://*.example.com", "http://demo.example", "https://demo.example/app", "https://u:p@demo.example", "not a url", "https://demo.example?x=1"]) {
    assert.throws(() => deployConfig({ ZHISUDA_PUBLIC: "1", ZHISUDA_ALLOWED_ORIGINS: bad }), /ZHISUDA_ALLOWED_ORIGINS/, bad);
  }
  const publicConfig = deployConfig({ ZHISUDA_PUBLIC: "1", ZHISUDA_ALLOWED_ORIGINS: "https://a.example, https://b.example:8443/" });
  assert.equal(publicConfig.host, "0.0.0.0"); assert.equal(publicConfig.sameSite, "None");
  assert.deepEqual([...publicConfig.origins], ["https://a.example", "https://b.example:8443"]);
  assert.throws(() => deployConfig({ ZHISUDA_PUBLIC: "1", ZHISUDA_ALLOWED_ORIGINS: "https://a.example", ZHISUDA_COOKIE_SAMESITE: "Wild" }), /SAMESITE/);
  assert.throws(() => deployConfig({ ZHISUDA_TRUSTED_PROXY_HOPS: "9" }), /PROXY_HOPS/);
});

test("客户端地址：不配置代理时忽略 X-Forwarded-For；配置后只信任右侧代理追加的一项", () => {
  const req = { socket: { remoteAddress: "10.1.1.1" }, headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } };
  assert.equal(clientAddress(req, 0), "10.1.1.1");
  assert.equal(clientAddress(req, 1), "203.0.113.9"); // 访客自带的 6.6.6.6 不会被采信
  assert.equal(clientAddress({ socket: { remoteAddress: "10.1.1.1" }, headers: {} }, 1), "10.1.1.1");
});

test("限流：窗口内超限拒绝，窗口过后恢复，不同对象互不影响", () => {
  let now = 1000;
  const allow = createLimiter(2, 100, () => now);
  assert.deepEqual([allow("a"), allow("a"), allow("a"), allow("b")], [true, true, false, true]);
  now += 100;
  assert.equal(allow("a"), true);
});

test("出网限制：内网、本机、元数据、保留段和 IPv6 映射地址均被拦截", () => {
  for (const address of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "not-an-ip"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "47.93.0.1", "2606:4700:4700::1111"]) assert.equal(isBlockedAddress(address), false, address);
});

test("出网限制：域名的任一解析结果在内网即拒绝；固定连接已检查的地址", async () => {
  const lookup = rows => async () => rows;
  assert.equal((await resolvePublicAddress("api.example.com", lookup([{ address: "8.8.8.8", family: 4 }]))).address, "8.8.8.8");
  await assert.rejects(resolvePublicAddress("rebind.example", lookup([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }])), err => err.status === 400);
  await assert.rejects(resolvePublicAddress("internal.example", lookup([{ address: "127.0.0.1", family: 4 }])), err => err.status === 400);
  await assert.rejects(resolvePublicAddress("[::1]"), err => err.status === 400);
  await assert.rejects(resolvePublicAddress("169.254.169.254"), err => err.status === 400);
  await assert.rejects(resolvePublicAddress("missing.example", async () => { throw new Error("ENOTFOUND"); }), err => err.status === 502);
  const pinned = pinnedLookup("8.8.8.8", 4);
  assert.deepEqual(await new Promise(resolve => pinned("anything.example", { all: true }, (e, rows) => resolve(rows))), [{ address: "8.8.8.8", family: 4 }]);
  await assert.rejects(guardedFetch(new URL("http://api.example.com/v1/chat/completions"), { headers: {}, body: "{}", timeoutMs: 1000 }), err => err.status === 400);
});

test("公开模式的模型调用：先拒绝内网目标，不发出请求；本机调试地址在公开模式下不再允许", async t => {
  const previous = process.env.ZHISUDA_PUBLIC;
  process.env.ZHISUDA_PUBLIC = "1";
  t.after(() => { if (previous === undefined) delete process.env.ZHISUDA_PUBLIC; else process.env.ZHISUDA_PUBLIC = previous; });
  await assert.rejects(chatJson("s", "u", { baseUrl: "https://169.254.169.254/latest", model: "m", apiKey: "local-fixture-only" }), /公网 HTTPS/);
  await assert.rejects(chatJson("s", "u", { baseUrl: "https://10.0.0.8/v1", model: "m", apiKey: "local-fixture-only" }), /公网 HTTPS/);
  assert.throws(() => requestConfig({ baseUrl: "http://127.0.0.1:8000/v1", model: "m", apiKey: "local-fixture-only" }), err => err.status === 400);
  assert.equal(requestConfig({ baseUrl: "https://relay.example/v1", model: "m", apiKey: "local-fixture-only" }).mock, false);
});

function run(env, { expectStart = true } = {}) {
  const child = spawn(process.execPath, ["server.js"], { cwd: appDir, windowsHide: true, env: { ...process.env, PORT: "0", LLM_MOCK: "1", LLM_API_KEY: "", ...env } });
  let output = "";
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("测试服务启动超时")); }, 15000);
    child.stderr.on("data", data => { output += data; });
    child.stdout.on("data", data => { output += data; const match = output.match(/http:\/\/[\d.]+:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.once("exit", code => { clearTimeout(timer); if (expectStart) reject(new Error(`测试服务退出 ${code}: ${output}`)); else resolve({ code, output }); });
  });
  return { started, close: async () => { if (child.exitCode !== null) return; const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited; } };
}

test("启动保护：公开模式配置共享密钥，或本机模式监听外部地址时拒绝启动", async () => {
  for (const [env, pattern] of [
    [{ ZHISUDA_PUBLIC: "1", ZHISUDA_ALLOWED_ORIGINS: "https://demo.example", LLM_API_KEY: "local-fixture-shared" }, /共享密钥/],
    [{ ZHISUDA_HOST: "0.0.0.0" }, /ZHISUDA_PUBLIC=1/],
  ]) {
    const service = run(env, { expectStart: false });
    const { code, output } = await service.started;
    assert.equal(code, 1); assert.match(output, pattern);
    assert.ok(!output.includes("local-fixture-shared"));
  }
});

test("公开模式服务：精确来源、任意 Host 可访问、Secure cookie、健康检查与模型接口限流", async t => {
  const root = process.env.ZHISUDA_TEST_ROOT || path.resolve(appDir, "..", "..", "_verification");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "deploy-"));
  const service = run({ ZHISUDA_PUBLIC: "1", ZHISUDA_HOST: "127.0.0.1", ZHISUDA_ALLOWED_ORIGINS: "https://demo.example", ZHISUDA_DATA_DIR: directory, ZHISUDA_RATE_MODEL: "2" });
  t.after(() => service.close());
  const url = await service.started;
  const post = (route, origin, body = {}) => fetch(url + route, { method: "POST", headers: { "Content-Type": "application/json", Host: "studio.example", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });

  assert.equal((await fetch(url + "/healthz")).status, 200);
  const state = await fetch(url + "/api/state");
  assert.equal(state.status, 200);
  const cookie = state.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=None/);

  assert.equal((await post("/api/demo", "https://demo.example")).status, 200);
  for (const origin of ["https://evil.example", "http://demo.example", "https://demo.example.evil.example", "null"]) {
    const rejected = await post("/api/demo", origin);
    assert.equal(rejected.status, 403, origin);
    assert.match((await rejected.json()).error, /来源/);
  }
  // 模型相关接口按地址限流：设定 2 次，第 3 次被拒绝（此前的 400 也计入次数）。
  assert.equal((await post("/api/model/test", "https://demo.example")).status, 400);
  assert.equal((await post("/api/model/test", "https://demo.example")).status, 400);
  const limited = await post("/api/model/test", "https://demo.example");
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /频繁/);
});

// 用 node:http 发请求，确保 Host 头确实按给定值发送。
const rawPost = (url, headers, body = "{}") => new Promise((resolve, reject) => {
  const request = http.request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers } }, res => {
    let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode, text }));
  });
  request.on("error", reject); request.end(body);
});

test("公开模式未配置来源名单：只接受与访问域名同源的写请求，也识别代理转发的域名", async t => {
  const root = process.env.ZHISUDA_TEST_ROOT || path.resolve(appDir, "..", "..", "_verification");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "same-origin-"));
  const service = run({ ZHISUDA_PUBLIC: "1", ZHISUDA_HOST: "127.0.0.1", ZHISUDA_DATA_DIR: directory });
  t.after(() => service.close());
  const url = await service.started;
  assert.equal((await rawPost(url + "/api/demo", { Host: "studio.example", Origin: "https://studio.example" })).status, 200);
  assert.equal((await rawPost(url + "/api/demo", { Host: "internal.local", "X-Forwarded-Host": "studio.example", Origin: "https://studio.example" })).status, 200);
  for (const [host, origin] of [["studio.example", "https://evil.example"], ["studio.example", "http://studio.example"], ["studio.example", "https://studio.example.evil.example"], ["studio.example", "null"], ["internal.local", "https://studio.example"]]) {
    const rejected = await rawPost(url + "/api/demo", { Host: host, Origin: origin });
    assert.equal(rejected.status, 403, `${host} ← ${origin}`);
  }
});
