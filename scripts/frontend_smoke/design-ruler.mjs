// 设计尺子＋横屏视觉打磨（尾部含一条收口线）
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 5293–5493 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export async function run() {
// ===== 设计尺子（2026-09-17）：新控件必须走令牌，同类载体必须同圆角 =====
// 这三条是「防漂」闸门：改样式时若把裸值/新色值写回来，或让同类弹窗圆角跑偏，会在这里红。

check('设计尺子：圆角一律走 --r-* 令牌（只允许 50%/0/inherit 这类结构性取值）', () => {
  const files = ['src/static/css/styles.css', 'src/static/css/styles-panels.css', 'src/static/css/graph-override.css'];
  const allowed = new Set(['50%', '0', 'inherit']);
  const bad = [];
  for (const f of files) {
    const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/border-radius\s*:\s*([^;{}]+);/g)) {
      const parts = m[1].replace(/\s*!important\s*/, '').trim().split(/\s+/);
      for (const v of parts) {
        if (v.startsWith('var(--r-') || allowed.has(v)) continue;
        bad.push(f.split('/').pop() + ' → ' + m[1].trim());
      }
    }
  }
  if (bad.length) throw new Error('还有 ' + bad.length + ' 处圆角写了裸值，应改用 --r-*：\n    ' + bad.slice(0, 6).join('\n    '));
  return true;
});

check('设计尺子：字号走 --fs-* 令牌（≥15px 的图标/标题档暂不强制）', () => {
  const files = ['src/static/css/styles.css', 'src/static/css/styles-panels.css'];
  const bad = [];
  for (const f of files) {
    const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/font-size\s*:\s*([^;{}]+);/g)) {
      const v = m[1].replace(/\s*!important\s*/, '').trim();
      if (v.startsWith('var(--fs-')) continue;
      const px = parseFloat(v);
      // 15px 以上是图标/标题/装饰档，允许保留；em/% 是相对尺寸，另有语义
      if (/^(\d+(?:\.\d+)?)px$/.test(v) && px < 15) bad.push(v);
    }
  }
  if (bad.length) throw new Error('还有 ' + bad.length + ' 处小字号写了裸值，应改用 --fs-*：' + [...new Set(bad)].join(', '));
  return true;
});

check('设计尺子：状态色只认 --danger/--success/--warn（域色不受限）', () => {
  const files = ['src/static/css/styles.css', 'src/static/css/styles-panels.css', 'src/static/css/graph-override.css'];
  const gate = /(danger|delete|remove|clear|error|fail|wrong|bad\b|correct|pass\b|saved|success|warn|waiting|done|accept|ignore|good|\bok\b|is-danger)/;
  const deny = /(graph-module|graph-node-module|kp-card-dot|graph-diff-|graph-history-badge|graph-ai-eval|graph-harness-op-|graph-node-attribute|continent-user-link)/;
  const lit = /(#[0-9a-fA-F]{6}|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+[^)]*\))/g;
  const bad = [];
  for (const f of files) {
    const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].replace(/\s+/g, ' ').trim();
      if (!sel || sel.startsWith('@') || !gate.test(sel) || deny.test(sel)) continue;
      for (const d of m[2].matchAll(/(color|background|background-color|border-color)\s*:\s*([^;{}]+);/g)) {
        const hits = (d[2].match(lit) || []).filter((v) => {
          const rgb = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
          let r, g, b;
          if (rgb) { r = +rgb[1]; g = +rgb[2]; b = +rgb[3]; }
          else { r = parseInt(v.slice(1, 3), 16); g = parseInt(v.slice(3, 5), 16); b = parseInt(v.slice(5, 7), 16); }
          return (r > 185 && 110 < g && g < 220 && b < 100) || (r > 190 && g < 130 && b < 150) || (g > 130 && r < 100 && b < 170);
        });
        if (hits.length) bad.push(sel.slice(0, 44) + ' → ' + d[1] + ': ' + hits.join(' '));
      }
    }
  }
  if (bad.length) throw new Error('状态色还有 ' + bad.length + ' 处硬编码，应改用 --danger/--success/--warn 族：\n    ' + bad.slice(0, 6).join('\n    '));
  return true;
});

check('设计尺子：面板关闭键必须有 aria-label（无障碍 + 统一关闭语义）', () => {
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  const bad = [];
  for (const m of html.matchAll(/<button[^>]*class="[^"]*\bclose\b[^"]*"[^>]*>/g)) {
    if (!/aria-label=/.test(m[0])) bad.push(m[0].slice(0, 70));
  }
  if (bad.length) throw new Error('关闭按钮缺 aria-label：\n    ' + bad.join('\n    '));
  return true;
});

check('设计尺子：同类载体的圆角同档（弹窗 --r-lg / 大浮层 --r-xl / 胶囊 --r-pill）', () => {
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8') + fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  const want = [
    ['.socratic-modal', '--r-lg', '表单弹窗'],
    ['.memory-dialog', '--r-lg', '确认弹窗'],
    ['.graph-canvas-toolbar', '--r-xl', '画布工具栏'],
    ['.example-guide-dialog', '--r-xl', '示例讲解'],
    ['.kp-search', '--r-pill', '搜索胶囊'],
  ];
  for (const [sel, tok, label] of want) {
    // 同名选择器可能有多条规则（响应式覆写等），只要求「至少有一条」把圆角定到该档
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
    const rules = [...css.matchAll(re)].map((m) => m[1]);
    if (!rules.length) continue;    // 选择器不在本文件管辖范围时跳过（graph-override 另算）
    if (!rules.some((r) => r.includes('var(' + tok + ')'))) throw new Error(label + '（' + sel + '）圆角应为 ' + tok);
  }
  return true;
});

// ===== 横屏视觉打磨（2026-09-27）：纯 CSS 块的四条硬契约 =====
// 1) 新样式必须包在 `@media (orientation: landscape)` 里——竖屏一像素不许动
//    （4 档横屏实测全绿，但没有任何机制能挡住下一个人把规则挪出媒体块）
// 2) 必须带应用作用域，只读外发页（viewer.html）不命中
// 3) 浮层作用域写错**静默不命中**——`.app-container .task-panel` 这类白写一遍不报错，
//    本轮就白改过一轮（index.html 里 .app-container 在 341 行就闭合了，
//    task/model/level/data 四个浮层都是它的**兄弟**节点）。所以逐条钉死。
// 4) 这轮只许动排版与位置，不许顺手回退材质/形状（那两条都是用户拍板过的）
check('横屏打磨：规则全在 orientation:landscape 内 + 浮层作用域写对 + 不回退材质形状', () => {
const scss = fs.readFileSync('src/static/css/styles.css', 'utf8');
const gcss = fs.readFileSync('src/static/css/graph-override.css', 'utf8');

// 剥掉注释（**保留字符数**，用等长空格替换，这样后面按下标定位仍然对得上原文件）。
// 不剥会踩一个很难发现的坑：注释里写的 `@media (orientation: landscape)` 字面量
// 会被下面的正则当成真块，扫到后面第一个 `{` 就配平出一个**幽灵块**，
// 把块外的选择器也算成「在块内」——把真块改成 portrait 都能照样通过（已实测）。
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

// 抽出 `@media (orientation: landscape) { ... }` 的块（按大括号配平）
function landscapeBlocks(rawCss) {
  const css = stripComments(rawCss);
  const out = [];
  const re = /@media[^{]*orientation:\s*landscape[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let i = m.index + m[0].length, depth = 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.push({ start: m.index, end: i });
  }
  return out;
}

for (const [file, rawCss, probes] of [
  ['styles.css', scss, ['.app-container .chat-header', 'body:has(> .app-container) .task-panel']],
  ['graph-override.css', gcss, ['.app-container .graph-canvas-toolbar', 'body:has(> .graph-harness-window:not([hidden])) .phi-pet-root']],
]) {
  // 探针也在**剥掉注释后**的文本里数：注释里为了讲清「哪种写法是错的」会引用选择器字面量，
  // 按原文数会把那些说明文字算成一处「落在横屏块外的规则」（本轮就先踩了这一个）。
  const css = stripComments(rawCss);
  const blocks = landscapeBlocks(rawCss);
  if (!blocks.length) throw new Error(file + ' 里找不到 @media (orientation: landscape) 块');
  for (const probe of probes) {
    // 必须**每一处**出现都在横屏块内。只要求「至少有一处在块内」是不够的：
    // 把主块改成 portrait 时，文件末尾那条 `(orientation: landscape) and (max-width: 1240px)`
    // 里还有同名选择器，`inside > 0` 照样成立——变异验证就是这么漏过去的（已实测）。
    let idx = -1, total = 0, inside = 0;
    while ((idx = css.indexOf(probe, idx + 1)) !== -1) {
      total++;
      if (blocks.some((b) => idx >= b.start && idx < b.end)) inside++;
    }
    if (total === 0) throw new Error('找不到「' + probe + '」@ ' + file);
    if (inside !== total) {
      throw new Error('「' + probe + '」在 ' + file + ' 里有 ' + (total - inside) + '/' + total
        + ' 处落在 @media (orientation: landscape) 之外——竖屏会被一起改到');
    }
  }
}

// 四个浮层是 .app-container 的兄弟节点，用后代选择器会静默不命中（本轮踩过）
for (const probe of [
  'body:has(> .app-container) .task-panel {',
  'body:has(> .app-container) .task-panel-title',
  'body:has(> .app-container) .model-panel',
  'body:has(> .app-container) .level-panel',
  'body:has(> .app-container) #dataPanel',
]) {
  if (!scss.includes(probe)) {
    throw new Error('缺「' + probe + '」——这些浮层在 index.html 里是 .app-container 的**兄弟**，'
      + '写成 .app-container X 静默不命中（白改不报错）');
  }
}

// 停靠形状不许被这轮碰：接缝拉直（上两角 0）+ 底角 --r-2xl
// 注意锚点：`.task-panel.show.task-panel--docked {` 里**也含** `.task-panel--docked {` 这个子串，
// 直接 indexOf 会先撞上那一条（它只改 display/flex，没有圆角）→ 必须带行首缩进锚定。
const dockAt = scss.indexOf('\n    .task-panel--docked {');
const dock = dockAt < 0 ? '' : scss.slice(dockAt, scss.indexOf('}', dockAt));
if (!/border-radius: 0 0 var\(--r-2xl\) var\(--r-2xl\);/.test(dock)) {
  throw new Error('任务面板停靠形状被改了（应仍是 `0 0 var(--r-2xl) var(--r-2xl)`：接缝拉直、底角 24px）');
}

// 纯色玻璃档不许被「顺手加回渐变」——用户 2026-09-27 明确要「取消渐变但要有颜色」
for (const sel of ['.aurora-glass--plain {', '.aurora-glass--attached {']) {
  const at = scss.indexOf(sel);
  const blk = scss.slice(at, scss.indexOf('}', at));
  if (/radial-gradient/.test(blk)) throw new Error(sel + ' 被加回了色斑渐变（--aurora-* 归零才是用户要的口径）');
}

// 桌宠让位规则必须跟着窗口的 [hidden] 走（与 harness.js 的开关口径一致），
// 且必须落到窗口之下——只挪位置不改层级，桌宠被拖到窗口上仍会吃掉「发送」键（backlog T51）
const petSel = 'body:has(> .graph-harness-window:not([hidden])) .phi-pet-root {';
const petAt = gcss.indexOf(petSel);
if (petAt < 0) throw new Error('缺桌宠让位规则：窗口开着时桌宠仍会盖住 Φ 面板的「发送」键（T51）');
const petRule = gcss.slice(petAt, gcss.indexOf('}', petAt));
if (!/z-index:\s*var\(--z-\w+\);/.test(petRule)) {
  throw new Error('桌宠让位规则缺 z-index：只挪位置不改层级，被拖到窗口上的桌宠仍会吃掉控件点击');
}
return true;
});

// 串行段里的异步用例同样进 pendingChecks——必须再收一次，否则断言结果赶不上退出判定
await drain();
}
