import { transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = resolve(root, 'src', 'static', 'js');
const outFile = resolve(jsDir, 'app.js');

// 顺序必须与 index.html 原脚本加载顺序一致。
const entries = [
  'mermaid-loader.js',
  'config.js',
  'memory.js',
  'utils.js',
  'session.js',
  'send-queue.js',
  'tasks.js',
  'render.js',
  'chat.js',
  'chat-features.js',
  'chat-branch.js',
  'graph-recipes.js',
  'graph.js',
  // 修改历史三件＋图数据＋体检（2026-10-24 自 graph.js 拆出，T397 纯搬家）：组内顺序
  // 即原文件语句序（核心状态 const 在 graph.js，历史/数据件运行期取用，提升安全）
  'graph-history.js',
  'graph-history-diff.js',
  'graph-history-panel.js',
  'graph-data.js',
  'graph-consistency.js',
  'graph-search.js',
  'graph-render.js',
  // 版本对比高亮与自动布局（2026-10-10 自 graph-render.js 拆出，T261 纯搬家）：
  // 两件只被运行期调用（typeof 守卫/裸调用均可），紧跟本体保持族内顺序。
  'graph-render-diff.js',
  'graph-render-layout.js',
  // Φ 预览画布层（同日拆出）：不进 stage0/f3b 的 harness 沙箱清单、不进 viewer——
  // 两处都靠 typeof 守卫把画布侧函数当可缺席项（沙箱无 graph.js，viewer 无 Φ）
  'graph-render-preview.js',
  'graph-interact.js',
  'graph-custom.js',
  // 节点全屏划词快捷工具（2026-10-25）：选区/消息监听自带、画布函数运行期 typeof
  // 守卫调用，加载期零副作用；放 graph-custom 之后取其全屏/预览页挂接点
  'node-fs-toolbar.js',
  'graph-recipe-edit.js',
  // 工作流族（2026-10-10 自 graph-workflow.js 拆出，T261 纯搬家；2026-10-24 T397 再拆
  // 流式/生成/执行/入口与 graph-events 五件，同为纯搬家）：主件留尾部——其尾部
  // window 导出块加载期执行、引用族内各件函数（同 graph-continent view 最后的先例）
  'graph-workflow-prompt.js',
  'graph-workflow-recipe.js',
  'graph-workflow-template.js',
  'graph-workflow-progress.js',
  'graph-workflow-stream.js',
  'graph-workflow-generate.js',
  'graph-workflow-run.js',
  'graph-workflow-entry.js',
  'graph-events.js',
  'graph-workflow.js',
  'graph-export.js',
  'graph-poster.js',
  'utopia.js',
  'utopia-import.js',
  'utopia-html.js',
  'graph-contextmenu.js',
  'knowledge.js',
  // 学习笔记导出（2026-10-06）：紧跟 knowledge.js——正文纯函数依赖
  // getKnowledgeItems/_stripFormulaDelimiters，入口还引用 utils 的 toastMsg
  'note-export.js',
  // 知识大陆（2026-10-04 T36 自单文件拆六，组内顺序即依赖顺序，view 必须最后：
  // 文末 window.* 测试导出块加载期立即执行，引用前五件的全部导出函数）
  'graph-continent.js',
  'graph-continent-layout.js',
  'graph-continent-edges.js',
  'graph-continent-explore.js',
  'graph-continent-regions.js',
  'graph-continent-view.js',
  // 思考强度滑块（2026-10-25）：createThinkingSlider 组件，models.js 运行期经
  // window.createThinkingSlider 调用（槽位思考滑块＋简略模式统一滑块共用）；无加载期副作用
  'thinking-slider.js',
  'models.js',
  'harness.js',
  // Φ 会话管理与快照构建（2026-10-10 自 harness.js 拆出，T261 纯搬家）：sessions 件
  // 尾部带原顶层立即调用 _initPhiSessions()（同步前缀读域内 let，故须在 harness.js
  // 状态块之后执行）；快照件纯函数，run/apply 运行期调用
  'harness-sessions.js',
  'harness-snapshot.js',
  'harness-run.js',
  'harness-preview.js',
  'harness-apply.js',
  // 节点工坊（2026-10-20，创造模式重做 P0–P4）：只按需调用（模式菜单/配方管理/
  // 右键入口），依赖 graph-recipes.js 的归一化校验与 graph-workflow-prompt.js 的
  // 配方提示词组装——两者都在此之前加载；不进 viewer（查看器没有配方库）。
  'graph-workshop.js',
  'ui.js',
  // 数据备份与首次引导（2026-10-10 自 ui.js 拆出，T261 纯搬家）：两件都只按需调用
  // （面板开合 / 页面 load / 用户点击）；加载期求值的只有引导模板的 cssVarValue
  // （utils.js 此前已载），函数声明全脚本提升，置于 ui.js 之后即安全。
  'ui-backup.js',
  'ui-onboarding.js',
  // 本地多账号（P2 2026-10-07）：账号面板。依赖 config.js 的 ACCOUNT_ID/_RAW_LS
  // 与 utils.js 的 toastMsg/escapeHtml，都在此前加载；面板函数按需调用。
  'accounts.js',
  // 回收站（2026-10-07）：防误删面板。复用 accounts.js 的 _accountsDateStr 与
  // config.js 的 STORAGE_KEY_TRASH_RETENTION，都在此前加载；面板函数按需调用。
  'trash.js',
  // Token 用量统计（2026-10-08）：AI 调用记账的只读可视化面板。依赖 utils.js 的
  // escapeHtml/toastMsg（此前加载）；零依赖图表（conic-gradient 扇形＋手写 SVG
  // 折线，先例 quiz-render.js），静态容器在 index.html 的 #tokenDialog。
  'token-usage.js',
  'quiz.js',
  'quiz-ai.js',
  'quiz-stats.js',
  'quiz-ui.js',
  'quiz-render.js',
  'quiz-relearn.js',
];

// ===== 漏注册守卫（T215）：entries 是手工维护的有序名单，js/ 新增源文件忘登记时
// 构建静默跳过——文件「看起来在」却根本没进包，线上行为与源码对不上还没报错。
// 这里强扫目录：目录里每个 .js 必须在 entries、或属 viewer 家族（build_viewer.mjs
// 自己的名单与产物）、或在下方豁免清单里，否则硬失败并列出名单。
const nonAppEntries = new Set([
  'app.js',          // 本脚本的构建产物
  'viewer.js',       // build_viewer.mjs 的构建产物
  'viewer-main.js',  // viewer 家族源文件（归 build_viewer.mjs 的 entries 管）
  'viewer-shims.js',
]);
const onDisk = (await readdir(jsDir)).filter(function (f) { return f.endsWith('.js'); });
const unregistered = onDisk.filter(function (f) { return !entries.includes(f) && !nonAppEntries.has(f); });
if (unregistered.length) {
  console.error(`[build_frontend] js/ 发现未登记源文件（不会进 app.js 包，属漏注册）: ${unregistered.join(', ')}`);
  console.error('[build_frontend] 在本文件 entries 数组登记；确认属 viewer 家族则加进 nonAppEntries 豁免。');
  process.exit(1);
}

// 单遍压缩整包（T378，2026-10-23）：此前逐文件压缩再拼包（T215 的并发优化）给
// 不出 bundle 级 sourcemap——用户上报的异常栈只有 app.js:行:列，对不上源码。
// 单遍与逐文件一样不改顶层名（顶层＝全局作用域，跨文件全局调用依赖此），语义
// 等价；esbuild 处理 1.4MB 源在百毫秒级，无需并行。拼接处仍以「;」防上一文件
// 以表达式收尾时被下一文件行首括号吞噬；每个源文件前加 banner 注释——minify
// 会把它从产物剥掉，但它留在 map 的 sourcesContent 里，decode_client_error.mjs
// 靠它把「原始行号」归到具体源文件。
const banner = (file) => `\n/* ===== source: ${file} ===== */\n`;
const sources = new Map();
let totalIn = 0;
for (const file of entries) {
  const src = await readFile(resolve(jsDir, file), 'utf8');
  sources.set(file, src);
  totalIn += Buffer.byteLength(src);
}
const sourcesJoined = entries
  .map((file) => banner(file) + sources.get(file))
  .join('\n;\n');
const minified = await transform(sourcesJoined, {
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  sourcemap: true,
  sourcefile: 'app.bundle.src.js',
});
let bundle = minified.code.trim() + '\n';
if (!/sourceMappingURL=app\.js\.map/.test(bundle)) bundle += '//# sourceMappingURL=app.js.map\n';
// map 自带 sourcesContent（拼接源全文），离线解码不依赖仓内文件；sources 改成
// 可读名（esbuild 会写 sourcefile 名，本就是它，这里显式钉死防漂移）
const mapObj = JSON.parse(minified.map);
mapObj.sources = ['app.bundle.src.js'];
mapObj.sourcesContent = [sourcesJoined];
await writeFile(outFile, bundle, 'utf8');
await writeFile(resolve(jsDir, 'app.js.map'), JSON.stringify(mapObj), 'utf8');
console.log(`[build_frontend] ${entries.length} files -> ${outFile}`);
console.log(`[build_frontend] ${totalIn} bytes -> ${Buffer.byteLength(bundle)} bytes (+app.js.map ${Buffer.byteLength(JSON.stringify(mapObj))} bytes)`);

// 缓存版本号自动化：按产物内容哈希更新 index.html 的 app.js?v=，
// 避免忘记手动 bump 版本导致浏览器继续用旧包（“改了没反应”排障陷阱）
const indexFile = resolve(root, 'src', 'static', 'index.html');
try {
  const html = await readFile(indexFile, 'utf8');
  const version = createHash('sha256').update(bundle).digest('hex').slice(0, 8);
  const updated = html.replace(/(app\.js\?v=)[0-9A-Za-z]+/, `$1${version}`);
  if (updated !== html) {
    await writeFile(indexFile, updated, 'utf8');
    console.log(`[build_frontend] index.html cache version -> ${version}`);
  }
} catch (e) {
  console.warn('[build_frontend] index.html version bump skipped:', e.message);
}

// 静态资源同机制：按内容哈希刷新 index.html 的 ?v=。phi-pet.js 无构建产物直接对源文件取哈希；
// CSS 走下面的压缩产物链路（min 版哈希），不再对源文件取哈希。
// 改了任一文件后跑一次 npm run build:js，版本号自动刷新——不再需要手 bump（以前忘了就是「改了 CSS 却没反应」）。
const versionedAssets = [
  ['phi/phi-pet.js', /(phi-pet\.js\?v=)[0-9A-Za-z]+/],
];
try {
  const html = await readFile(indexFile, 'utf8');
  let updated = html;
  for (const [relPath, pattern] of versionedAssets) {
    const source = await readFile(resolve(root, 'src', 'static', relPath), 'utf8');
    const version = createHash('sha256').update(source).digest('hex').slice(0, 8);
    updated = updated.replace(pattern, `$1${version}`);
  }
  if (updated !== html) {
    await writeFile(indexFile, updated, 'utf8');
    console.log('[build_frontend] static asset versions updated');
  }
} catch (e) {
  console.warn('[build_frontend] static asset version bump skipped:', e.message);
}

// CSS 压缩产物：源 CSS 的注释是设计文档，绝不原地压缩——esbuild 压成同目录 *.min.css
// （与 app.js 同为「产物勿手改」的入库产物），index.html 的链接与 ?v=（按压缩产物内容哈希）
// 由本脚本改写；viewer.html 的链接不带 ?v=（服务端 no-cache+ETag 兜底），同样改指 min 版。
// 正则同时匹配旧 `styles.css?v=` 与已改写的 `styles.min.css?v=`，重复构建幂等。
const cssAssets = [
  ['css/styles.css', 'css/styles.min.css', /href="\/css\/styles(?:\.min)?\.css(\?v=)[0-9A-Za-z]+"/],
  ['css/styles-panels.css', 'css/styles-panels.min.css', /href="\/css\/styles-panels(?:\.min)?\.css(\?v=)[0-9A-Za-z]+"/],
  ['css/graph-override.css', 'css/graph-override.min.css', /href="\/css\/graph-override(?:\.min)?\.css(\?v=)[0-9A-Za-z]+"/],
  ['phi/phi-pet.css', 'phi/phi-pet.min.css', /href="\/phi\/phi-pet(?:\.min)?\.css(\?v=)[0-9A-Za-z]+"/],
];
try {
  const html = await readFile(indexFile, 'utf8');
  let updated = html;
  for (const [relPath, minRel, pattern] of cssAssets) {
    const source = await readFile(resolve(root, 'src', 'static', relPath), 'utf8');
    const result = await transform(source, { loader: 'css', minify: true, charset: 'utf8' });
    await writeFile(resolve(root, 'src', 'static', minRel), result.code, 'utf8');
    const version = createHash('sha256').update(result.code).digest('hex').slice(0, 8);
    updated = updated.replace(pattern, `href="/${minRel}$1${version}"`);
  }
  if (updated !== html) {
    await writeFile(indexFile, updated, 'utf8');
    console.log('[build_frontend] css minified, index.html links -> *.min.css');
  }
  const viewerFile = resolve(root, 'src', 'static', 'viewer.html');
  const vhtml = await readFile(viewerFile, 'utf8');
  const vupdated = vhtml
    .replace('href="/css/styles.css"', 'href="/css/styles.min.css"')
    .replace('href="/css/styles-panels.css"', 'href="/css/styles-panels.min.css"')
    .replace('href="/css/graph-override.css"', 'href="/css/graph-override.min.css"');
  if (vupdated !== vhtml) {
    await writeFile(viewerFile, vupdated, 'utf8');
    console.log('[build_frontend] viewer.html css links -> *.min.css');
  }
} catch (e) {
  console.warn('[build_frontend] css minify skipped:', e.message);
}
