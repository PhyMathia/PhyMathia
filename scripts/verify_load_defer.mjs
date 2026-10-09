#!/usr/bin/env node
// T208 defer 改动的真机验证。本次改动的两个风险点（defer 后 appVersion 内联脚本
// 的时序、app.js 执行时点）都只在真浏览器里可见：Node 冒烟沙箱把 app.js 塞 vm 里
// 跑，根本不读 index.html、不模拟加载时序，全绿也证明不了这次改动对。
// 本脚本用真 chromium 加载页面，断言四件事：
//   1) 首页 200
//   2) #appVersion 填上非空版本号（同步执行 APP_VERSION 会 ReferenceError 留空）
//   3) APP_VERSION 常量可用（defer 脚本先于 DOMContentLoaded 执行完）
//   4) 浏览器眼中的 app.js 标签带 defer
// 另复核 #memoryPanel 存在——它在第 259 行 script 标签之后，同步脚本不执行完
// 它根本不会被解析，defer 后必须立即可见。
// 用法：先起服务（无需模型上游，index 是静态页），例如
//   python3 src/main.py -p 5099 --no-file-log &
//   node scripts/verify_load_defer.mjs [端口，默认 5099]
import { chromium } from 'playwright';

const port = process.argv[2] || '5099';
const base = `http://127.0.0.1:${port}`;

let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '❌ ') + name + (ok || !detail ? '' : ' -> ' + detail));
  if (!ok) failed++;
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const resp = await page.goto(base + '/', { waitUntil: 'load', timeout: 20000 });
  check('首页返回 200', !!resp && resp.status() === 200, 'status=' + (resp && resp.status()));

  // DOMContentLoaded 已过（waitUntil: load 保证），此时版本号应已由 DOMContentLoaded
  // 处理器填入；同步执行那条旧路会 ReferenceError、textContent 永远为空。
  const version = await page.evaluate(() => {
    const el = document.getElementById('appVersion');
    return el ? el.textContent.trim() : '';
  });
  check('#appVersion 填上了非空版本号（defer 时序正确）', /^v\d/.test(version), 'textContent="' + version + '"');

  const type = await page.evaluate(() => {
    try { return typeof APP_VERSION; } catch (e) { return 'throw:' + e.message; }
  });
  check('APP_VERSION 常量可用（defer 脚本先于 DOMContentLoaded 执行完）', type === 'string', 'typeof=' + type);

  const appTag = await page.evaluate(() => {
    const s = [...document.querySelectorAll('script[src]')].find(el => /\/js\/app\.js/.test(el.getAttribute('src') || ''));
    return s ? { src: s.getAttribute('src'), defer: s.defer } : null;
  });
  check('浏览器眼中 app.js 标签带 defer', !!appTag && appTag.defer, appTag ? JSON.stringify(appTag) : '标签不存在');

  const backHalf = await page.evaluate(() => !!document.getElementById('memoryPanel'));
  check('script 标签之后的 DOM 已解析（#memoryPanel 在）', backHalf, '缺 #memoryPanel');
} finally {
  await browser.close();
}

console.log(failed ? '\ndefer 真机验证失败' : '\ndefer 真机验证全部通过');
process.exit(failed ? 1 : 0);
