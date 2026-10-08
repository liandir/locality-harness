import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { ChatStorage } from "../src/chat/storage.js";
import { readChatHeader, writeChatFile } from "../src/chat/chatFile.js";
import { memoryListItem, transcriptRevision } from "../src/chat/memory.js";

vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  return { ...real, open: vi.fn(real.open), readFile: vi.fn(real.readFile), rename: vi.fn(real.rename) };
});

let root: string;
let workspace: string;
let storage: ChatStorage;
let watchers: { dispose(): void }[];
const indexPath = (ws = workspace): string => path.join(root, "indexes", createHash("sha256").update(ws).digest("hex") + ".json");
const chatPath = (id: string): string => path.join(root, id + ".json");

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "locality-index-"));
  workspace = path.join(root, "workspace");
  storage = new ChatStorage(workspace, root);
  watchers = [];
  vi.clearAllMocks();
});
afterEach(async () => {
  watchers.forEach(watcher => watcher.dispose());
  await fs.rm(root, { recursive: true, force: true });
});

describe("chat headers and workspace indexes", () => {
  it("writes bounded headers and preserves the complete transcript on opening", async () => {
    const rec = storage.newRecord("native");
    rec.title = 'Quotes " and a newline\n日本語';
    rec.messages = [{ role: "user", content: "content ".repeat(500_000), ts: 1 }];
    rec.contextMessages = [{ role: "system", content: "Summary", ts: 2 }];
    await storage.save(rec);
    const raw = await fs.readFile(chatPath(rec.id), "utf8");
    expect(raw.split("\n", 1)[0].length).toBeLessThan(1000);
    expect(JSON.parse(raw).messages).toEqual(rec.messages);
    expect((await readChatHeader(chatPath(rec.id)))?.header).toMatchObject({
      id: rec.id, title: rec.title, workspaceRoot: workspace, messageCount: 1, revision: transcriptRevision(rec)
    });
    await expect(storage.load(rec.id)).resolves.toMatchObject(rec);
  });

  it("shares cold index reads and never opens chat files when listing", async () => {
    const rec = storage.newRecord("native");
    rec.messages = [{ role: "assistant", content: "Large transcript".repeat(100_000), ts: 1 }];
    await storage.save(rec);
    const reopened = new ChatStorage(workspace, root);
    vi.clearAllMocks();
    const lists = await Promise.all([reopened.list(), reopened.list(), reopened.metadata()]);
    expect(lists.every(list => list[0].id === rec.id)).toBe(true);
    expect(vi.mocked(fs.open).mock.calls.map(call => String(call[0]))).toEqual([indexPath()]);
    expect(fs.readFile).not.toHaveBeenCalled();
    await reopened.list();
    expect(fs.open).toHaveBeenCalledOnce();
    await reopened.load(rec.id);
    expect(fs.readFile).toHaveBeenCalledWith(chatPath(rec.id), "utf-8");
  });

  it("migrates legacy files once and preserves fields while leaving other workspaces untouched", async () => {
    const rec = storage.newRecord("native");
    rec.messages = [{ role: "user", content: "Keep", ts: 1 }, { role: "assistant", content: "All data", ts: 2 }];
    const legacy = { ...rec, customField: { future: true }, contextMessages: [rec.messages[1]] };
    const other = { ...storage.newRecord("native"), workspaceRoot: path.join(root, "other") };
    const otherRaw = JSON.stringify(other);
    await fs.writeFile(chatPath(rec.id), JSON.stringify(legacy));
    await fs.writeFile(chatPath(other.id), otherRaw);
    expect(await storage.rebuildWorkspaceIndex()).toBe(1);
    const migrated = JSON.parse(await fs.readFile(chatPath(rec.id), "utf8"));
    expect(migrated).toMatchObject(legacy);
    expect(migrated.header.id).toBe(rec.id);
    expect(await fs.readFile(chatPath(other.id), "utf8")).toBe(otherRaw);
    vi.clearAllMocks();
    await new ChatStorage(workspace, root).list();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it.each(["missing", "malformed", "wrong-workspace", "wrong-version"])("rebuilds a %s index from headers even with a damaged transcript", async kind => {
    const rec = storage.newRecord("native");
    await storage.save(rec);
    const original = await fs.readFile(chatPath(rec.id), "utf8");
    const damaged = original.slice(0, original.indexOf("\n") + 1) + '"messages": [broken';
    await fs.writeFile(chatPath(rec.id), damaged);
    if (kind === "missing") await fs.unlink(indexPath());
    else if (kind === "malformed") await fs.writeFile(indexPath(), "{");
    else {
      const index = JSON.parse(await fs.readFile(indexPath(), "utf8"));
      if (kind === "wrong-workspace") index.workspaceRoot = "/another/workspace";
      else index.version = 99;
      await fs.writeFile(indexPath(), JSON.stringify(index));
    }
    vi.clearAllMocks();
    expect(await new ChatStorage(workspace, root).list()).toEqual([{ id: rec.id, title: rec.title, updatedAt: rec.updatedAt }]);
    expect(fs.readFile).not.toHaveBeenCalledWith(chatPath(rec.id), expect.anything());
    expect(await storage.load(rec.id)).toBeUndefined();
    expect(await fs.readFile(chatPath(rec.id), "utf8")).toBe(damaged);
  });

  it("updates titles, order, forks, memory metadata and deletions without losing workspace isolation", async () => {
    const rec = storage.newRecord("native");
    rec.messages = [{ role: "user", content: "Memory", ts: 1 }];
    await storage.save(rec);
    const otherStorage = new ChatStorage(path.join(root, "other"), root);
    const other = otherStorage.newRecord("native");
    await otherStorage.save(other);
    const foreignIndex = await fs.readFile(indexPath(other.workspaceRoot), "utf8");
    await storage.updateMemory(rec.id, current => ({
      text: "Useful summary", sourceRevision: transcriptRevision(current), generatedAt: 10, enabled: true, manual: false
    }));
    expect(memoryListItem((await storage.metadata())[0])).toMatchObject({ text: "Useful summary", usable: true, status: "ready" });
    const fork = await storage.fork((await storage.load(rec.id))!);
    rec.title = "Renamed";
    await storage.save(rec);
    const chats = await storage.list();
    expect(chats.find(chat => chat.id === rec.id)?.title).toBe("Renamed");
    expect(chats.map(chat => chat.id)).toContain(fork.id);
    expect(chats.map(chat => chat.updatedAt)).toEqual(chats.map(chat => chat.updatedAt).sort((a, b) => b - a));
    await storage.deleteAll();
    expect(await storage.list()).toEqual([]);
    expect(await fs.readFile(indexPath(other.workspaceRoot), "utf8")).toBe(foreignIndex);
    expect(await otherStorage.load(other.id)).toBeDefined();
  });

  it("repairs stale references and discovers external additions from headers", async () => {
    const removed = storage.newRecord("native"), changed = storage.newRecord("native"), added = storage.newRecord("native");
    await storage.save(removed); await storage.save(changed);
    await fs.unlink(chatPath(removed.id));
    changed.title = "External change";
    await writeChatFile(chatPath(changed.id), changed);
    await writeChatFile(chatPath(added.id), added);
    await storage.metadata(true);
    expect(await storage.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: changed.id, title: "External change" }), expect.objectContaining({ id: added.id })
    ]));
    expect(await storage.list()).toHaveLength(2);
  });

  it("keeps chat data recoverable when replacing the index fails after a save", async () => {
    const rec = storage.newRecord("native");
    await storage.save(rec);
    const rename = vi.mocked(fs.rename).getMockImplementation()!;
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => rename(from, to));
    vi.mocked(fs.rename).mockImplementationOnce(async () => { throw new Error("disk failure"); });
    rec.title = "Saved despite index failure";
    await expect(storage.save(rec)).rejects.toThrow("disk failure");
    await expect(storage.load(rec.id)).resolves.toMatchObject({ title: rec.title });
    expect(await storage.list()).toEqual([expect.objectContaining({ id: rec.id, title: rec.title })]);
  });

  it("never overwrites malformed or unsupported headers during repair", async () => {
    const rec = storage.newRecord("native");
    await storage.save(rec);
    const original = await fs.readFile(chatPath(rec.id), "utf8");
    const unsupported = original.replace('"version":1', '"version":99');
    await fs.writeFile(chatPath(rec.id), unsupported);
    expect(await storage.rebuildWorkspaceIndex()).toBe(0);
    expect(await fs.readFile(chatPath(rec.id), "utf8")).toBe(unsupported);
  });

  it("recovers an abandoned workspace lock", async () => {
    const rec = storage.newRecord("native");
    await storage.save(rec);
    await fs.writeFile(indexPath() + ".lock", JSON.stringify({ pid: 2147483647, host: os.hostname(), token: "old" }));
    expect(await storage.rebuildWorkspaceIndex()).toBe(1);
    await expect(fs.stat(indexPath() + ".lock")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refreshes an existing view after external changes and repairs a stale startup index", async () => {
    const rec = storage.newRecord("native");
    await storage.save(rec);
    rec.title = "Changed while closed";
    await writeChatFile(chatPath(rec.id), rec);
    const changed = vi.fn();
    watchers.push(storage.watch(changed));
    await vi.waitFor(async () => expect((await storage.list())[0].title).toBe(rec.title));
    const added = storage.newRecord("native");
    await writeChatFile(chatPath(added.id), added);
    await vi.waitFor(async () => expect(await storage.list()).toHaveLength(2));
    expect(changed).toHaveBeenCalled();
  });

  it("merges concurrent writers and rebuilds across separate extension-host processes", async () => {
    const bundle = path.join(root, "storage.mjs");
    await build({ entryPoints: ["src/chat/storage.ts"], bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent" });
    const script = `import {ChatStorage} from ${JSON.stringify(new URL("file://" + bundle).href)};
      const s=new ChatStorage(process.argv[1],process.argv[2]);
      for(let i=0;i<6;i++){const r=s.newRecord('native');await s.save(r);r.title='Updated';await s.save(r);if(i===2)await s.rebuildWorkspaceIndex();}`;
    await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, workspace, root])));
    const chats = await storage.list();
    expect(chats).toHaveLength(18);
    expect(chats.every(chat => chat.title === "Updated")).toBe(true);
    expect(new Set(chats.map(chat => chat.id)).size).toBe(18);
  }, 20_000);
});
