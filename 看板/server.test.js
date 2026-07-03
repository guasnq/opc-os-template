const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadServerModule() {
  const filename = path.join(__dirname, 'server.js');
  const code = fs.readFileSync(filename, 'utf8');
  const sandbox = {
    __dirname,
    __filename: filename,
    URL,
    console: { log() {}, error: console.error },
    process: { env: { NO_OPEN: '1' } },
    module: { exports: {} },
    require(name) {
      if (name === 'http') return { createServer: () => ({ listen() {} }) };
      if (name === 'child_process') return { exec() {} };
      return require(name);
    },
  };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(
    `${code}\nmodule.exports = { parseSimple, patchSimpleRow, ACCOUNT_HEADER, ACCOUNT_COLS, syncArtifactsForStage };`,
    sandbox,
    { filename }
  );
  return sandbox.module.exports;
}

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-board-'));
  [
    '02-文案生产/待审核',
    '02-文案生产/已通过',
    '02-文案生产/需要修改',
    '03-配音发布包/待配音',
    '03-配音发布包/已发布',
  ].forEach((dir) => fs.mkdirSync(path.join(root, dir), { recursive: true }));
  return root;
}

test('推进到待发布时同步稿件位置并生成发布包', () => {
  const { syncArtifactsForStage } = loadServerModule();
  const root = makeVault();
  const draft = path.join(root, '02-文案生产/待审核/一人公司运营面板.md');
  fs.writeFileSync(
    draft,
    '# 一人公司运营面板\n\n## 基本信息\n\n标题：我把一人公司里的运营这一块，开源了。\n\n状态：待审核\n\n## 正文\n\n正文\n'
  );

  const result = syncArtifactsForStage(
    root,
    { title: '[[02-文案生产/待审核/一人公司运营面板\\|一人公司运营面板]]', form: '文章' },
    'PUBLISH'
  );

  const approved = path.join(root, '02-文案生产/已通过/一人公司运营面板.md');
  const pkg = path.join(root, '03-配音发布包/待配音/一人公司运营面板.md');
  assert.equal(result.title, '[[02-文案生产/已通过/一人公司运营面板\\|一人公司运营面板]]');
  assert.equal(fs.existsSync(draft), false);
  assert.equal(fs.existsSync(approved), true);
  assert.match(fs.readFileSync(approved, 'utf8'), /状态：已通过/);
  assert.equal(fs.existsSync(pkg), true);
  assert.match(fs.readFileSync(pkg, 'utf8'), /状态：待发布/);
  assert.match(fs.readFileSync(pkg, 'utf8'), /\[\[02-文案生产\/已通过\/一人公司运营面板\|一人公司运营面板\]\]/);
});

test('账号表用平台加账号定位，两个小红书账号互不影响', () => {
  const { parseSimple, patchSimpleRow, ACCOUNT_HEADER, ACCOUNT_COLS } = loadServerModule();
  const md = [
    '| 平台 | 账号 | 入口 | 用途 |',
    '| --- | --- | --- | --- |',
    '| 小红书 | 南墙 | a | IP号 |',
    '| 小红书 | 墙子 | b | 产品号 |',
  ].join('\n');

  const rows = parseSimple(md, ACCOUNT_HEADER, ACCOUNT_COLS);
  assert.deepEqual(Array.from(rows, (row) => row.key), ['小红书::南墙', '小红书::墙子']);

  const patched = patchSimpleRow(md, ACCOUNT_HEADER, ACCOUNT_COLS, '小红书::墙子', { 用途: '小手机独立号' });
  assert.match(patched, /\| 小红书 \| 南墙 \| a \| IP号 \|/);
  assert.match(patched, /\| 小红书 \| 墙子 \| b \| 小手机独立号 \|/);
});
