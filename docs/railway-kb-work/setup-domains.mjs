import { api, load, save, root } from './run.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const domains = {
  GW: '工务与基础设施',
  XH: '通信信号与列车控制',
  GD: '牵引供电与电气设备',
  CL: '机车车辆与运用检修',
  YS: '运输组织与安全管理'
};
const templates = await api('/pipelines/paper');
const dsl = templates.dsl;
const chunker = Object.entries(dsl.components).find(([, c]) => c.obj.component_name === 'TitleChunker');
if (!chunker) throw Error('TitleChunker missing from paper pipeline');
const [chunkID, chunkComponent] = chunker;
const params = chunkComponent.obj.params;
params.method = 'hierarchy';
params.levels = [['^#[^#]', '^##[^#]', '^###[^#]']];
params.hierarchy = 3;
params.hierarchyGroup = '0';
params.hierarchyHierarchy = '3';
params.include_heading_content = false;
params.chunk_token_cap = 0;
dsl.graph.nodes.find(n => n.id === chunkID).data.form = structuredClone(params);

const agents = await api('/agents?page=1&page_size=100&canvas_category=dataflow_canvas');
const canvases = agents.canvas || [];
const datasets = await api('/datasets?page=1&page_size=100');
const models = (await api('/models/default')).models;
const embedding = models.find(m => m.model_type === 'embedding');
if (!embedding) throw Error('Default embedding model missing');

const docs = await load('00-control/document-register.json');
const sources = await load('00-control/selected-sources.json');
const pipelineTitle = '铁路知识库-条文层级试切';
let canvas = canvases.find(c => c.title === pipelineTitle);
if (!canvas) {
  canvas = await api('/agents', 'POST', {
    title: pipelineTitle,
    description: 'Markdown法规主文档按H1/H2/H3层级试切，保留父标题上下文。',
    canvas_category: 'dataflow_canvas',
    permission: 'me',
    dsl
  });
}
const published = await api(`/agents/${canvas.id}/publish`, 'POST', { dsl, alias: '条文层级试切' });

const setup = { pipeline_id: canvas.id, pipeline_version_id: published.id, method: 'hierarchy', hierarchy: 3, trials: {} };
for (const [domain, label] of Object.entries(domains)) {
  const doc = docs.find(d => d.domain === domain);
  if (!doc) {
    setup.trials[domain] = { status: 'no-reviewed-source' };
    continue;
  }
  const name = `铁路资料优化试验-${domain}-${label}`;
  let dataset = datasets.find(d => d.name === name);
  if (!dataset) {
    dataset = await api('/datasets', 'POST', {
      name,
      embedding_model: embedding.model_id,
      language: 'Chinese',
      permission: 'me',
      pipeline_id: canvas.id,
      pipeline_version_id: published.id,
      parse_type: 2
    });
    await api(`/datasets/${dataset.id}`, 'PUT', { description: `铁路知识库阶段试切，来源 ${doc.source_id}；${label}。` });
    datasets.push(dataset);
  }
  const source = sources.find(s => s.source_id === doc.source_id);
  const filename = path.basename(doc.master_path);
  const content = await readFile(path.join(root, doc.master_path));
  const existingDocs = await api(`/datasets/${dataset.id}/documents?page=1&page_size=100`);
  const existingRows = existingDocs.docs || existingDocs.documents || [];
  let row = existingRows.find(d => d.name === filename);
  if (!row) {
    const form = new FormData();
    form.append('file', new Blob([content], { type: 'text/markdown' }), filename);
    const uploaded = await api(`/datasets/${dataset.id}/documents`, 'POST', form);
    row = (Array.isArray(uploaded) ? uploaded : uploaded?.docs || uploaded?.documents || uploaded?.data || []).find?.(d => d.name === filename);
  }
  if (!row?.id) throw Error(`Could not identify uploaded trial document ${filename}: ${JSON.stringify(uploaded).slice(0, 500)}`);
  await api(`/datasets/${dataset.id}/documents/parse`, 'POST', { document_ids: [row.id] });
  setup.trials[domain] = { dataset_id: dataset.id, document_id: row.id, source_id: doc.source_id, title: doc.title, status: 'parse-requested' };
  await save('00-control/domain-pipeline.json', setup);
  console.log(domain, dataset.id, row.id, 'parse requested');
}
await save('00-control/domain-pipeline.json', setup);
