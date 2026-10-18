import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { requestConfig } from "./llm.js";

export const localSaveSupported = process.platform === "win32";
const failure = () => Object.assign(new Error("无法使用 Windows 账户解锁 API 设置。请重新填写；未改动原有加密文件。"), { status: 503 });

// 密钥通过标准输入传递，不出现在命令行、环境变量、日志或临时明文文件中。
function protect(bytes, owner, decrypt = false) {
  if (!localSaveSupported) throw Object.assign(new Error("此系统暂不支持加密记住 API，请选择仅本次使用。"), { status: 400 });
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $parts=[Console]::In.ReadToEnd().Split('|'); $inputBytes=[Convert]::FromBase64String($parts[0]); $entropy=[Text.Encoding]::UTF8.GetBytes($parts[1]); $result=[Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($inputBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", tooLarge = false;
    const timer = setTimeout(() => { child.kill(); reject(failure()); }, 10_000);
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 100_000) { tooLarge = true; child.kill(); } });
    child.stderr.resume(); // Windows 的错误详情不转发给网页或日志。
    child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timer); reject(failure()); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code || tooLarge || !/^[A-Za-z0-9+/=]+$/.test(output)) reject(failure());
      else resolve(Buffer.from(output, "base64"));
    });
    child.stdin.end(bytes.toString("base64") + "|" + owner);
  });
}

export function createModelVault(directory, owner) {
  const filename = path.join(directory, "model-settings.enc.json");
  let queue = Promise.resolve();
  async function envelope() {
    try {
      const saved = JSON.parse(await readFile(filename, "utf8"));
      if (saved.version !== 1) throw failure();
      if (!saved.saved) return null;
      if (typeof saved.ciphertext !== "string" || !saved.metadata) throw failure();
      return saved;
    } catch (e) { if (e.code === "ENOENT") return null; throw failure(); }
  }
  function write(value) {
    const pending = queue.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(filename + ".tmp", JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
      await rename(filename + ".tmp", filename);
    });
    queue = pending.catch(() => {});
    return pending;
  }
  return {
    async status() { await queue; const saved = await envelope(); return saved?.metadata || null; },
    async read() {
      await queue;
      const saved = await envelope();
      if (!saved) throw Object.assign(new Error("尚未记住 API，请先填写模型设置。"), { status: 400 });
      try { return requestConfig(JSON.parse((await protect(Buffer.from(saved.ciphertext, "base64"), owner, true)).toString("utf8"))); }
      catch { throw failure(); }
    },
    async save(config) {
      const valid = requestConfig(config);
      const ciphertext = (await protect(Buffer.from(JSON.stringify(valid)), owner)).toString("base64");
      const metadata = { baseUrl: valid.baseUrl, model: valid.model, jsonMode: valid.jsonMode };
      await write({ version: 1, saved: true, metadata, ciphertext });
      return metadata;
    },
    // 只在用户主动点击“忘记”或明确选择不记住时覆盖本工作区的加密配置。
    forget() { return write({ version: 1, saved: false }); },
  };
}

export async function resolveModelConfig(input, vault) {
  if (input?.useSaved === true) {
    // 已保存密钥不能被网页参数改投到另一个地址。
    if (Object.keys(input).some(key => key !== "useSaved")) throw Object.assign(new Error("修改已保存的接口设置时，请重新填写密钥。"), { status: 400 });
    return vault.read();
  }
  return requestConfig(input);
}
