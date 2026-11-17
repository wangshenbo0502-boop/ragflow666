import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { hash, root, save } from './run.mjs';

const targets = ['00-control', '04-chunks/expected', '04-chunks/actual'];
const records = [];
for (const directory of targets) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:json|md)$/u.test(entry.name)) continue;
    const relative = `${directory}/${entry.name}`;
    const bytes = await readFile(path.join(root, relative));
    const sha256 = hash(bytes);
    const snapshot = `05-review/history/pre-context-repair/${relative}/${sha256}`;
    await save(snapshot, bytes);
    records.push({ relative, sha256, snapshot });
  }
}
await save('05-review/history/pre-context-repair/manifest.json', {
  created_at: new Date().toISOString(), records,
});
console.log(JSON.stringify({ snapshotted: records.length }));
