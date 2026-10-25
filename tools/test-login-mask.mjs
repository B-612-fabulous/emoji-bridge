/**
 * login_mask.js 自动化回归测试（无头 Chrome，不联网、不依赖真机）。
 *
 *   node tools/test-login-mask.mjs
 *
 * 做法：把 assets/login_mask.js 包成 window.__inject()，塞进一个仿抖音桌面版
 * 的假页面（tools/mock/harness.html + mock-douyin.js），再让 driver 在页面里
 * 跑完整交互链路（代点登录、弹窗顶起、React 重建、点 X 关闭、模式切换……），
 * 结果以 JSON 写回 DOM，由 --dump-dom 取出来。
 *
 * 之所以不用 CDP 的 WebSocket：Node 内置 WebSocket 连 Chrome DevTools 会在
 * 握手后立刻 1006 断开（系统 Chrome 的已知行为），--dump-dom 更省事也更稳。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'app/src/main/assets/login_mask.js');
const MOCK_DIR = path.join(ROOT, 'tools/mock');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 语法校验
const src = fs.readFileSync(SRC, 'utf8');
let syntaxOk = true;
try {
  new Function(src);       // 只编译，不执行
} catch (e) {
  syntaxOk = false;
  console.log(`\x1b[31m✗\x1b[0m 脚本语法可编译  \x1b[90m${e.message}\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m✓\x1b[0m 脚本语法可编译  \x1b[90m${(src.length / 1024).toFixed(1)} KB\x1b[0m`);

// ------------------------------------------------------------------ 组装临时页面
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-test-'));
const harness = path.join(tmp, 'harness.html');
fs.copyFileSync(path.join(MOCK_DIR, 'harness.html'), harness);
fs.copyFileSync(path.join(MOCK_DIR, 'mock-douyin.js'), path.join(tmp, 'mock-douyin.js'));
fs.writeFileSync(path.join(tmp, 'driver.js'),
  'window.__inject = function () {\n' + src + '\n};\n'
    + fs.readFileSync(path.join(MOCK_DIR, 'driver.body.js'), 'utf8'));

// ------------------------------------------------------------------ 跑无头 Chrome
const args = [
  '--headless=new',
  `--user-data-dir=${path.join(tmp, 'profile')}`,
  '--no-first-run', '--no-default-browser-check',
  // 在受限制的沙箱里跑时要关掉 Chrome 自己的 sandbox，否则渲染进程起不来，
  // 表现是 --dump-dom 一个字节都不输出。
  '--no-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--window-size=980,1200',
  '--virtual-time-budget=120000',
  '--dump-dom',
  'file://' + harness,
];

const dom = await new Promise((resolve) => {
  const p = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  p.stdout.on('data', (c) => { buf += c.toString(); });
  const timer = setTimeout(() => p.kill('SIGKILL'), 120000);
  p.on('close', () => { clearTimeout(timer); resolve(buf); });
});

// ------------------------------------------------------------------ 解析结果
const m = /<pre id="__out">([\s\S]*?)<\/pre>/.exec(dom);
if (!m) {
  console.error('\x1b[31m✗\x1b[0m 没拿到测试结果（页面可能没跑起来），dump 长度 ' + dom.length);
  console.error(dom.slice(0, 800));
  process.exit(2);
}
let results;
try {
  results = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
} catch (e) {
  console.error('\x1b[31m✗\x1b[0m 结果不是合法 JSON：' + m[1].slice(0, 300));
  process.exit(2);
}

for (const r of results) {
  const mark = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${r.name}${r.detail ? '  \x1b[90m' + r.detail + '\x1b[0m' : ''}`);
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} 通过`);
if (pass !== results.length) {
  console.log('\n失败项：');
  results.filter((r) => !r.ok).forEach((r) => console.log('  - ' + r.name + '  ' + r.detail));
  process.exitCode = 1;
}

fs.rmSync(tmp, { recursive: true, force: true });
await sleep(50);
