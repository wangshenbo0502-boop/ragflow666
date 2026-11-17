import { api, load, originalDataset, rows, save } from './run.mjs';

const numbers = process.argv.slice(2).map(Number);
if (!numbers.length || numbers.length > 5) throw Error('One to five documents per batch');
const register = await load('00-control/document-register.json');
const ledger = await load('00-control/revision-v3-ledger.json');
const documents = rows(await api(`/datasets/${originalDataset}/documents?page=1&page_size=100`));
const log = await load('05-review/archive-status-v3.json').catch(e => {
  if (e.code !== 'ENOENT') throw e;
  return [];
});
for (const n of numbers) {
  const id = `DOC${String(n).padStart(4, '0')}`;
  const doc = register.find(d => d.doc_id === id);
  const verified = ledger.documents.find(d => d.doc_id === id && d.phase === 'formal' &&
    d.sha256 === doc?.sha256 && d.status === 'full-body-verified');
  if (!verified) throw Error(`${id}: no verified replacement`);
  for (const old of documents.filter(d => d.name.startsWith(`${id}_`) && d.id !== verified.document_id)) {
    if (old.status !== '0') {
      await api(`/datasets/${originalDataset}/documents/batch-update-status`, 'POST', {
        status: '0', doc_ids: [old.id],
      });
    }
    const current = rows(await api(`/datasets/${originalDataset}/documents?page=1&page_size=100`))
      .find(d => d.id === old.id);
    if (current?.status !== '0') throw Error(`${old.id}: not archived`);
    const chunks = [];
    for (let page = 1; ; page++) {
      const next = rows(await api(`/datasets/${originalDataset}/documents/${old.id}/chunks?page=${page}&page_size=100`));
      chunks.push(...next);
      if (next.length < 100) break;
    }
    if (chunks.some(c => c.available !== false)) throw Error(`${old.id}: historical chunks still available`);
    const item = { doc_id: id, document_id: old.id, name: old.name, retained: true,
      status: current.status, chunk_count: chunks.length, all_chunks_disabled: true,
      verified_replacement: verified.document_id, checked_at: new Date().toISOString() };
    const index = log.findIndex(x => x.document_id === old.id);
    if (index < 0) log.push(item); else log[index] = item;
    await save('05-review/archive-status-v3.json', log);
    console.log(JSON.stringify(item));
  }
}
