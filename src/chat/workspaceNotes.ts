import { DEFAULT_MEMORY_MAX_COUNT, MAX_MEMORY_COUNT } from "./memoryLimits.js";

export interface WorkspaceNote {
  version: 1;
  id: string;
  name: string;
  contents: string;
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
}
/** Historical inspection only; these snapshots never own or update a note. */
export interface MemorySelection { messageTs: number; memories: WorkspaceNote[] }
export interface MemoryListing { memories: WorkspaceNote[]; warnings: string[] }
export const validMemoryId = (id: unknown): id is string => typeof id === "string"
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);

export function validWorkspaceNote(value: unknown): value is WorkspaceNote {
  if (!value || typeof value !== "object") return false;
  const fields = new Set(["version", "id", "name", "contents", "createdAt", "updatedAt", "enabled"]);
  if (Object.keys(value).some(key => !fields.has(key))) return false;
  const m = value as WorkspaceNote;
  return m.version === 1 && validMemoryId(m.id)
    && typeof m.name === "string" && !!m.name.trim() && m.name.length <= 200
    && typeof m.contents === "string" && !!m.contents.trim() && m.contents.length <= 20_000
    && Number.isSafeInteger(m.createdAt) && m.createdAt >= 0 && m.createdAt <= 8640000000000000
    && Number.isSafeInteger(m.updatedAt) && m.updatedAt >= m.createdAt && m.updatedAt <= 8640000000000000
    && typeof m.enabled === "boolean";
}
export function noteMetadata(note: WorkspaceNote): { id: string; name: string; date: string } {
  return { id: note.id, name: note.name, date: new Date(note.updatedAt).toISOString() };
}
export function noteResult(note: WorkspaceNote): ReturnType<typeof noteMetadata> & { contents: string } {
  return { ...noteMetadata(note), contents: note.contents };
}
const STOP_WORDS = new Set("a an and are as at be been but by can chat could do for from had has have how i in is it its me my of on or our please that the their them there these they this to use was we what when where which with would you your".split(" "));
function terms(text: string): string[] {
  return (text.normalize("NFKC").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter(word => word.length > 1 && !STOP_WORDS.has(word));
}
/** The local BM25/title/phrase ranking used for search and automatic loading. */
export function rankWorkspaceNotes(query: string, notes: WorkspaceNote[]): WorkspaceNote[] {
  const candidates = notes.filter(note => note.enabled);
  const docs = candidates.map(note => terms(`${note.name} ${note.contents}`));
  const words = [...new Set(terms(query))];
  const avgLength = docs.reduce((n, doc) => n + doc.length, 0) / Math.max(1, docs.length) || 1;
  const frequencies = words.map(word => docs.filter(doc => doc.includes(word)).length);
  return candidates.map((note, i) => {
    const doc = docs[i];
    const score = words.reduce((sum, word, j) => {
      const tf = doc.filter(term => term === word).length;
      const idf = Math.log(1 + (docs.length - frequencies[j] + 0.5) / (frequencies[j] + 0.5));
      return sum + idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.length / avgLength));
    }, 0);
    const titleWords = terms(note.name);
    const titleBoost = words.filter(word => titleWords.includes(word)).length * 2;
    const phraseBoost = words.length > 1 && doc.join(" ").includes(terms(query).join(" ")) ? 2 : 0;
    return { note, score: score + titleBoost + phraseBoost };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt || a.note.id.localeCompare(b.note.id))
    .map(({ note }) => note);
}
export function searchWorkspaceNotes(query: string, notes: WorkspaceNote[], limit = DEFAULT_MEMORY_MAX_COUNT) {
  if (typeof query !== "string" || !query.trim()) throw new Error("search_memories requires a non-empty query.");
  const ranked = rankWorkspaceNotes(query, notes);
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_MEMORY_COUNT, Math.floor(limit))) : DEFAULT_MEMORY_MAX_COUNT;
  return { memories: ranked.slice(0, count).map(noteMetadata), total: ranked.length, truncated: ranked.length > count };
}
