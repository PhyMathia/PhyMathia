#!/usr/bin/env node
// 加载顺序契约机器自检（2026-11-25，前端模块化改造 P2）
//
// 为什么存在：页面加载的不是 79 个 <script>，而是 build_frontend.mjs 把 entries
// 顺序拼成的一个包（`\n;\n` 连接后单遍 minify）。因此：
//   - 2397 个 function 声明全脚本提升 → 跨文件调用与顺序无关；
//   - 真正受顺序约束的只有顶层 const/let/class（TDZ：引用早于初始化当场炸），
//     以及加载期副作用（顶层语句里读 DOM、注册监听、算初始值）。
// esbuild 只做 transform、不建模块图，所以没有现成工具能回答「这文件为什么排在这」。
// 本脚本用 P0 装好的 typescript 解析 AST，静态回答这两问：
//
//   node scripts/check_load_order.mjs                 # 前向 TDZ 引用即红（进 verify）
//   node scripts/check_load_order.mjs --why <符号>    # 反查声明文件 + 所有加载期引用点
//   node scripts/check_load_order.mjs --edges         # 列出全部顺序约束边（消费者 ← 提供者）
//
// 判定口径（刻意保守，只报「一定错」的）：
//   1. 顶层 TDZ 声明 = SourceFile 直接语句里的 const/let/class（IIFE/块内不算全局）；
//   2. 加载期引用 = 顶层语句树里、函数/方法体之外的标识符值引用（属性名、声明名、
//      解构键不算；类继承子句与属性初始化式算——它们在类定义时求值）；
//   3. 只有「文件 i 加载期引用了文件 j（j > i）的 TDZ 声明」才报红。函数提升、
//      运行期（函数体内）引用、同文件内顺序都不在此列。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jsDir = resolve(root, 'src', 'static', 'js');
const buildScript = resolve(root, 'scripts', 'build_frontend.mjs');
const MIN_ENTRIES = 70; // 低于此数说明正则与构建脚本脱节，拒绝拿残缺名单放行

function fail(msg) {
  console.error(`[check_load_order] ❌ ${msg}`);
  process.exit(1);
}

function readEntries() {
  const text = readFileSync(buildScript, 'utf8');
  const block = text.match(/const entries = \[([\s\S]*?)\n\];/);
  if (!block) fail('解析不到 build_frontend.mjs 的 entries 数组（构建脚本结构变了？）');
  const entries = [...block[1].matchAll(/'([^']+\.js)'/g)].map((m) => m[1]);
  if (entries.length < MIN_ENTRIES) {
    fail(`entries 只解析出 ${entries.length} 项（< ${MIN_ENTRIES}），正则与构建脚本脱节`);
  }
  const missing = entries.filter((f) => !existsSync(resolve(jsDir, f)));
  if (missing.length) fail(`entries 里有不存在的源文件: ${missing.join(', ')}`);
  return entries;
}

const lineOf = (sf, node) => ts.getLineAndCharacterOfPosition(sf, node.getStart(sf)).line + 1;

function bindingNames(pattern, out) {
  if (ts.isIdentifier(pattern)) {
    out.push(pattern.text);
  } else if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern)) {
    for (const el of pattern.elements) {
      if (ts.isBindingElement(el)) bindingNames(el.name, out);
    }
  }
  return out;
}

// 顶层声明面。tdz 供前向引用判定；funcs/vars/windowExports 只给 --why 反查用。
function topLevelDecls(sf) {
  const tdz = new Map();   // name -> { kind, line }
  const funcs = new Map();
  const vars = new Map();
  const windowExports = new Map();
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      const flags = st.declarationList.flags;
      const kind = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var';
      for (const d of st.declarationList.declarations) {
        const names = bindingNames(d.name, []);
        for (const name of names) {
          const rec = { kind, line: lineOf(sf, d) };
          if (kind === 'var') vars.set(name, rec);
          else tdz.set(name, rec);
        }
      }
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      funcs.set(st.name.text, { kind: 'function', line: lineOf(sf, st) });
    } else if (ts.isClassDeclaration(st) && st.name) {
      tdz.set(st.name.text, { kind: 'class', line: lineOf(sf, st) });
    } else if (
      ts.isExpressionStatement(st) &&
      ts.isBinaryExpression(st.expression) &&
      st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(st.expression.left) &&
      ts.isIdentifier(st.expression.left.expression) &&
      st.expression.left.expression.text === 'window'
    ) {
      windowExports.set(st.expression.left.name.text, { kind: 'window 导出', line: lineOf(sf, st) });
    }
  }
  return { tdz, funcs, vars, windowExports };
}

// 函数/方法体是运行期求值，整棵子树跳过；参数默认值也只在该函数被调用时才算。
function isDeferred(n) {
  return (
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n) ||
    ts.isConstructorDeclaration(n)
  );
}

// 是「值引用」而不是属性名/声明名/键名/标签。
function isValueReference(node) {
  const p = node.parent;
  if (!p) return false;
  switch (p.kind) {
    case ts.SyntaxKind.PropertyAccessExpression:
    case ts.SyntaxKind.QualifiedName:
      return p.name !== node;
    case ts.SyntaxKind.PropertyAssignment:
      return p.initializer === node;
    case ts.SyntaxKind.ShorthandPropertyAssignment:
      return true;
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.Parameter:
    case ts.SyntaxKind.BindingElement:
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.ClassExpression:
      return p.name !== node;
    case ts.SyntaxKind.LabeledStatement:
    case ts.SyntaxKind.BreakStatement:
    case ts.SyntaxKind.ContinueStatement:
    case ts.SyntaxKind.CatchClause:
      return false;
    default:
      return true;
  }
}

function walkRefs(sf, { loadTimeOnly }) {
  const refs = [];
  const seen = new Set();
  function walk(node) {
    if (loadTimeOnly && isDeferred(node)) return;
    if (ts.isIdentifier(node) && isValueReference(node)) {
      const line = lineOf(sf, node);
      const key = `${node.text}@${line}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ name: node.text, line });
      }
      return;
    }
    ts.forEachChild(node, walk);
  }
  for (const st of sf.statements) walk(st);
  return refs;
}

function load(file) {
  const text = readFileSync(resolve(jsDir, file), 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const parseErrors = sf.parseDiagnostics || [];
  if (parseErrors.length) {
    fail(`${file} 解析失败 ${parseErrors.length} 处，首条: ${ts.flattenDiagnosticMessageText(parseErrors[0].messageText, ' ')}`);
  }
  return { file, sf, decls: topLevelDecls(sf), refs: walkRefs(sf, { loadTimeOnly: true }) };
}

// ---- --why：反查一个符号的声明处与全部加载期引用点 ----
function why(sym, units) {
  const declSites = [];
  units.forEach((u, i) => {
    const d = u.decls.tdz.get(sym) || u.decls.funcs.get(sym) || u.decls.vars.get(sym) || u.decls.windowExports.get(sym);
    if (d) declSites.push({ index: i, file: u.file, ...d });
  });
  if (!declSites.length) fail(`entries 与顶层声明里都没有符号 "${sym}"（含 const/let/class/function/var/window.X）`);

  for (const d of declSites) {
    console.log(`声明: ${d.file}:${d.line}  (${d.kind}, entries 第 ${d.index + 1} 位)`);
  }
  const tdzIdx = declSites.filter((d) => d.kind !== 'function' && d.kind !== 'var' && d.kind !== 'window 导出').map((d) => d.index);
  const loadRefs = [];
  const runtimeCounts = [];
  units.forEach((u, i) => {
    const loadHits = u.refs.filter((r) => r.name === sym);
    for (const r of loadHits) loadRefs.push({ index: i, file: u.file, line: r.line });
    const all = walkRefs(u.sf, { loadTimeOnly: false }).filter((r) => r.name === sym);
    const runtime = all.length - loadHits.length;
    if (runtime > 0) runtimeCounts.push({ file: u.file, count: runtime });
  });

  if (loadRefs.length) {
    console.log('加载期引用（决定顺序的硬约束）:');
    for (const r of loadRefs) {
      const bad = tdzIdx.some((d) => d > r.index) ? '  ← 前向引用，非法' : '';
      console.log(`  ${r.file}:${r.line}  (第 ${r.index + 1} 位)${bad}`);
    }
  } else {
    console.log('加载期引用: 无 —— 没有任何文件的顶层语句在加载时读它，顺序不受它约束');
  }
  if (runtimeCounts.length) {
    console.log(`运行期引用（函数体内，全部函数声明提升，不影响顺序）: ${runtimeCounts.reduce((a, b) => a + b.count, 0)} 处`);
    for (const r of runtimeCounts.slice(0, 12)) console.log(`  ${r.file}: ${r.count} 处`);
    if (runtimeCounts.length > 12) console.log(`  …另有 ${runtimeCounts.length - 12} 个文件`);
  }
  console.log(`提示: 改 entries 顺序后跑一遍本脚本，前向 TDZ 引用会当场报红。`);
  process.exit(0);
}

// ---- 主流程 ----
const argv = process.argv.slice(2);
const whyIdx = argv.indexOf('--why');
const entries = readEntries();
const units = entries.map(load);

if (whyIdx >= 0) {
  const sym = argv[whyIdx + 1];
  if (!sym) fail('--why 后要跟符号名，例如：node scripts/check_load_order.mjs --why g_currentGraph');
  why(sym, units);
}

const declIndexByName = new Map(); // 名字 -> 声明所在文件下标（TDZ 声明跨文件不允许重名）
units.forEach((u, i) => {
  for (const name of u.decls.tdz.keys()) {
    if (declIndexByName.has(name)) fail(`顶层 TDZ 声明重名: ${name} 同时出现在 ${units[declIndexByName.get(name)].file} 与 ${u.file}`);
    declIndexByName.set(name, i);
  }
});

if (argv.includes('--edges')) {
  const edges = new Map(); // 消费者 -> Map(提供者 -> Set(符号))
  units.forEach((u, i) => {
    for (const r of u.refs) {
      const j = declIndexByName.get(r.name);
      if (j === undefined || j === i) continue;
      if (!edges.has(i)) edges.set(i, new Map());
      const m = edges.get(i);
      if (!m.has(j)) m.set(j, new Set());
      m.get(j).add(r.name);
    }
  });
  let total = 0;
  for (const [i, m] of edges) {
    for (const [j, names] of m) {
      total += names.size;
      console.log(`${units[i].file} (第 ${i + 1} 位) 加载期读 ${units[j].file} (第 ${j + 1} 位) 的 ${[...names].join(', ')}`);
    }
  }
  console.log(`[check_load_order] ${edges.size} 个消费者文件 / ${total} 条顺序约束边`);
  process.exit(0);
}

const errors = [];
for (let i = 0; i < units.length; i++) {
  for (const r of units[i].refs) {
    for (let j = i + 1; j < units.length; j++) {
      const d = units[j].decls.tdz.get(r.name);
      if (d) {
        errors.push({
          name: r.name, refFile: units[i].file, refLine: r.line,
          declFile: units[j].file, declLine: d.line, kind: d.kind,
          from: i + 1, to: j + 1,
        });
      }
    }
  }
}

const tdzCount = units.reduce((a, u) => a + u.decls.tdz.size, 0);
const loadRefCount = units.reduce((a, u) => a + u.refs.length, 0);

if (errors.length) {
  console.error(`[check_load_order] ❌ 发现 ${errors.length} 处前向 TDZ 引用（加载期读了后面文件的 const/let/class，运行时会 ReferenceError）:`);
  for (const e of errors.slice(0, 40)) {
    console.error(`  ${e.refFile}:${e.refLine} 读 ${e.name}（第 ${e.from} 位）→ 声明在 ${e.declFile}:${e.declLine}（${e.kind}，第 ${e.to} 位）`);
  }
  if (errors.length > 40) console.error(`  …另有 ${errors.length - 40} 处`);
  console.error('[check_load_order] 修法：把声明文件在 build_frontend.mjs 的 entries 里前移，或把该引用挪进函数体（函数声明全脚本提升，运行期调用无顺序约束）。');
  process.exit(1);
}

console.log(`[check_load_order] ✓ ${units.length} 个文件 / ${tdzCount} 个顶层 TDZ 声明 / ${loadRefCount} 个加载期引用 —— 无前向引用`);
