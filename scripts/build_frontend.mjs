import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
  'render.js',
  'chat.js',
  'chat-features.js',
  'chat-branch.js',
  'graph.js',
  'graph-search.js',
  'graph-render.js',
  'graph-interact.js',
  'graph-custom.js',
  'graph-workflow.js',
  'graph-export.js',
  'graph-contextmenu.js',
  'knowledge.js',
  'models.js',
  'harness.js',
  'harness-run.js',
  'harness-preview.js',
  'harness-apply.js',
  'ui.js',
  'quiz.js',
  'quiz-ai.js',
  'quiz-stats.js',
  'quiz-ui.js',
  'quiz-render.js',
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
  const code = result.outputFiles[0].text.trim();
  chunks.push(`/* ${file} */\n${code}`);
}

const bundle = chunks.join('\n;\n') + '\n';
await writeFile(outFile, bundle, 'utf8');
console.log(`[build_frontend] ${entries.length} files -> ${outFile}`);
console.log(`[build_frontend] ${totalIn} bytes -> ${Buffer.byteLength(bundle)} bytes`);

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
