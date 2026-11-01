// Offline workspace-note retrieval regression. Usage: npm run eval:memory
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'locality-memory-eval-'));
try {
  const bundle = join(directory, 'eval.mjs');
  await build({ stdin: { contents: "export * from './src/chat/workspaceNotes.ts';", resolveDir: process.cwd() }, outfile: bundle, bundle: true, format: 'esm', platform: 'node' });
  const { searchWorkspaceNotes } = await import(pathToFileURL(bundle).href);
  const notes = [
    { id: '123e4567-e89b-42d3-a456-426614174001', name: 'Atlas export', contents: 'CSV export uses a pipe delimiter and excludes archived records.' },
    { id: '123e4567-e89b-42d3-a456-426614174002', name: 'Parser cache', contents: 'Cache key prefix is atlas_rev_7. saveRecord persists parser revisions.' }
  ].map(note => ({ ...note, version: 1, enabled: true, createdAt: 1, updatedAt: 1 }));
  for (const [query, expected] of [['Atlas CSV delimiter', notes[0].id], ['parser cache prefix', notes[1].id], ['saveRecord', notes[1].id], ['17 plus 25', undefined]]) {
    const result = searchWorkspaceNotes(query, notes, 1);
    const passed = result.memories[0]?.id === expected;
    console.log(JSON.stringify({ query, passed, result }));
    if (!passed) process.exitCode = 1;
  }
} finally { await rm(directory, { recursive: true, force: true }); }
