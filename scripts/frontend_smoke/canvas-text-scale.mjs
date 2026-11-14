// 画布字号档（graph-interact.js ＋ graph-override.css，2026-11-15）契约与行为。
// 范围：工具条 A− / A+ 两枚钮、六档等比序列、:root 变量 --graph-text-scale、
// 落盘键 phymathia_graph_text_scale、右键复位项。
// 全部同步用例——行为断言把 documentElement 换成记录桩，不触碰真 DOM
// （requestAnimationFrame 在沙箱里是空桩，_afterGraphTextScaleChange 的重测不会跑）。
import { check, sandbox, fs, storageData } from './_runner.mjs';

const readSrc = (p) => fs.readFileSync(p, 'utf8');
const KEY = 'phymathia_graph_text_scale';

export function run() {
  check('canvas-text-scale: 五档序列最小 100%、顶端 145%，A− / A+ 接在工具条上、顶层读盘即应用', () => {
    const src = readSrc('src/static/js/graph-interact.js');
    // 档位序列是拍板值：100/110/120/132/145%。2026-11-15 用户二拍——85%、92% 两档「看不清」
    // 已删（缩字对阅读无意义，最小档就是默认 100%），顶端补 145%
    if (!/GRAPH_TEXT_SCALES = \[1, 1\.1, 1\.2, 1\.32, 1\.45\]/.test(src)) {
      throw new Error('档位序列被改动（应为 1/1.1/1.2/1.32/1.45）');
    }
    if (!src.includes('onclick="graphTextScaleStep(-1)"')) throw new Error('工具条缺 A− 按钮');
    if (!src.includes('onclick="graphTextScaleStep(1)"')) throw new Error('工具条缺 A+ 按钮');
    // 首屏就要是用户上次的档位：顶层必须「读盘 + 应用」各一次，不能等交互才生效
    if (!/_loadGraphTextScale\(\);\s*\n_applyGraphTextScale\(\);/.test(src)) {
      throw new Error('顶层缺「读盘 + 应用」初始化（首屏会闪回 100%）');
    }
    return true;
  });

  check('canvas-text-scale: 标题/正文/编辑框/全屏层统一乘 --graph-text-scale，:root 默认 1', () => {
    const css = readSrc('src/static/css/graph-override.css');
    const rootIdx = css.indexOf(':root {');
    if (rootIdx < 0) throw new Error('找不到 :root 变量区');
    if (!/--graph-text-scale:\s*1;/.test(css.slice(rootIdx, rootIdx + 400))) {
      throw new Error(':root 缺 --graph-text-scale 默认值 1');
    }
    const ruleBodyHasScale = (sel) => {
      const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{]*\\{([^}]*)\\}', 'g');
      return [...css.matchAll(re)].some((m) => m[1].includes('var(--graph-text-scale'));
    };
    for (const sel of ['.graph-node-label', '.graph-node-full-content', '.graph-node-sub',
      '.graph-custom-node-content', '.graph-custom-node-render', '.graph-node-fs-content']) {
      if (!ruleBodyHasScale(sel)) throw new Error(sel + ' 的字号没乘 --graph-text-scale');
    }
    const total = (css.match(/var\(--graph-text-scale, 1\)/g) || []).length;
    if (total < 9) throw new Error('只有 ' + total + ' 处乘了字号系数（应 ≥9：含移动端与 minimized 两处覆写）');
    return true;
  });

  check('canvas-text-scale: A+ 到 110% 并落盘，连点封顶 145% / 封底 100%，到顶到底都不再写变量', () => {
    const prevEl = sandbox.document.documentElement;
    const prevToast = sandbox.showToast;
    const calls = [];
    const toasts = [];
    // documentElement 换记录桩：_applyGraphTextScale 只用到 style.setProperty
    sandbox.document.documentElement = { style: { setProperty: (k, v) => { calls.push([k, String(v)]); } } };
    sandbox.showToast = (msg) => { toasts.push(String(msg)); };
    const last = () => (calls.length ? calls[calls.length - 1][1] : null);
    try {
      // 从 100% 起跑。新键的唯一写者就是本域，初始必为 1；仍先复位一次防其他域污染
      sandbox.graphTextScaleReset();
      calls.length = 0;
      toasts.length = 0;

      sandbox.graphTextScaleStep(1);
      if (last() !== '1.1') throw new Error('一次 A+ 应为 1.1，实为 ' + last());
      if (calls[calls.length - 1][0] !== '--graph-text-scale') throw new Error('写的变量名不对：' + calls[calls.length - 1][0]);
      if (String(storageData[KEY]) !== '1.1') throw new Error('未落盘（' + KEY + '=' + storageData[KEY] + '）');
      if (!toasts.some((t) => t.indexOf('110%') >= 0)) throw new Error('缺 110% 档位提示');

      for (let i = 0; i < 5; i++) sandbox.graphTextScaleStep(1);
      if (last() !== '1.45') throw new Error('封顶应为 1.45（145%），实为 ' + last());
      const beforeTop = calls.length;
      sandbox.graphTextScaleStep(1);
      if (calls.length !== beforeTop) throw new Error('已到顶，不应再写变量');
      if (!toasts.some((t) => t.indexOf('最大') >= 0)) throw new Error('到顶应提示已最大');

      for (let i = 0; i < 8; i++) sandbox.graphTextScaleStep(-1);
      if (last() !== '1') throw new Error('封底应为 1（100%），实为 ' + last());
      const beforeBottom = calls.length;
      sandbox.graphTextScaleStep(-1);
      if (calls.length !== beforeBottom) throw new Error('已到最小档 100%，不应再往下写变量');
      return true;
    } finally {
      sandbox.graphTextScaleReset(); // 还原前复位，别把 0.85 留给后面的域
      sandbox.document.documentElement = prevEl;
      if (prevToast === undefined) delete sandbox.showToast; else sandbox.showToast = prevToast;
    }
  });

  check('canvas-text-scale: 退役档位旧存值（0.85）读盘归一到 100% 并回写', () => {
    const prevEl = sandbox.document.documentElement;
    const calls = [];
    sandbox.document.documentElement = { style: { setProperty: (k, v) => { calls.push(String(v)); } } };
    try {
      // 上一版存过 0.85（如今不在档位表里）：不归一的话用户会卡在「点 A− 回不到 100、
      // 点 A+ 直接跳 110」的夹缝，所以读盘即落最近档并回写
      storageData[KEY] = '0.85';
      sandbox._loadGraphTextScale();
      sandbox._applyGraphTextScale();
      if (!calls.length || calls[calls.length - 1] !== '1') {
        throw new Error('0.85 应归一到 1，实为 ' + (calls.length ? calls[calls.length - 1] : '未写变量'));
      }
      if (String(storageData[KEY]) !== '1') throw new Error('归一后未回写存储：' + storageData[KEY]);
      return true;
    } finally {
      sandbox.document.documentElement = prevEl;
    }
  });

  check('canvas-text-scale: 右键菜单有「字号 N%」复位项，接 graphTextScaleReset', () => {
    const src = readSrc('src/static/js/graph-contextmenu.js');
    if (!src.includes("key: 'text-scale-reset'")) throw new Error('右键菜单缺字号复位项');
    if (!src.includes('graphTextScaleReset()')) throw new Error('右键菜单未接复位函数');
    if (!/'字号 ' \+ _tsPct \+ '%'/.test(src)) throw new Error('菜单标签应直接报当前档位');
    return true;
  });
}
