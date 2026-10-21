import { buildLineDiff, lineDiffStats } from "./diffPreview.js";

export interface FileChangeSummary {
  path: string;
  added: number;
  removed: number;
  diffPreview: string;
}

export interface TrackedFileWrite {
  path: string;
  previous: string;
  next: string;
  createsNewFile?: boolean;
  undoAvailable?: boolean;
  diffPreview?: string;
}

export function rememberFileWrite(
  changes: Map<string, TrackedFileWrite>,
  args: { key: string; path: string; previous: string; next: string; diffPreview?: string }
): void {
  const existing = changes.get(args.key);
  if (existing) {
    existing.path = args.path;
    existing.next = args.next;
    existing.diffPreview = existing.previous === args.previous ? args.diffPreview : undefined;
    return;
  }
  changes.set(args.key, {
    path: args.path,
    previous: args.previous,
    next: args.next,
    diffPreview: args.diffPreview
  });
}

export function summarizeFileChanges(changes: Iterable<TrackedFileWrite>): FileChangeSummary[] {
  const out: FileChangeSummary[] = [];
  for (const change of changes) {
    if (change.previous === change.next) continue;
    const diff = change.diffPreview === undefined
      ? buildLineDiff(change.previous, change.next)
      : { diffPreview: change.diffPreview, ...lineDiffStats(change.previous, change.next) };
    if (diff.added === 0 && diff.removed === 0) continue;
    out.push({ path: change.path, ...diff });
  }
  return out;
}
