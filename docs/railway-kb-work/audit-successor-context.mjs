import assert from 'node:assert/strict';
import { load, save } from './run.mjs';
import { standaloneTableNotes, tableContext } from './successor-table-context.mjs';

const clean = value => String(value || '').replaceAll(/\s+/gu, ' ').trim();
const records = [];
for (const sourceID of ['S0033', 'S0034', 'S0035', 'S0036']) {
  const source = await load(`05-review/successor-structure/${sourceID}-native-tables-v2.json`);
  for (const table of source.tables) {
    const context = tableContext(source, table);
    assert.ok(context.length, `${table.table_id}: no source context`);
    const index = source.blocks.findIndex(block => block.table_id === table.table_id);
    let end = index + 1;
    while (end < source.blocks.length && !/^附件\s*\d+$/u.test(clean(source.blocks[end].text))) end++;
    const attachment = context[0].attachment_paragraph;
    assert.equal(new Set(context.map(block => block.paragraph)).size, context.length);
    for (const block of context) {
      const original = source.blocks.find(item => item.type === 'paragraph' && item.paragraph === block.paragraph);
      assert.ok(original, `${table.table_id}: unknown source paragraph`);
      assert.equal(clean(`${original.label ? `${original.label} ` : ''}${clean(original.text)}`), block.text);
      assert.ok(block.paragraph >= attachment, `${table.table_id}: crossed previous attachment`);
      if (end < source.blocks.length) assert.ok(block.paragraph < source.blocks[end].paragraph,
        `${table.table_id}: crossed following attachment`);
    }
    const paragraphIDs = context.map(block => block.paragraph);
    if (sourceID === 'S0033') assert.ok(!paragraphIDs.includes(2317), `${table.table_id}: ambiguous note must stay separate`);
    if (table.table_id === 'S0034-T04') assert.ok(paragraphIDs.includes(1199));
    if (table.table_id === 'S0034-T02') {
      assert.ok(!paragraphIDs.includes(1199));
      assert.ok(paragraphIDs.includes(342));
    }
    if (['S0034-T05', 'S0034-T06'].includes(table.table_id)) {
      for (const paragraph of [1205, 1207, 1208, 1209, 1210]) assert.ok(paragraphIDs.includes(paragraph));
      assert.ok(!context.some(block => /^产品质量保证体系和安全管理制度项目及审查表-[12]$/u.test(block.text)
        && block.paragraph !== (table.table_id === 'S0034-T05' ? 1212 : 2036)));
    }
    records.push({ source_id: sourceID, table_id: table.table_id,
      attachment_paragraph: attachment, context, status: 'source-location assertions passed; semantic/visual acceptance not implied' });
  }
}
assert.equal(records.length, 42);
const report = { checked_at: new Date().toISOString(), table_count: records.length,
  source_locations_verified: true, cross_attachment_context_count: 0,
  standalone_notes_pending_attribution: standaloneTableNotes, tables: records,
  limitation: 'Native source-paragraph attribution audit only; not visual review, legal validity, trial parsing or retrieval acceptance.' };
await save('05-review/successor-table-context-audit.json', report);
console.log(JSON.stringify({ table_count: records.length, standalone_notes_pending_attribution: standaloneTableNotes,
  output: '05-review/successor-table-context-audit.json' }, null, 2));
