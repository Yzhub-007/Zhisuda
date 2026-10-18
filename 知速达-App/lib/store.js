import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

// 单进程 JSON 文件存储：串行修改 + 同目录临时文件替换，防止并发覆盖。
export function createStore(directory) {
  const filename = path.join(directory, "workspace.json");
  let queue = Promise.resolve();
  async function read() {
    try {
      const data = JSON.parse(await readFile(filename, "utf8"));
      if (data.schema !== 1 || !Array.isArray(data.drafts) || !Array.isArray(data.publications) || !Array.isArray(data.attempts)) throw new Error("Invalid store");
      return data;
    } catch (err) {
      if (err.code === "ENOENT") return { schema: 1, drafts: [], publications: [], attempts: [] };
      throw Object.assign(new Error("本地数据文件无法读取，请保留文件并检查备份；系统不会覆盖它。"), { status: 503 });
    }
  }
  return {
    read: async () => { await queue; return read(); },
    update(fn) {
      const result = queue.then(async () => {
        const data = await read();
        const value = await fn(data);
        await mkdir(directory, { recursive: true });
        const temporary = filename + ".tmp";
        await writeFile(temporary, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
        await rename(temporary, filename);
        return value;
      });
      queue = result.catch(() => {});
      return result;
    },
  };
}
