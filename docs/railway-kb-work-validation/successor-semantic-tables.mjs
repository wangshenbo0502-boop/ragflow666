import assert from 'node:assert/strict';

const clean = value => String(value || '').replaceAll(/\s+/gu, ' ').trim();
const escape = value => clean(value).replaceAll('|', '\\|');
const sectionTitle = /^[一二三四五六七八九十]+[、．.]/u;

export function semanticTablePoints(parent, table, document, context) {
  const cells = new Map(table.rows.flatMap(row => row.cells).map(cell => [cell.cell_id, cell]));
  const origin = cell => {
    const source = cells.get(cell.vertical_merge === 'continue' ? cell.origin_cell_id : cell.cell_id);
    assert.ok(source, `${cell.cell_id}: missing merge origin`);
    return source;
  };
  const at = (row, column) => row.cells.find(cell => cell.column === column);
  const value = (row, column) => {
    const cell = at(row, column);
    return cell ? clean(cell.text) || (cell.vertical_merge === 'continue' ? clean(origin(cell).text) : '') : '';
  };
  const header = table.rows.slice(0, 4).flatMap(row => row.cells.map(cell => clean(cell.text))).join(' ');
  const compactHeader = header.replaceAll(/\s+/gu, '');
  const kind = /审查记录/u.test(compactHeader) ? 'assessment'
    : /专业类别|技术人员专业/u.test(compactHeader) ? 'personnel'
      : /执行标准/u.test(compactHeader) ? 'catalog'
        : /工艺类别/u.test(compactHeader) ? 'equipment' : 'form';
  if (kind === 'form') return null;
  const groups = [];
  let headers = [];
  let section = '';
  let group;
  let currentAssessmentKey = '';
  let currentAssessmentLabel = '';
  const sectionRows = new Map();
  const notes = [];
  const push = (label, row, key) => {
    if (!group || group.key !== key) {
      group = { key, label, rows: [], headers: [...headers], section };
      groups.push(group);
    }
    group.rows.push(row);
  };
  for (const row of table.rows) {
    const id = value(row, 1);
    if (kind === 'equipment' && sectionTitle.test(id)) {
      section = id;
      sectionRows.set(section, row);
      headers = [];
      group = undefined;
      continue;
    }
    if (kind === 'assessment' && /^[一二三四五六七八九十]+$/u.test(id)) {
      section = `${id} ${value(row, 2)}`;
      sectionRows.set(section, row);
      group = undefined;
      currentAssessmentKey = '';
      currentAssessmentLabel = '';
      continue;
    }
    if (id === '序号' || (!/^\d/u.test(id) && !group && kind !== 'equipment')) {
      if (group) headers = [];
      group = undefined;
      headers.push(row);
      continue;
    }
    if (/^(备注|说明|注)[：:]/u.test(id)) {
      notes.push({ section, row });
      continue;
    }
    if (kind === 'catalog') {
      const column = header.includes('产品编号') ? 3 : 2;
      const cell = at(row, column);
      const product = value(row, column);
      if (cell && clean(cell.text) && cell.vertical_merge !== 'continue') group = undefined;
      assert.ok(product || group, `${table.table_id} row ${row.row}: product missing`);
      push(product || group.label, row, group?.key || `${table.table_id}:${row.row}`);
    } else if (kind === 'personnel') {
      const category = value(row, 2);
      const specialty = value(row, 3);
      const key = `${category} / ${specialty}`;
      assert.ok(category && specialty, `${table.table_id} row ${row.row}: personnel category or specialty missing`);
      push(key, row, key);
    } else if (kind === 'assessment') {
      const project = value(row, 2);
      const content = value(row, 3);
      const itemNumber = content.match(/^(?:▲\s*)?(\d+(?:[.．]\d+)*)[.．、]\s*/u)?.[1] || '';
      if (/^\d+\.\d+/u.test(id)) {
        currentAssessmentKey = `${section}:${id}`;
        currentAssessmentLabel = `${id} ${project}`.trim();
      }
      assert.ok(currentAssessmentKey, `${table.table_id} row ${row.row}: assessment item has no owning project`);
      if (itemNumber) {
        push(`${currentAssessmentLabel} / ${content.startsWith('▲') ? '▲' : ''}检查项${itemNumber}`,
          row, `${currentAssessmentKey}:item:${itemNumber}:${row.row}`);
      } else {
        assert.ok(group?.key.startsWith(`${currentAssessmentKey}:item:`),
          `${table.table_id} row ${row.row}: unnumbered continuation has no owning assessment item`);
        push(group.label, row, group.key);
      }
    } else {
      if (id === '序号' || !/^\d+$/u.test(id)) {
        if (row.cells.some(cell => clean(cell.text))) {
          if (row.cells.length === 1) notes.push({ section, row });
          else headers.push(row);
        }
        continue;
      }
      const product = table.table_id === 'S0036-T02' ? value(row, 3) : '';
      const process = value(row, 2);
      const equipment = table.table_id === 'S0036-T02' ? value(row, 4) : value(row, 3);
      const label = [product, process, equipment].filter(Boolean).join(' / ');
      push(label, row, `${label}:${row.row}`);
    }
  }
  const dataRows = groups.flatMap(item => item.rows.map(row => row.row));
  assert.equal(new Set(dataRows).size, dataRows.length, `${table.table_id}: duplicate data row`);
  return groups.map(item => {
    const applicableNotes = notes.filter(note => note.section === item.section).map(note => note.row);
    const sectionRow = sectionRows.get(item.section);
    const selected = [...new Map([...item.headers, ...item.rows, ...applicableNotes, ...(sectionRow ? [sectionRow] : [])]
      .map(row => [row.row, row])).values()]
      .sort((a, b) => a.row - b.row);
    const selectedCells = new Set(selected.flatMap(row => row.cells.map(cell => cell.cell_id)));
    const external = new Map();
    const lines = selected.map(row => {
      const result = Array(table.grid_columns).fill('〔横向合并覆盖，详见原格〕');
      for (const cell of row.cells) {
        const source = origin(cell);
        if (source.cell_id !== cell.cell_id && !selectedCells.has(source.cell_id)) external.set(source.cell_id, source);
        const content = clean(cell.text) || (cell.vertical_merge === 'continue'
          ? `${kind === 'equipment' ? `${clean(source.text) || '〔原表空白〕'} ` : ''}〔纵向合并自${source.cell_id}〕`
          : '〔原表空白〕');
        result[cell.column - 1] = escape(content);
      }
      return `| ${row.row} | ${result.join(' | ')} |`;
    });
    const rowIDs = item.rows.map(row => row.row);
    const id = `${document.doc_id}-${table.table_id}-G${String(rowIDs[0]).padStart(3, '0')}-${String(rowIDs.at(-1)).padStart(3, '0')}`;
    const localTitle = kind === 'assessment' ? clean(parent.heading)
      : clean(context.filter(block => /^\d+[．.、]|^[一二三四五六七八九十]+[、．.]/u.test(clean(block.text))).at(-1)?.text);
    const heading = [localTitle, item.section, item.label].map(clean).filter((v, i, all) => v && all.indexOf(v) === i).join(' / ');
    const text = [
      `文档：${document.title}（${document.doc_id}）；版本：${document.version}；来源：${document.source_id}。`,
      `表格：${table.table_id}；完整语义分组：${heading}；数据原行：${rowIDs.join('、')}。`,
      ...context.map(block => `${document.source_id}原文段落${block.paragraph}：${block.text}`),
      '表头、速度档、人员资格、备注及原行位置保留；空白不推定为零或不适用；横向覆盖与纵向续格均为原生合并关系。',
      ...[...external.values()].map(cell => `跨分组合并起点${cell.cell_id}原文：${clean(cell.text) || '〔原表空白〕'}`),
      `| 原行 | ${Array.from({ length: table.grid_columns }, (_, i) => `原列${i + 1}`).join(' | ')} |`,
      `| --- | ${Array(table.grid_columns).fill('---').join(' | ')} |`,
      ...lines,
      `来源定位：${table.table_id}；数据第${rowIDs[0]}-${rowIDs.at(-1)}行；父表知识点：${parent.knowledge_point_id}。`,
    ].join('\n');
    return { ...parent, knowledge_point_id: id, parent_knowledge_point_id: parent.knowledge_point_id,
      kind, heading, heading_path: [document.title, table.table_id, heading], text,
      native_row_ids: rowIDs, shared_header_row_ids: item.headers.map(row => row.row),
      shared_note_row_ids: applicableNotes.map(row => row.row), common_context: context,
      source_location: `${table.table_id}，原生数据行${rowIDs[0]}-${rowIDs.at(-1)}`,
      native_cell_mapping: selected.flatMap(row => row.cells.map(cell => ({ ...cell }))),
      external_merge_origins: [...external.values()],
      length_review: '按原产品、工艺阶段、人员类别或审查项目分组；不按长度拆分完整项目',
      review_status: '语义分组候选；待视觉/效力复核和真实试切；未正式导入' };
  });
}
