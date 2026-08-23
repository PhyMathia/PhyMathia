import { build } from 'esbuild';
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
