#!/usr/bin/env node
// OPC 运营仪表盘 —— 本地服务（零依赖，Node 内置，仅绑 127.0.0.1）
//
// 读写 _首页.md 的三张表（选题流水线 / 产品 / 账号）+ 只读 05/发布复盘.md。
//   GET  /                        仪表盘页面（board.html）
//   --- 选题流水线（_首页.md，#号为主键，带状态机）---
//   GET  /api/pipeline             → {items:[{id,title,form,next,stage}]}
//   POST /api/pipeline/advance     {id, dir}            推进/退回
//   POST /api/pipeline/create      {title, form, next}
//   POST /api/pipeline/update      {id, title, form, next}
//   POST /api/pipeline/delete      {id}                 #号重排
//   --- 产品 / 账号（_首页.md，第一列文本为主键）---
//   GET  /api/product              → {items:[{key, 产品, 产品形态, 状态, 访问地址, 获客渠道, 获客账号}]}
//   POST /api/product/create       {产品, 产品形态, 状态, 访问地址, 获客渠道, 获客账号}
//   POST /api/product/update       {key, fields:{...}}
//   POST /api/product/delete       {key}
//   GET  /api/account              → {items:[{key, 平台, 账号, 入口, 用途}]}
//   POST /api/account/create       {平台, 账号, 入口, 用途}
//   POST /api/account/update       {key, fields:{...}}
//   POST /api/account/delete       {key}
//   --- 发布复盘（05/发布复盘.md，只读）---
//   GET  /api/data                 → {xhs, wx, zh, bili}  各平台数据行
//
// 每次写回前备份到 .backups/（留最近 20 份）。_首页.md 仍是唯一数据源。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 47812;
const HOME = path.resolve(__dirname, '..', '_首页.md');
const RECAP = path.resolve(__dirname, '..', '05-复盘商业化', '发布复盘.md');
const HTML = path.join(__dirname, 'board.html');
const BACKUP = path.join(__dirname, '.backups');

const STAGES = ['POOL', 'WRITING', 'REVIEW', 'VOICE', 'PUBLISH', 'DONE'];
const F = '⬜', G = '🟢', D = '✅', I = '💡';

// 各表的定位 pattern + 列定义
const PIPE_HEADER = /^\|\s*#\s.*内容选题/;
const PIPE_COLS = ['#', '内容选题', '形式', '选题', '写稿', '审核', '配音', '发布', '下一步'];
const PRODUCT_HEADER = /^\|\s*产品\s.*产品形态/;
const PRODUCT_COLS = ['产品', '产品形态', '状态', '访问地址', '获客渠道', '获客账号'];
const ACCOUNT_HEADER = /^\|\s*平台\s.*账号/;
const ACCOUNT_COLS = ['平台', '账号', '入口', '用途'];

// ===== 通用工具 =====
function findHeader(lines, pattern) { for (let i = 0; i < lines.length; i++) if (pattern.test(lines[i])) return i; return -1; }
function tableEnd(lines, h) { let e = h + 2; while (e < lines.length && lines[e].trim().startsWith('|')) e++; return e; }
function eolOf(md) { return md.includes('\r\n') ? '\r\n' : '\n'; }
function colIdx(cols, name) { const i = cols.indexOf(name); return i < 0 ? -1 : i + 1; } // +1 因为 split('|') 首段是空

// ===== 选题状态机 =====
function stageRow(s) {
  return { POOL:[I,F,F,F,F], WRITING:[D,G,F,F,F], REVIEW:[D,D,G,F,F], VOICE:[D,D,D,G,F], PUBLISH:[D,D,D,D,G], DONE:[D,D,D,D,D] }[s];
}
function rowStage(cells) {
  const e = n => (cells[n] || '').trim();
  if (e('发布') === D) return 'DONE';
  if (e('发布') === G) return 'PUBLISH';
  if (e('配音') === G) return 'VOICE';
  if (e('审核') === G) return 'REVIEW';
  if (e('写稿') === G) return 'WRITING';
  if (e('选题') === I || e('选题') === '🔵') return 'POOL';
  const done = ['选题','写稿','审核','配音','发布'].filter(n => e(n) === D).length;
  if (done >= 5) return 'DONE';
  if (done === 0) return 'POOL';
  return STAGES[Math.min(done, 5)];
}

// ===== 选题解析/渲染 =====
function parsePipeline(md) {
  const lines = md.split(/\r?\n/);
  const h = findHeader(lines, PIPE_HEADER);
  if (h === -1) return [];
  const end = tableEnd(lines, h);
  const items = [];
  for (let i = h + 2; i < end; i++) {
    const p = lines[i].split('|');
    const id = (p[1] || '').trim();
    if (!/^\d+$/.test(id)) continue;
    const title = (p[colIdx(PIPE_COLS, '内容选题')] || '').trim();
    if (!title) continue;
    const cells = {}; PIPE_COLS.forEach((c, idx) => { cells[c] = (p[idx + 1] || '').trim(); });
    items.push({ id, title, form: cells['形式'], next: cells['下一步'], stage: rowStage(cells) });
  }
  return items;
}
function renderPipelineRow(n, it) {
  const s = stageRow(it.stage);
  const cells = { '#': n, '内容选题': it.title, '形式': it.form || '', '下一步': it.next || '',
    '选题': s[0], '写稿': s[1], '审核': s[2], '配音': s[3], '发布': s[4] };
  const p = ['']; PIPE_COLS.forEach(c => p.push(' ' + (cells[c] || '') + ' ')); p.push('');
  return p.join('|');
}
function emptyPipelineRow(n) {
  const p = ['']; PIPE_COLS.forEach((c, idx) => p.push(idx === 0 ? ' ' + n + ' ' : '  ')); p.push('');
  return p.join('|');
}
function rewritePipeline(md, items) {
  const lines = md.split(/\r?\n/);
  const h = findHeader(lines, PIPE_HEADER);
  if (h === -1) throw new Error('找不到「内容流水线」表头');
  const end = tableEnd(lines, h);
  const rows = items.map((it, i) => renderPipelineRow(i + 1, it));
  rows.push(emptyPipelineRow(items.length + 1));
  return [...lines.slice(0, h + 2), ...rows, ...lines.slice(end)].join(eolOf(md));
}
// 就地改选题某行（字段 or 状态格）
function patchPipelineRow(md, id, patch) {
  const lines = md.split(/\r?\n/);
  const h = findHeader(lines, PIPE_HEADER);
  if (h === -1) throw new Error('找不到「内容流水线」表头');
  const end = tableEnd(lines, h);
  let ok = false;
  for (let i = h + 2; i < end; i++) {
    const p = lines[i].split('|');
    if ((p[1] || '').trim() !== String(id)) continue;
    Object.entries(patch).forEach(([col, val]) => { const ci = colIdx(PIPE_COLS, col); if (ci > 0) p[ci] = ' ' + val + ' '; });
    lines[i] = p.join('|'); ok = true; break;
  }
  if (!ok) throw new Error('找不到选题 #' + id);
  return lines.join(eolOf(md));
}

// ===== 简单表（产品/账号）解析/渲染/改 =====
function parseSimple(md, header, cols) {
  const lines = md.split(/\r?\n/);
  const h = findHeader(lines, header);
  if (h === -1) return [];
  const end = tableEnd(lines, h);
  const items = [];
  for (let i = h + 2; i < end; i++) {
    const p = lines[i].split('|');
    const key = (p[1] || '').trim();
    if (!key || key.startsWith('-')) continue;
    const cells = {}; cols.forEach((c, idx) => { cells[c] = (p[idx + 1] || '').trim(); });
    items.push({ key, cells });
  }
  return items;
}
function renderSimpleRow(cols, cells) {
  const p = ['']; cols.forEach(c => p.push(' ' + (cells[c] || '') + ' ')); p.push('');
  return p.join('|');
}
function emptySimpleRow(cols) {
  const p = ['']; cols.forEach(() => p.push('  ')); p.push('');
  return p.join('|');
}
function rewriteSimple(md, header, cols, items) {
  const lines = md.split(/\r?\n/);
  const h = findHeader(lines, header);
  if (h === -1) throw new Error('找不到表（header 不匹配）');
  const end = tableEnd(lines, h);
  const rows = items.map(it => renderSimpleRow(cols, it.cells));
  rows.push(emptySimpleRow(cols)); // 末尾占位空行
  return [...lines.slice(0, h + 2), ...rows, ...lines.slice(end)].join(eolOf(md));
}
function patchSimpleRow(md, header, cols, key, patch) {
  const lines = md.split(/\r?\n/);
  const h = findHeader(lines, header);
  if (h === -1) throw new Error('找不到表');
  const end = tableEnd(lines, h);
  let ok = false;
  for (let i = h + 2; i < end; i++) {
    const p = lines[i].split('|');
    if ((p[1] || '').trim() !== String(key)) continue;
    Object.entries(patch).forEach(([col, val]) => { const ci = cols.indexOf(col); if (ci >= 0) p[ci + 1] = ' ' + val + ' '; });
    lines[i] = p.join('|'); ok = true; break;
  }
  if (!ok) throw new Error('找不到行：' + key);
  return lines.join(eolOf(md));
}

// ===== 发布复盘（只读，按 ## 章节切表）=====
function parseRecap(md) {
  const sections = { xhs: '小红书', wx: '公众号', zh: '知乎', bili: 'B站' };
  const out = {};
  const lines = md.split(/\r?\n/);
  Object.entries(sections).forEach(([k, name]) => {
    out[k] = [];
    // 找 `## ...name...` 章节
    let s = -1;
    for (let i = 0; i < lines.length; i++) if (/^##/.test(lines[i]) && lines[i].includes(name)) { s = i; break; }
    if (s === -1) return;
    // 章节内第一个以 | 开头的行 = 表头（跳过 > 注释）
    let th = -1;
    for (let i = s + 1; i < lines.length; i++) { if (/^##/.test(lines[i])) break; if (/^\|/.test(lines[i])) { th = i; break; } }
    if (th === -1) return;
    const cols = lines[th].split('|').map(x => x.trim()).filter(Boolean);
    // 数据从 表头+2 开始（跳过分隔行 th+1）
    for (let i = th + 2; i < lines.length; i++) {
      if (!lines[i].trim().startsWith('|')) break;
      const p = lines[i].split('|').map(x => x.trim());
      const cells = {}; cols.forEach((c, idx) => { cells[c] = p[idx + 1] || ''; });
      if (cols.every(c => !cells[c])) continue;
      out[k].push({ cells });
    }
  });
  return out;
}

// ===== 备份 =====
function backup() {
  fs.mkdirSync(BACKUP, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const f = path.join(BACKUP, '_首页_' + ts + '.md');
  fs.copyFileSync(HOME, f);
  const olds = fs.readdirSync(BACKUP).filter(x => x.startsWith('_首页_')).sort();
  while (olds.length > 20) fs.unlinkSync(path.join(BACKUP, olds.shift()));
  return f;
}

function jsend(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req, res, cb) {
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch (e) { jsend(res, 400, { ok: false, error: '请求体不是合法 JSON' }); } });
}
const readFile = p => fs.readFileSync(p, 'utf8');

// ===== 路由 =====
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const m = req.method, p = u.pathname;

  if (m === 'GET' && p === '/') {
    try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(readFile(HTML)); }
    catch (e) { res.writeHead(500); res.end('board.html 缺失: ' + e.message); }
    return;
  }

  // ---- 选题 ----
  if (m === 'GET' && p === '/api/pipeline') {
    try { jsend(res, 200, { ok: true, items: parsePipeline(readFile(HOME)) }); }
    catch (e) { jsend(res, 500, { ok: false, error: e.message }); } return;
  }
  if (m === 'POST' && p === '/api/pipeline/advance') {
    readBody(req, res, ({ id, dir }) => {
      try {
        const md = readFile(HOME);
        const items = parsePipeline(md);
        const it = items.find(x => x.id === String(id));
        if (!it) throw new Error('找不到选题 #' + id);
        const idx = STAGES.indexOf(it.stage);
        const ni = Math.max(0, Math.min(STAGES.length - 1, idx + (dir > 0 ? 1 : -1)));
        if (ni === idx) throw new Error('已在边界');
        const s = stageRow(STAGES[ni]);
        backup();
        fs.writeFileSync(HOME, patchPipelineRow(md, id, { '选题': s[0], '写稿': s[1], '审核': s[2], '配音': s[3], '发布': s[4] }));
        jsend(res, 200, { ok: true, stage: STAGES[ni] });
      } catch (e) { jsend(res, 500, { ok: false, error: e.message }); }
    }); return;
  }
  if (m === 'POST' && p === '/api/pipeline/create') {
    readBody(req, res, ({ title, form, next }) => {
      try {
        const t = (title || '').trim(); if (!t) throw new Error('选题名不能为空');
        const md = readFile(HOME);
        const items = parsePipeline(md);
        items.push({ id: String(items.length + 1), title: t, form: (form || '').trim(), next: (next || '').trim(), stage: 'POOL' });
        backup(); fs.writeFileSync(HOME, rewritePipeline(md, items));
        jsend(res, 200, { ok: true });
      } catch (e) { jsend(res, 500, { ok: false, error: e.message }); }
    }); return;
  }
  if (m === 'POST' && p === '/api/pipeline/update') {
    readBody(req, res, ({ id, title, form, next }) => {
      try {
        const md = readFile(HOME);
        const patch = {};
        if (title !== undefined) patch['内容选题'] = String(title).trim();
        if (form !== undefined) patch['形式'] = String(form).trim();
        if (next !== undefined) patch['下一步'] = String(next).trim();
        backup(); fs.writeFileSync(HOME, patchPipelineRow(md, id, patch));
        jsend(res, 200, { ok: true });
      } catch (e) { jsend(res, 500, { ok: false, error: e.message }); }
    }); return;
  }
  if (m === 'POST' && p === '/api/pipeline/delete') {
    readBody(req, res, ({ id }) => {
      try {
        const md = readFile(HOME);
        const items = parsePipeline(md);
        const idx = items.findIndex(x => x.id === String(id));
        if (idx === -1) throw new Error('找不到选题 #' + id);
        items.splice(idx, 1);
        backup(); fs.writeFileSync(HOME, rewritePipeline(md, items));
        jsend(res, 200, { ok: true });
      } catch (e) { jsend(res, 500, { ok: false, error: e.message }); }
    }); return;
  }

  // ---- 产品 ----
  if (m === 'GET' && p === '/api/product') {
    try { jsend(res, 200, { ok: true, items: parseSimple(readFile(HOME), PRODUCT_HEADER, PRODUCT_COLS) }); }
    catch (e) { jsend(res, 500, { ok: false, error: e.message }); } return;
  }
  if (m === 'POST' && p === '/api/product/create') {
    readBody(req, res, (fields) => {
      try {
        const key = (fields['产品'] || '').trim(); if (!key) throw new Error('产品名不能为空');
        const md = readFile(HOME);
        const items = parseSimple(md, PRODUCT_HEADER, PRODUCT_COLS);
        items.push({ key, cells: fields });
        backup(); fs.writeFileSync(HOME, rewriteSimple(md, PRODUCT_HEADER, PRODUCT_COLS, items));
        jsend(res, 200, { ok: true });
      } catch (e) { jsend(res, 500, { ok: false, error: e.message }); }
    }); return;
  }
  if (m === 'POST' && p === '/api/product/update') {
    readBody(req, res, ({ key, fields }) => {
      try {
        const md = readFile(HOME);
        backup(); fs.writeFileSync(HOME, patchSimpleRow(md, PRODUCT_HEADER, PRODUCT_COLS, key, fields));
        jsend(res, 200, { ok: true });
      } catch (e) { jsend(res, 500, { ok: false, error: e.message }); }
    }); return;
  }
  if (m === 'POST' && p === '/api/product/delete') {
    readBody(req, res, ({ key }) => {
      try {
        const md = readFile(HOME);
        const items = parseSimple(md, PRODUCT_HEADER, PRODUCT_COLS).filter(x => x.key !== String(key));
        backup(); fs.writeFileSync(HOME, rewriteSimple(md, PRODUCT_HEADER, PRODUCT_COLS, items));
        jsend(res, 200, { ok: true });
      } catch (e) { jsend(res, 500, { ok: false, error: e.message }); }
    }); return;
  }

  // ---- 账号 ----
  if (m === 'GET' && p === '/api/account') {
    try { jsend(res, 200, { ok: true, items: parseSimple(readFile(HOME), ACCOUNT_HEADER, ACCOUNT_COLS) }); }
    catch (e) { jsend(res, 500, { ok: false, error: e.message }); } return;
  }
  if (m === 'POST' && p === '/api/account/create') {
    readBody(req, res, (fields) => {
      try {
        const key = (fields['平台'] || '').trim(); if (!key) throw new Error('平台不能为空');
        const md = readFile(HOME);
        const items = parseSimple(md, ACCOUNT_HEADER, ACCOUNT_COLS);
        items.push({ key, cells: fields });
        backup(); fs.writeFileSync(HOME, rewriteSimple(md, ACCOUNT_HEADER, ACCOUNT_COLS, items));
        jsend(res, 200, { ok: true });
      } catch (e) { jsend(res, 500, { ok: false, error: e.message }); }
    }); return;
  }
  if (m === 'POST' && p === '/api/account/update') {
    readBody(req, res, ({ key, fields }) => {
      try {
        const md = readFile(HOME);
        backup(); fs.writeFileSync(HOME, patchSimpleRow(md, ACCOUNT_HEADER, ACCOUNT_COLS, key, fields));
        jsend(res, 200, { ok: true });
      } catch (e) { jsend(res, 500, { ok: false, error: e.message }); }
    }); return;
  }
  if (m === 'POST' && p === '/api/account/delete') {
    readBody(req, res, ({ key }) => {
      try {
        const md = readFile(HOME);
        const items = parseSimple(md, ACCOUNT_HEADER, ACCOUNT_COLS).filter(x => x.key !== String(key));
        backup(); fs.writeFileSync(HOME, rewriteSimple(md, ACCOUNT_HEADER, ACCOUNT_COLS, items));
        jsend(res, 200, { ok: true });
      } catch (e) { jsend(res, 500, { ok: false, error: e.message }); }
    }); return;
  }

  // ---- 数据（复盘，只读）----
  if (m === 'GET' && p === '/api/data') {
    try { jsend(res, 200, { ok: true, ...(parseRecap(readFile(RECAP))) }); }
    catch (e) { jsend(res, 500, { ok: false, error: e.message }); } return;
  }

  res.writeHead(404); res.end('404');
});

srv.listen(PORT, '127.0.0.1', () => {
  console.log('仪表盘已启动: http://localhost:' + PORT);
  console.log('数据源: ' + HOME);
  console.log('按 Ctrl+C 关闭。');
  if (!process.env.NO_OPEN) { try { exec('open http://localhost:' + PORT); } catch (e) {} }
});
