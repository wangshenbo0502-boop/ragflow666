const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const webRequire = createRequire(path.join(root, 'web/package.json'));
const { Marked, Renderer } = webRequire('marked');
const source = path.join(root, 'docs/railmind-user-manual.zh-CN.md');
const output = source.replace(/\.md$/, '.html');
const escape = (value) => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const chapters = [];
const ids = new Set();
let chapter;
let subsection = 0;
const renderer = new Renderer();

renderer.heading = function (token) {
  if (token.depth === 1) return '';
  const number = token.text.match(/^(\d+(?:\.\d+)*)(?:\.?\s)/)?.[1];
  const id = token.depth === 2
    ? `chapter-${number}`
    : `section-${number?.includes('.') ? number.replaceAll('.', '-') : `${chapter.number}-${++subsection}`}`;
  if (ids.has(id)) throw new Error(`Duplicate heading ID: ${id}`);
  ids.add(id);
  const entry = { id, title: token.text };
  if (token.depth === 2) {
    if (!number) throw new Error(`Chapter number missing: ${token.text}`);
    chapter = { ...entry, number, children: [] };
    chapters.push(chapter);
    subsection = 0;
  } else {
    chapter.children.push(entry);
  }
  return `<h${token.depth} id="${id}" tabindex="-1">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
};
const baseTable = renderer.table;
renderer.table = function (token) {
  return `<div class="table-wrap" role="region" aria-label="说明表格，可横向滚动" tabindex="0">${baseTable.call(this, token)}</div>\n`;
};
const content = new Marked({ renderer, gfm: true }).parse(fs.readFileSync(source, 'utf8'));
const toc = chapters.map((item) => `<details class="chapter" data-id="${item.id}"${['0', '5'].includes(item.number) ? ' open' : ''}>
<summary><a href="#${item.id}">${escape(item.title)}</a></summary>
<ul>${item.children.map((child) => `<li><a href="#${child.id}">${escape(child.title)}</a></li>`).join('\n')}</ul>
</details>`).join('\n');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="description" content="轨知 RailMind 功能与子功能详解，包含操作步骤、参数解释、示例和常见问题。">
<title>轨知 RailMind 详细用户使用说明</title>
<style>
:root{color-scheme:light;--ink:#243437;--muted:#54656c;--line:#d9e2e3;--green:#13675c;--soft:#edf5f2}
*{box-sizing:border-box;letter-spacing:0}
html{scroll-padding-top:20px}
body{margin:0;background:#f6f8f8;color:var(--ink);font:16px/1.85 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
a{color:var(--green);text-underline-offset:3px;overflow-wrap:anywhere}
a:hover{text-decoration-thickness:2px}
button,input{font:inherit}
button{cursor:pointer}
:focus-visible{outline:3px solid #bc6625;outline-offset:3px}
.skip{position:absolute;left:16px;top:-100px;padding:8px 16px;background:white}
.skip:focus{top:12px}
.top{background:#164d43;color:#fff;border-bottom:4px solid #acc7bc}
.top-inner{max-width:1400px;margin:auto;padding:28px 28px 24px}
.top h1{font-size:30px;line-height:1.45;margin:0 0 8px}
.top p{font-size:14px;color:#e0ede7;margin:0}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px;align-items:center}
.toolbar a,.toolbar button{font-size:14px;color:#fff;background:transparent;border:1px solid #86a89c;border-radius:4px;padding:6px 12px;text-decoration:none}
.layout{display:grid;grid-template-columns:300px minmax(0,1fr);gap:32px;max-width:1400px;margin:auto;padding:28px 28px 64px}
.sidebar{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto;scrollbar-gutter:stable;padding-right:14px}
.sidebar h2{font-size:17px;border:0;padding:0;margin:0 0 10px}
.search-label{display:block;font-size:14px;font-weight:600;margin-bottom:6px}
.search-row{display:flex;gap:6px}
#search{width:100%;min-width:0;background:#fff;border:1px solid #9fb2b5;border-radius:4px;padding:8px 10px;font-size:14px}
#clear{flex:none;border:1px solid var(--line);border-radius:4px;background:#fff;color:var(--muted);padding:4px 8px;font-size:13px}
#search-status{font-size:12px;color:var(--muted);min-height:24px;margin:7px 0 12px}
.chapter{border-top:1px solid var(--line);padding:9px 0;font-size:13px;line-height:1.65}
.chapter summary{cursor:pointer}
.chapter summary a{color:var(--ink);font-weight:600;text-decoration:none}
.chapter ul{list-style:none;padding:0 0 0 16px;margin:6px 0}
.chapter li{padding:0;margin:6px 0}
.chapter li a{color:var(--muted);text-decoration:none}
.chapter a:hover{text-decoration:underline;color:var(--green)}
[hidden]{display:none!important}
.document{min-width:0;background:white;padding:8px 32px 32px;border-left:1px solid var(--line)}
.document>p:first-child{margin-top:0}
.document h2{font-size:24px;line-height:1.55;margin:44px 0 18px;padding-top:22px;border-top:2px solid var(--line)}
.document h3{font-size:19px;line-height:1.65;margin:28px 0 12px}
.document h2:focus,.document h3:focus{outline:none}
p{margin:14px 0}
li{margin:7px 0;padding-left:2px}
ul,ol{padding-left:25px}
strong{color:#174c43}
blockquote{margin:20px 0;padding:10px 18px;background:var(--soft);border-left:4px solid var(--green)}
blockquote p{margin:5px 0}
.table-wrap{max-width:100%;overflow:auto;margin:20px 0}
table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.75}
th,td{border:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:top;min-width:105px;overflow-wrap:anywhere}
th{background:var(--soft);color:#174c43}
tr:nth-child(even) td{background:#f8fafb}
pre{padding:16px;background:#f1f5f6;border:1px solid var(--line);border-radius:4px;overflow:auto;font-size:13px;line-height:1.8}
code{font-family:Consolas,"Microsoft YaHei",monospace}
:not(pre)>code{font-size:.9em;background:#eef2f4;padding:1px 4px;border-radius:3px;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
.foot{font-size:13px;color:var(--muted);border-top:1px solid var(--line);margin-top:36px;padding-top:16px}
.back{display:inline-block;margin-top:12px}
@media(max-width:960px){
 .layout{grid-template-columns:1fr;gap:22px;padding:20px 16px 40px}
 .sidebar{position:static;max-height:none;padding-right:0}
 .toc-list{max-height:340px;overflow:auto;border-bottom:1px solid var(--line)}
 .document{padding:0 0 20px;border:0;background:transparent}
 .top-inner{padding:24px 16px}
 .top h1{font-size:25px}
 .title-desc{display:block;margin-top:4px}
 .document h2{font-size:22px}
 .document h3{font-size:18px}
 table{font-size:13px}
 th,td{padding:9px;min-width:105px}
 pre{white-space:pre-wrap;overflow-wrap:anywhere}
}
@media print{
 @page{size:A4;margin:16mm}
 body{background:white;font-size:10.5pt;line-height:1.65;color:#111}
 .sidebar,.toolbar,.back,.skip{display:none!important}
 .top{background:white;color:#111;border-color:#555}
 .top-inner{padding:0 0 12pt}
 .top h1{font-size:22pt}
 .top p{color:#444}
 .layout{display:block;padding:0}
 .document{padding:0;border:0}
 .document h2{font-size:16pt;margin-top:24pt;break-after:avoid}
 .document h3{font-size:12pt;break-after:avoid}
 p,li{orphans:3;widows:3}
 table{font-size:9pt}
 thead{display:table-header-group}
 tr{break-inside:avoid}
 th,td{min-width:0;padding:6pt}
 .table-wrap{overflow:visible}
 pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:9pt}
 a{color:#222;text-decoration:none}
}
</style>
</head>
<body id="top">
<a class="skip" href="#manual">跳到正文</a>
<header class="top"><div class="top-inner">
<h1><span>轨知 RailMind</span> <span class="title-desc">详细用户使用说明</span></h1>
<p>功能介绍 · 子功能说明 · 操作步骤 · 参数解释 · 示例与排错</p>
<div class="toolbar">
<a href="#chapter-5">第一次完整操作</a>
<a href="#chapter-16">逐项功能详解</a>
<a href="#chapter-26">术语与练习</a>
<a href="railmind-user-manual.zh-CN.md">Markdown 原文</a>
<button type="button" id="print">打印 / 另存为 PDF</button>
</div></div></header>
<div class="layout">
<nav class="sidebar" aria-label="手册目录">
<h2>阅读目录</h2>
<label for="search" class="search-label">搜索功能或问题</label>
<div class="search-row"><input type="search" id="search" placeholder="例如：上传、钉钉、阈值" autocomplete="off"><button type="button" id="clear">清空</button></div>
<p id="search-status" role="status" aria-live="polite">输入关键词搜索正文，展开章节查看子功能。</p>
<div class="toc-list">${toc}</div>
<noscript><p>目录可直接展开。浏览器的“查找”也可以搜索正文。</p></noscript>
</nav>
<main class="document" id="manual" tabindex="-1">
${content}
<footer class="foot">本说明可离线阅读。功能是否可用，以部署版本、模型、资料和服务配置为准。<br>
配套资料：<a href="railmind-upgrade-proposal.zh-CN.md">后续升级建议书</a>。建议书中的规划不表示已经实现。<br>
<a class="back" href="#top">返回顶部与目录</a></footer>
</main></div>
<script>
const search = document.getElementById('search');
const status = document.getElementById('search-status');
const headings = [...document.querySelectorAll('main h2, main h3')];
const normalize = (text) => text.toLocaleLowerCase().replace(/\\s+/g, ' ').trim();
const sections = new Map(headings.map((heading, index) => {
  const range = document.createRange();
  range.setStartBefore(heading);
  if (headings[index + 1]) range.setEndBefore(headings[index + 1]);
  else range.setEndAfter(document.querySelector('main .foot'));
  return [heading.id, normalize(range.toString())];
}));
const groups = [...document.querySelectorAll('.chapter')].map((element) => ({
  element, initialOpen: element.open,
  title: normalize(element.querySelector('summary').textContent),
  children: [...element.querySelectorAll('li')],
}));
function filter() {
  const terms = normalize(search.value).split(' ').filter(Boolean);
  let count = 0;
  for (const group of groups) {
    const chapterText = group.title + ' ' + sections.get(group.element.dataset.id);
    const chapterMatch = terms.every((term) => chapterText.includes(term));
    let childMatch = false;
    for (const item of group.children) {
      const id = item.querySelector('a').hash.slice(1);
      const text = group.title + ' ' + sections.get(id);
      const match = terms.every((term) => text.includes(term));
      item.hidden = terms.length > 0 && !match && !chapterMatch;
      childMatch ||= match;
    }
    const match = chapterMatch || childMatch;
    group.element.hidden = !match;
    group.element.open = terms.length ? match : group.initialOpen;
    if (match) count++;
  }
  status.textContent = terms.length
    ? (count ? '找到 ' + count + ' 个相关章节，点击条目阅读。' : '没有找到匹配项，请换个词试试。')
    : '输入关键词搜索正文，展开章节查看子功能。';
}
search.addEventListener('input', filter);
document.getElementById('clear').addEventListener('click', () => {
  search.value = ''; filter(); search.focus();
});
document.getElementById('print').addEventListener('click', () => window.print());
document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', () => {
    const target = document.getElementById(link.hash.slice(1));
    if (target) target.focus({ preventScroll: true });
  });
});
</script>
</body></html>
`;
fs.writeFileSync(output, html);
console.log(`Rendered ${chapters.length} chapters and ${ids.size} headings: ${output}`);
