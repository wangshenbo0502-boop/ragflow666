import assert from 'node:assert/strict';

const clean = value => String(value || '').replaceAll(/\s+/gu, ' ').trim();
const attachmentMarker = value => /^附件\s*\d+$/u.test(clean(value));

export const standaloneTableNotes = [{
  source_id: 'S0033', table_id: 'S0033-T08', paragraph: 2317,
  heading: '道岔设备代表性产品检验检测原则原文注释（适用归属待核）',
  reason: '原注位于附件4审查表之后、附件5之前；正文讨论产品检验检测，不能仅据相邻位置断言适用于每个体系审查项目。单独保留，不推定其法定适用对象。',
}];

export function tableContext(source, table) {
  const end = source.blocks.findIndex(block => block.table_id === table.table_id);
  assert.ok(end >= 0, `${table.table_id}: native block absent`);
  let start = end - 1;
  while (start >= 0 && !attachmentMarker(source.blocks[start].text)) start--;
  assert.ok(start >= 0, `${table.table_id}: attachment boundary absent`);
  const before = source.blocks.slice(start, end);
  const firstTable = before.findIndex(block => block.type === 'table');
  const commonBlocks = before.slice(0, firstTable < 0 ? before.length : firstTable);
  const assessmentAttachment = commonBlocks.some(block => clean(block.text) === '审查说明：');
  const common = commonBlocks.filter(block => block.type === 'paragraph' && clean(block.text)
    && (assessmentAttachment || !/^\d+[．.、]/u.test(clean(block.text)))
    && !(assessmentAttachment && /^产品质量保证体系和安全管理制度项目及审查表(?:-\d+)?$/u.test(clean(block.text)))
    && !/^[一二三四五六七八九十]+[、．.]/u.test(clean(block.text)));
  let previousTable = end - 1;
  while (previousTable > start && source.blocks[previousTable].type !== 'table') previousTable--;
  const local = source.blocks.slice(previousTable + 1, end)
    .filter(block => block.type === 'paragraph' && clean(block.text));
  const following = [];
  for (let i = end + 1; i < source.blocks.length; i++) {
    const block = source.blocks[i];
    if (block.type === 'table' || attachmentMarker(block.text)) break;
    if (block.type !== 'paragraph' || !clean(block.text)) continue;
    if (!/^(注[：:]|备注[：:]|说明[：:]|签收人[：:])/u.test(clean(block.text))) break;
    if (standaloneTableNotes.some(note => note.source_id === source.source_id
      && note.table_id === table.table_id && note.paragraph === block.paragraph)) continue;
    following.push(block);
  }
  const unique = new Map([...common, ...local, ...following].map(block => [block.paragraph, block]));
  return [...unique.values()]
    .filter(block => !standaloneTableNotes.some(note =>
      note.source_id === source.source_id && note.paragraph === block.paragraph))
    .sort((a, b) => a.paragraph - b.paragraph).map(block => ({
    paragraph: block.paragraph, word_paragraph: block.word_paragraph,
    text: `${block.label ? `${block.label} ` : ''}${clean(block.text)}`,
    attachment_paragraph: source.blocks[start].paragraph,
    attribution: following.includes(block) ? 'immediately-following-note'
      : local.includes(block) ? 'local-preceding-context' : 'shared-attachment-context',
  }));
}
