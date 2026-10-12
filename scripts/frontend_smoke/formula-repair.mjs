// 公式渲染出错自愈（2026-10-12）：验证器/启发式/修复字典/芯片接线/后端契约
// 纯函数域（无 DOM、无 await 竞态）：芯片化本身跑在真实 DOM 上，这里用源码静态断言
// 锁接线、用 VM 沙箱＋katex 桩锁启发式与字典行为。新增用例直接往下追加。
import { check, drain, code, sandbox, vm, fs, localStorage, storageData } from './_runner.mjs';

const RENDER_SRC = fs.readFileSync('src/static/js/render.js', 'utf8');
const CONFIG_SRC = fs.readFileSync('src/static/js/config.js', 'utf8');
const GRAPH_RENDER_SRC = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
const MODELS_ROUTES_SRC = fs.readFileSync('src/server/models_routes.py', 'utf8');
const PROMPTS_SRC = fs.readFileSync('src/server/prompts.py', 'utf8');

export async function run() {
  // ===== 接线静态断言 =====
  check('公式自愈：芯片扫描已接入 _runKaTeX（双失败通道：katex-error＋math-raw 残留）', () => {
    if (!/_chipifyKatexErrors\s*=\s*function|function\s+_chipifyKatexErrors/.test(RENDER_SRC)) {
      throw new Error('_chipifyKatexErrors 未定义');
    }
    if (!/_runKaTeX[\s\S]{0,300}_chipifyKatexErrors\(element\)/.test(RENDER_SRC)) {
      throw new Error('_runKaTeX 末尾没有调用 _chipifyKatexErrors(element)');
    }
    if (!/window\.repairBrokenFormula\s*=\s*async function/.test(RENDER_SRC)) {
      throw new Error('window.repairBrokenFormula 未暴露（芯片按钮会失效）');
    }
    // auto-render 对括号失衡的公式认不出结尾定界符、回填原文不留任何错误标记
    // （vendor findEndOfMath 带花括号计数）——.math-raw 残留定界符扫描必须存在
    if (!/querySelectorAll\('\.math-raw'\)/.test(RENDER_SRC) || !/function\s+_stripMathBlockDelimiters/.test(RENDER_SRC)) {
      throw new Error('.math-raw 残留定界符扫描缺失（括号失衡类失败会漏检）');
    }
    return true;
  });

  check('公式自愈：修复字典走统一键常量（phymathia_ 前缀，config.js 集中）', () => {
    if (!/STORAGE_KEY_LATEX_REPAIRS\s*=\s*'phymathia_latex_repairs'/.test(CONFIG_SRC)) {
      throw new Error('config.js 缺 STORAGE_KEY_LATEX_REPAIRS 常量');
    }
    if (!RENDER_SRC.includes('STORAGE_KEY_LATEX_REPAIRS')) {
      throw new Error('render.js 没有引用统一键常量（裸字符串直连 localStorage）');
    }
    return true;
  });

  check('公式自愈：节点签名含修复字典版本（字典变化必须令渲染记忆失效）', () => {
    if (!/_latexRepairEpoch/.test(GRAPH_RENDER_SRC)) throw new Error('_graphNodeHtmlSig 未含 _latexRepairEpoch');
    return true;
  });

  check('公式自愈：后端路由与提示词常量在位（fix-formula 契约）', () => {
    if (!MODELS_ROUTES_SRC.includes('"/api/models/fix-formula"')) throw new Error('models_routes.py 缺 /api/models/fix-formula 路由');
    if (!MODELS_ROUTES_SRC.includes('FIX_FORMULA_PROMPT')) throw new Error('models_routes.py 未引用 FIX_FORMULA_PROMPT');
    if (!/FIX_FORMULA_PROMPT\s*=\s*"""/.test(PROMPTS_SRC)) throw new Error('prompts.py 缺 FIX_FORMULA_PROMPT 常量');
    if (!/"FIX_FORMULA_PROMPT"/.test(PROMPTS_SRC)) throw new Error('FIX_FORMULA_PROMPT 未进 __all__');
    return true;
  });

  // ===== VM 函数级行为断言（注入 katex 桩：指定原文必抛、其余通过）=====
  const KATEX_STUB_FAILS = {
    'a & b': "KaTeX parse error: Expected 'EOF', got '&' at position 3",
    'x^': "KaTeX parse error: Expected group after '^' at position 2",
    'x_': "KaTeX parse error: Expected group after '_' at position 2",
    '\\frac{1}{2': "KaTeX parse error: Unexpected end of input in a macro argument, expected '}' at end of input",
    '\\left(a + 1': "KaTeX parse error: Expected '\\right', got 'EOF' at end of input",
    '\\begin{pmatrix}1\\\\': "KaTeX parse error: Expected & or \\ or \\cr or \\end at end of input",
    '\\frac{\\foo{': "KaTeX parse error: Undefined control sequence: \\foo at position 6",
  };
  sandbox.window.katex = {
    renderToString: (latex, opts) => {
      const t = String(latex);
      if (t.indexOf('\\foo') >= 0) throw new Error("KaTeX parse error: Undefined control sequence: \\foo at position 6");
      const msg = KATEX_STUB_FAILS[t];
      if (msg) throw new Error(msg);
      return '<span class="katex">ok</span>';
    },
  };
  vm.runInContext('globalThis.__heal = (latex, err) => _heuristicRepairLatex(latex, err, false);' +
    'globalThis.__validate = (latex, mode) => _validateLatex(latex, mode);' +
    'globalThis.__saveRepair = (bad, good) => _saveLatexRepair(bad, good);' +
    'globalThis.__loadRepairs = () => _loadLatexRepairs();' +
    'globalThis.__repairEpoch = () => _latexRepairEpoch;', sandbox);
  const heal = (latex, err) => sandbox.__heal(latex, err);

  check('公式自愈：KaTeX 未就绪时验证器不判错（加载窗口不误挂芯片）', () => {
    const saved = sandbox.window.katex;
    sandbox.window.katex = null;
    try {
      if (sandbox.__validate('a & b', false) !== null) throw new Error('无 katex 时应视为通过');
    } finally { sandbox.window.katex = saved; }
    return true;
  });

  check('公式自愈：启发式——裸 & 转义（报错点名且无矩阵环境）', () => {
    if (heal('a & b', KATEX_STUB_FAILS['a & b']) !== 'a \\& b') {
      throw new Error('裸 & 应转义为 \\&，得到：' + JSON.stringify(heal('a & b', KATEX_STUB_FAILS['a & b'])));
    }
    return true;
  });

  check('公式自愈：启发式——大括号配平（截断的 frac）', () => {
    if (heal('\\frac{1}{2', KATEX_STUB_FAILS['\\frac{1}{2']) !== '\\frac{1}{2}') {
      throw new Error('应补齐右括号，得到：' + JSON.stringify(heal('\\frac{1}{2', KATEX_STUB_FAILS['\\frac{1}{2'])));
    }
    return true;
  });

  check('公式自愈：启发式——^/_ 缺组补空组', () => {
    if (heal('x^', KATEX_STUB_FAILS['x^']) !== 'x^{}') throw new Error("x^ 应修为 x^{}");
    if (heal('x_', KATEX_STUB_FAILS['x_']) !== 'x_{}') throw new Error("x_ 应修为 x_{}");
    return true;
  });

  check('公式自愈：启发式——\\left 无 \\right 收口', () => {
    if (heal('\\left(a + 1', KATEX_STUB_FAILS['\\left(a + 1']) !== '\\left(a + 1\\right)') {
      throw new Error('应补 \\right)，得到：' + JSON.stringify(heal('\\left(a + 1', KATEX_STUB_FAILS['\\left(a + 1'])));
    }
    return true;
  });

  check('公式自愈：启发式——截断矩阵补 \\end{环境}', () => {
    if (heal('\\begin{pmatrix}1\\\\', KATEX_STUB_FAILS['\\begin{pmatrix}1\\\\']) !== '\\begin{pmatrix}1\\\\\\end{pmatrix}') {
      throw new Error('应补 \\end{pmatrix}');
    }
    return true;
  });

  check('公式自愈：启发式——修不出来的保持原样（返回 null，交芯片）', () => {
    const r = heal('\\frac{\\foo{', KATEX_STUB_FAILS['\\frac{\\foo{']);
    if (r !== null) throw new Error('无把握时必须返回 null，得到：' + JSON.stringify(r));
    return true;
  });

  check('公式自愈：修复字典读写回环＋版本号递增（渲染记忆失效依据）', () => {
    const epoch0 = sandbox.__repairEpoch();
    sandbox.__saveRepair('BAD\\latex', 'GOOD\\latex');
    if (sandbox.__repairEpoch() !== epoch0 + 1) throw new Error('写入字典后 _latexRepairEpoch 必须递增');
    if (storageData['phymathia_latex_repairs'] == null) throw new Error('字典未落 localStorage');
    if (sandbox.__loadRepairs()['BAD\\latex'] !== 'GOOD\\latex') throw new Error('回读取不到修复对');
    return true;
  });

  await drain();
}
