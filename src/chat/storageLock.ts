import * as fs from "node:fs/promises";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

const pending = new Map<string, Promise<unknown>>();

/** Serialize workspace mutations in this host and across VS Code windows. */
export function withStorageLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const result = (pending.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const owner = JSON.stringify({ pid: process.pid, host: os.hostname(), token: randomUUID() });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const handle = await fs.open(file, "wx", 0o600);
        try { await handle.writeFile(owner); }
        catch (error) { await fs.unlink(file).catch(() => undefined); throw error; }
        finally { await handle.close(); }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await removeAbandonedLock(file);
        if (Date.now() >= deadline) throw new Error("Another window is still updating the chat index. Try again shortly.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await task(); }
    finally {
      if (await fs.readFile(file, "utf8").catch(() => "") === owner) await fs.unlink(file).catch(() => undefined);
    }
  });
  pending.set(file, result);
  void result.finally(() => { if (pending.get(file) === result) pending.delete(file); }).catch(() => undefined);
  return result;
}

async function removeAbandonedLock(file: string): Promise<void> {
  try {
    const original = await fs.readFile(file, "utf8");
    let abandoned = false;
    try {
      const owner = JSON.parse(original) as { pid?: number; host?: string };
      if (owner.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid! > 0) {
        try { process.kill(owner.pid!, 0); }
        catch (error) { abandoned = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }
    } catch {
      // A crash between exclusive creation and writing the owner leaves an empty lock.
      abandoned = Date.now() - (await fs.stat(file)).mtimeMs > 30_000;
    }
    if (abandoned && await fs.readFile(file, "utf8") === original) await fs.unlink(file);
  } catch { /* Another window released or recovered it. */ }
}
