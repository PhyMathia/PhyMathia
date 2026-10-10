#!/usr/bin/env node
// Utopia 查看器打包：只取画布渲染子系统 + 只读桩，产出 src/static/js/viewer.js。
// 与 build_frontend.mjs 同机制（逐文件 esbuild minify 后按顺序拼接），但 entries 是子集：
// 会话/AI/知识检测/Φ 全不进包——查看器是只读产物，不需要也不该带这些能力。
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = resolve(root, 'src', 'static', 'js');
const outFile = resolve(jsDir, 'viewer.js');
const viewerHtml = resolve(root, 'src', 'static', 'viewer.html');

// 顺序即加载序：桩在最前（函数声明已提升，赋值不会被后续文件覆盖），主程序在最后。
const entries = [
  'viewer-shims.js',
  'config.js',
  'utils.js',
  'render.js',
  'graph-recipes.js',
  'graph.js',
  'graph-search.js',
  'graph-render.js',
  // T261 拆分随迁：graph-interact 裸调 _runLayout/_savePositions、graph.js 守卫调
  // diff 高亮、graph-workflow.js 导出块读 autoArrangeGraph——viewer 子集两件都要带
  'graph-render-diff.js',
  'graph-render-layout.js',
  'graph-interact.js',
  'graph-custom.js',
  // 工作流族四件随迁（T261 拆分）：主件尾部导出块与 DOMContentLoaded 初始化引用族内函数
  'graph-workflow-prompt.js',
  'graph-workflow-recipe.js',
  'graph-workflow-template.js',
  'graph-workflow-progress.js',
  'graph-workflow.js',
  'graph-poster.js',
  'graph-export.js',
  'graph-contextmenu.js',
  'utopia.js',
  'viewer-main.js',
];

const chunks = [];
let totalIn = 0;
for (const file of entries) {
  const entry = resolve(jsDir, file);
  const source = await readFile(entry, 'utf8');
  totalIn += Buffer.byteLength(source);
  const result = await build({
    entryPoints: [entry],
    bundle: false,
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    write: false,
    logLevel: 'silent',
  });
  chunks.push(`/* ${file} */\n${result.outputFiles[0].text.trim()}`);
}

const bundle = chunks.join('\n;\n') + '\n';
await writeFile(outFile, bundle, 'utf8');
console.log(`[build_viewer] ${entries.length} files -> ${outFile}`);
console.log(`[build_viewer] ${totalIn} bytes -> ${Buffer.byteLength(bundle)} bytes`);

// 缓存版本号：与主包同样按内容哈希写进 viewer.html，避免旧包被浏览器缓存
try {
  const html = await readFile(viewerHtml, 'utf8');
  const version = createHash('sha256').update(bundle).digest('hex').slice(0, 8);
  const updated = html.replace(/(viewer\.js\?v=)[0-9A-Za-z_]+/, `$1${version}`);
  if (updated !== html) {
    await writeFile(viewerHtml, updated, 'utf8');
    console.log(`[build_viewer] viewer.html cache version -> ${version}`);
  }
} catch (e) {
  console.warn('[build_viewer] viewer.html version bump skipped:', e.message);
}
