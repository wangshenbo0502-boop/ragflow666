import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { load, root, save } from './run.mjs';

const run = (stage, ids) => execFileSync(process.execPath,
  [path.join(root, 'reconstruct-v3.mjs'), stage, ...ids.map(String)],
  { stdio: 'inherit', windowsHide: true });
const batches = [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12, 13, 14, 15],
  [16, 17, 18, 19, 20], [21, 22, 23, 24]];
for (const ids of batches) {
  run('build', ids);
  for (const phase of ['trial', 'formal']) {
    run(`upload-${phase}`, ids);
    let complete = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      run(`verify-${phase}`, ids);
      const register = await load('00-control/document-register.json');
      const ledger = await load('00-control/revision-v3-ledger.json');
      complete = ids.every(n => {
        const id = `DOC${String(n).padStart(4, '0')}`;
        const doc = register.find(d => d.doc_id === id);
        return ledger.documents.some(d => d.doc_id === id && d.sha256 === doc.sha256 &&
          d.phase === phase && d.status === 'full-body-verified');
      });
      if (complete) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!complete) throw Error(`Parse did not finish: ${phase}, ${ids}`);
  }
  const progress = await load('00-control/context-repair-progress.json').catch(e => {
    if (e.code !== 'ENOENT') throw e;
    return { batches: [] };
  });
  progress.batches.push({ ids, status: 'formal-full-body-verified', at: new Date().toISOString() });
  await save('00-control/context-repair-progress.json', progress);
  console.log(JSON.stringify({ batch_complete: ids }));
}
