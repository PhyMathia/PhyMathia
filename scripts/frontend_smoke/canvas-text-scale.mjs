// 画布字号档（graph-interact.js ＋ graph-override.css，2026-11-15）契约与行为。
// 范围：工具条 A− / A+ 两枚钮、六档等比序列、:root 变量 --graph-text-scale、
// 落盘键 phymathia_graph_text_scale、右键复位项。
// 全部同步用例——行为断言把 documentElement 换成记录桩，不触碰真 DOM
// （requestAnimationFrame 在沙箱里是空桩，_afterGraphTextScaleChange 的重测不会跑）。
import { check, sandbox, fs, storageData } from './_runner.mjs';

const readSrc = (p) => fs.readFileSync(p, 'utf8');
const KEY = 'phymathia_graph_text_scale';

export function run() {
  check('canvas-text-scale: 六档等比序列含 100%，A− / A+ 接在工具条上、顶层读盘即应用', () => {
    const src = readSrc('src/static/js/graph-interact.js');
    // 档位序列是拍板值：85/92/100/110/120/132%，任意倍率会让连点漂成 97.3%
    if (!/GRAPH_TEXT_SCALES = \[0\.85, 0\.925, 1, 1\.1, 1\.2, 1\.32\]/.test(src)) {
      throw new Error('档位序列被改动（应为 0.85/0.925/1/1.1/1.2/1.32）');
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

  check('canvas-text-scale: A+ 到 110% 并落盘，连点封顶 132% / A− 封底 85%，到顶不再写变量', () => {
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
      if (last() !== '1.32') throw new Error('封顶应为 1.32，实为 ' + last());
      const beforeTop = calls.length;
      sandbox.graphTextScaleStep(1);
      if (calls.length !== beforeTop) throw new Error('已到顶，不应再写变量');
      if (!toasts.some((t) => t.indexOf('最大') >= 0)) throw new Error('到顶应提示已最大');

      for (let i = 0; i < 8; i++) sandbox.graphTextScaleStep(-1);
      if (last() !== '0.85') throw new Error('封底应为 0.85，实为 ' + last());
      return true;
    } finally {
      sandbox.graphTextScaleReset(); // 还原前复位，别把 0.85 留给后面的域
      sandbox.document.documentElement = prevEl;
      if (prevToast === undefined) delete sandbox.showToast; else sandbox.showToast = prevToast;
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
