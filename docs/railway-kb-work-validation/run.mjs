import { execFileSync } from 'node:child_process';
import { createHmac, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = fileURLToPath(new URL('./', import.meta.url));
export const root = process.env.RAILWAY_KB_ROOT
  ? path.resolve(process.env.RAILWAY_KB_ROOT) + path.sep
  : scriptRoot;
export const repo = path.resolve(scriptRoot, '../..');
const require = createRequire(path.join(repo, 'web/package.json'));
const yaml = require('js-yaml');
export const parseHTML = require('parse5').parse;
export const tenant = 'f8123cce6b744a88bde9137a8fab0ed1';
export const originalDataset = '66ff4d9d5ff748af8e83080bd7482f04';
export const domains = {
  GW: '铁路工务与基础设施', XH: '铁路通信信号与列车控制',
  GD: '铁路牵引供电与电气设备', CL: '铁路机车车辆与运用检修',
  YS: '铁路运输组织与安全管理',
};
const docker = (...args) => execFileSync('docker', args, {
  encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
}).trim();
export const sql = query => docker('exec', 'docker-mysql-1', 'sh', '-c',
  'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot --default-character-set=utf8mb4 --raw -N rag_flow -e "$1"', 'sh', query);
let authorization;
function auth() {
  if (authorization) return authorization;
  const access = JSON.parse(sql(`SELECT JSON_OBJECT('token',access_token) FROM user WHERE id='${tenant}'`)).token;
  if (!access || access.startsWith('INVALID_')) throw Error('Existing target-space session unavailable');
  const config = yaml.load(docker('exec', 'docker-ragflow-cpu-1', 'cat', '/ragflow/conf/service_conf.yaml'));
  const kv = config.kvrocks || config.redis;
  const secret = docker('exec', '-e', `REDISCLI_AUTH=${kv.password}`, 'docker-kvrocks-1',
    'redis-cli', '-n', String(kv.db || 0), '--raw', 'GET', 'ragflow:system:secret_key');
  if (!secret) throw Error('Existing local session signer unavailable');
  const payload = ['v2', Buffer.from(access).toString('base64url'),
    Buffer.from(tenant).toString('base64url'), Math.floor(Date.now() / 1000)].join('.');
  authorization = payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
  return authorization;
}
export async function api(route, method = 'GET', body, raw = false) {
  const headers = { Authorization: auth() };
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch('http://127.0.0.1:9380/api/v1' + route, {
    method, headers,
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  if (raw) {
    if (!response.ok) throw Error(`${method} ${route}: HTTP ${response.status}`);
    return response;
  }
  const result = await response.json();
  if (!response.ok || result.code !== 0) throw Error(`${method} ${route}: ${response.status} ${result.code} ${result.message}`);
  return result.data;
}
export const rows = data => Array.isArray(data) ? data : data.docs || data.documents || data.items || data.chunks || [];
export const hash = text => createHash('sha256').update(text).digest('hex');
export async function save(relative, data) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, Buffer.isBuffer(data) || data instanceof Uint8Array ? data : typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', 'utf8');
}
export const load = async relative => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
export function table(headers, records) {
  const escape = v => String(v ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
  return [headers, headers.map(() => '---'), ...records].map(r => '| ' + r.map(escape).join(' | ') + ' |').join('\n') + '\n';
}
async function inventory() {
  const datasets = await api('/datasets?page=1&page_size=100');
  await save('00-control/inventory-datasets.json', datasets);
  const dataset = await api('/datasets/' + originalDataset);
  const documents = rows(await api(`/datasets/${originalDataset}/documents?page=1&page_size=100`));
  await save('00-control/inventory-original-documents.json', { dataset, documents });
  for (const [index, doc] of documents.entries()) {
    const response = await api(`/datasets/${originalDataset}/documents/${doc.id}`, 'GET', undefined, true);
    const bytes = Buffer.from(await response.arrayBuffer());
    const name = `${String(index + 1).padStart(2, '0')}_${path.basename(doc.name)}`;
    await mkdir(path.join(root, '01-originals/baseline'), { recursive: true });
    await writeFile(path.join(root, '01-originals/baseline', name), bytes);
    doc.original_path = '01-originals/baseline/' + name;
    doc.content_sha256 = hash(bytes);
    console.log(JSON.stringify({ id: doc.id, name: doc.name, bytes: bytes.length, path: doc.original_path }));
  }
  await save('00-control/inventory-original-documents.json', { dataset, documents });
  console.log('DATASET', JSON.stringify(dataset));
  console.log('DEFAULT_MODELS', JSON.stringify(await api('/models/default')));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'inventory') await inventory();
}
