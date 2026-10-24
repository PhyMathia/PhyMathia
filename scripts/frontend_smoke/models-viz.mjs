// M1 可视化数值实验校验＋模型分组/组级更新模型列表
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 2338–2582 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
// ===== M1 可视化数值实验自动校验 =====
check('viz-check：三桥注入与桥体打包存在', () => {
  if (!code.includes('_VIZ_CHECK_BRIDGE')) throw new Error('打包产物缺 _VIZ_CHECK_BRIDGE');
  // 压缩产物会去掉加号两侧空格，用空白容忍匹配三桥拼接
  if (!/_VIZ_MATH_BRIDGE\s*\+\s*_VIZ_THEME_BRIDGE\s*\+\s*_VIZ_CHECK_BRIDGE/.test(code)) throw new Error('buildVizCard 未注入第三桥');
  if (!code.includes('"phymathia-viz-check"')) throw new Error('校验消息类型缺失（桥回传或 parent 监听）');
  if (!code.includes('__PHYMATHIA_VIZ__')) throw new Error('约定对象探测缺失');
  return true;
});

check('viz-check：角标三态文案与重生成意图', () => {
  for (const t of ['校验通过 ✓', '守恒漂移 ⚠ 建议重新生成', '与解析解偏差 ⚠', '校验中…', '重新生成可视化：']) {
    if (!code.includes(t)) throw new Error('缺文案：' + t);
  }
  return true;
});

// T258（2026-10-11）：主题桥的原生机制检测延后到 DOMContentLoaded——注入在 </head> 时
// body 末尾的主题函数还没定义，当场必误判「无机制」→ 深色页面被父侧 invert 滤镜翻色。
// 从 render.js 源码提取真实桥接串，在隔离 vm 里用假 DOM 跑四个场景：
// loading 期不上报 / DOMContentLoaded 后认出 body 末尾函数 / 静态 data-theme 直接放行 /
// 全无机制才报 has:false（父侧才挂兜底滤镜）。
check('viz-theme（T258）：桥接检测延后 DOMContentLoaded＋静态 data-theme 放行', () => {
  const src = fs.readFileSync(new URL('../../src/static/js/render.js', import.meta.url), 'utf8');
  const start = src.indexOf('const _VIZ_THEME_BRIDGE = ');
  const end = src.indexOf("';", start);
  if (start < 0 || end < 0) throw new Error('render.js 源码里找不到 _VIZ_THEME_BRIDGE 赋值');
  const expr = src.slice(src.indexOf('=', start) + 1, end + 1);
  const bridgeJs = new Function('return (' + expr + ');')()
    .replace(/^<script>/, '').replace(/<\/script>$/, '');
  const runBridge = ({ theme = null, readyState = 'loading' }) => {
    const posted = [];
    const listeners = {};
    const s = {
      console: { log() {}, warn() {}, error() {} },
      document: {
        readyState,
        documentElement: { getAttribute: k => (k === 'data-theme' ? theme : null) },
        addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
        querySelectorAll: () => [],
      },
      parent: { postMessage: m => posted.push(m) },
      addEventListener: (t, fn) => { (listeners['w:' + t] = listeners['w:' + t] || []).push(fn); },
    };
    s.window = s;
    vm.createContext(s);
    vm.runInContext(bridgeJs, s);
    return { s, posted, fireDOMContentLoaded: () => (listeners.DOMContentLoaded || []).forEach(fn => fn()) };
  };
  // ① 页面解析中（桥在 head）：绝不能提前上报——此时判什么都是误判
  const a = runBridge({ readyState: 'loading' });
  if (a.posted.length !== 0) throw new Error('loading 期间就上报了检测结果（T258 的事故形态）');
  // ② body 末尾定义的主题函数：DOMContentLoaded 后必须被认出（修复前为 false → 错误反色）
  const b = runBridge({ readyState: 'loading' });
  vm.runInContext('window.applyTheme=function(){};', b.s);   // 模拟 body 末尾脚本补定义
  b.fireDOMContentLoaded();
  if (b.posted.length !== 1 || b.posted[0].type !== 'phymathia-theme-native' || b.posted[0].has !== true) {
    throw new Error('DOMContentLoaded 后没认出 body 末尾的主题函数: ' + JSON.stringify(b.posted));
  }
  // ③ 静态声明 data-theme（无任何函数/按钮）：直接放行
  const c = runBridge({ theme: 'dark', readyState: 'interactive' });
  if (c.posted.length !== 1 || c.posted[0].has !== true) {
    throw new Error('静态 data-theme 页面应放行: ' + JSON.stringify(c.posted));
  }
  // ④ 真的什么都没有：才报 has:false（父侧挂兜底滤镜）
  const d = runBridge({ readyState: 'interactive' });
  if (d.posted.length !== 1 || d.posted[0].has !== false) {
    throw new Error('无机制页面应报 has:false: ' + JSON.stringify(d.posted));
  }
  return true;
});

check('viz-check：_vizCheckEnergyTotals 分量求和与 NaN 计数', () => {
  const r = sandbox._vizCheckEnergyTotals([
    { t: 0, energy: { kinetic: 1, potential: 1 } },
    { t: 0.25, energy: { kinetic: NaN, potential: 1 } },
    { t: 0.5, energy: { kinetic: 2, potential: 2 } },
    { t: 0.75, energy: {} },            // 分量缺失 → 整点跳过
  ]);
  if (r.totals.length !== 2 || r.totals[0] !== 2 || r.totals[1] !== 4) throw new Error('求和错误: ' + JSON.stringify(r));
  if (r.nonFinite !== 1) throw new Error('nonFinite 应为 1');
  return true;
});

check('viz-check：_vizCheckComputeDrift 漂移口径', () => {
  if (sandbox._vizCheckComputeDrift([1, 1, 1, 1]) !== 0) return false;
  if (sandbox._vizCheckComputeDrift([1, 2, 3]) !== null) return false;          // <4 点
  if (sandbox._vizCheckComputeDrift([0, 0, 0, 0]) !== null) return false;       // 均值≈0 → 跳过守恒项
  const d = sandbox._vizCheckComputeDrift([10, 10.5, 10.2, 10.4, 10.3]);        // (10.5−10)/10.28≈4.9%
  if (!(d > 0.045 && d < 0.055)) throw new Error('漂移计算偏离: ' + d);
  return true;
});

check('viz-check：_vizCheckEstimatePeriod 由 KE 序列恢复周期', () => {
  // 解析 KE：C(1−cos2ωt)，ω=2 → 振子周期 T=2π/ω≈3.1416；250ms×40 点（真实采样节奏）
  const T = 2 * Math.PI / 2, dt = 0.25, samples = [];
  for (let i = 0; i < 40; i++) {
    const t = i * dt;
    samples.push({ t: t, energy: { kinetic: 0.5 * (1 - Math.cos(4 * t)), potential: 0.5 * (1 + Math.cos(4 * t)) } });
  }
  const est = sandbox._vizCheckEstimatePeriod(samples);
  if (est == null || Math.abs(est - T) / T > 0.005) throw new Error('周期估计偏离: ' + est);
  return true;
});

check('viz-check：_vizCheckTheoryPeriod v1 两张标准模型表', () => {
  const sm = sandbox._vizCheckTheoryPeriod('spring-mass', { m: 0.5, k: 2 });
  const pd = sandbox._vizCheckTheoryPeriod('pendulum', { L: 1, g: 9.8 });
  if (Math.abs(sm - Math.PI) > 1e-9) return false;
  if (Math.abs(pd - 2 * Math.PI * Math.sqrt(1 / 9.8)) > 1e-9) return false;
  if (sandbox._vizCheckTheoryPeriod('damped-oscillation', {}) !== null) return false;  // 非标准模型不猜
  if (sandbox._vizCheckTheoryPeriod('spring-mass', { m: 0, k: 2 }) !== null) return false;  // 参数非法不猜
  return true;
});

check('viz-check：_vizCheckVerdict 四态判定', () => {
  const synth = (w) => {
    const arr = [];
    for (let i = 0; i < 40; i++) {
      const t = i * 0.25;
      arr.push({ t: t, energy: { kinetic: 0.5 * (1 - Math.cos(2 * w * t)), potential: 0.5 * (1 + Math.cos(2 * w * t)) } });
    }
    return arr;
  };
  const vp = sandbox._vizCheckVerdict(synth(2), 'spring-mass', { m: 0.5, k: 2 });      // 周期与守恒均合
  if (vp.status !== 'pass') throw new Error('恒能应为 pass: ' + JSON.stringify(vp));
  const driftSamples = synth(2).map((s, i) => ({ t: s.t, energy: { kinetic: 1 + i * 0.2, potential: 1 } }));
  const vd = sandbox._vizCheckVerdict(driftSamples, null, null);
  if (vd.status !== 'fail' || vd.kind !== 'drift') throw new Error('漂移应 fail: ' + JSON.stringify(vd));
  const nanSamples = synth(2).map((s, i) => ({ t: s.t, energy: { kinetic: i % 3 === 0 ? NaN : 1, potential: 2 } }));
  const vn = sandbox._vizCheckVerdict(nanSamples, null, null);
  if (vn.status !== 'fail' || vn.kind !== 'diverge') throw new Error('NaN 多发应 diverge: ' + JSON.stringify(vn));
  const vw = sandbox._vizCheckVerdict(synth(2.2), 'spring-mass', { m: 0.5, k: 2 });    // 模拟 ω=2.2 vs 理论 ω=2 → 偏差 ~9%
  if (vw.status !== 'warn') throw new Error('周期偏差应 warn: ' + JSON.stringify(vw));
  const vq = sandbox._vizCheckVerdict(synth(2.2), null, null);                          // 未声明 model → 不比对解析解
  if (vq.status !== 'pass') throw new Error('未声明 model 不应 warn: ' + JSON.stringify(vq));
  if (sandbox._vizCheckVerdict(synth(2).slice(0, 2), 'spring-mass', { m: 0.5, k: 2 }).status !== 'none') return false;
  return true;
});

// ===== 模型分组与分组密钥 =====
check('model-group：分组接线（组头渲染/组密钥输入/折叠/optgroup 下拉）静态断言', () => {
  for (const t of ['phymathia_model_group_keys', 'saveGroupKey', 'toggleModelGroup', 'model-group-key', '<optgroup label=', 'data-provider']) {
    if (!code.includes(t)) throw new Error('打包产物缺：' + t);
  }
  // 点外关闭监听须跳过已脱离 DOM 的点击目标（分组折叠就地切换的前提）
  if (!code.includes('isConnected')) throw new Error('点外关闭缺少 detached-target 守卫');
  return true;
});

check('model-add：双模式添加接线（预设/手动选项卡 + 勾选清单 + 在线拉取）静态断言', () => {
  // 打包产物经 esbuild 压缩（键名引号/空白会被改写），只能断言裸标识符存在
  for (const t of ['switchAddModelTab', 'am-model-check', 'addModelsForProvider', 'api/models/list', 'fetchProviderModelList', 'fetchManualModelList', 'confirmDeleteModelGroup', '_parseExtraModelInput', '_dialogApiKeyWithFallback', '_freshIdsNotListed']) {
    if (!code.includes(t)) throw new Error('打包产物缺：' + t);
  }
  // 自动预置必须已移除：列表里只允许出现用户主动加过的模型（用户反馈的根因）
  for (const gone of ['_ensureOpencodeGoModels', '_ensureOpencodeFreeModels', '_ensureDeepseekModels']) {
    if (code.includes(gone)) throw new Error('自动预置函数仍在：' + gone);
  }
  // 预设注册表覆盖主流供应商（新增口径的最低门槛；注册表挂 window 供运行时读取）
  if (!code.includes('window.MODEL_PRESETS')) throw new Error('注册表未挂 window');
  for (const p of ['zhipu', 'moonshot', 'dashscope', 'bigmodel', 'minimaxi', 'siliconflow', 'generativelanguage', 'anthropic', 'openrouter', 'groq', 'xiaomimimo', '11434', '1234']) {
    if (!code.includes(p)) throw new Error('预设注册表缺供应商特征串：' + p);
  }
  // 每个预设的 hot（推荐星）id 必须真实存在于该预设的 models 里——hot 指向不存在的
  // id 不会报错，只是那颗星永远点不出来，属于静默失效。2026-09-27 真实踩过：
  // opencode 免费组的 hot 写的是 deepseek-v4-flash-free / mimo-v2.5-free，
  // 而当时的清单里已经没有这两个。
  for (const [key, preset] of Object.entries(sandbox.window.MODEL_PRESETS)) {
    if (!preset || !Array.isArray(preset.models)) continue;
    const ids = new Set(preset.models.map(m => m.id));
    for (const hot of preset.hot || []) {
      if (!ids.has(hot)) throw new Error('预设 ' + key + ' 的 hot 指向不存在的模型：' + hot);
    }
  }
  return true;
});

check('model-add：预设标签一律光模型名＋槽位思考选项（布尔族三档/effort 族五档/Φ 槽自动）', () => {
  // 2026-10-11 用户拍板：模型名不挂（旗舰）（性价比）这类注解，档位/定位说明走供应商 tagline
  for (const [key, preset] of Object.entries(sandbox.window.MODEL_PRESETS)) {
    for (const m of preset.models || []) {
      if (/[（(]/.test(m.label)) throw new Error('预设 ' + key + ' 标签带注解：' + m.label);
    }
  }
  if (!sandbox.window.THINKING_BOOLEAN_PROVIDERS) throw new Error('布尔开关族清单未挂 window');
  // 思考档位 2026-10-11 迁到槽位：布尔族 跟随默认/开/关 三档，effort 族加「关」共五档
  const boolOpts = sandbox._thinkingOptionsFor('mimo');
  if (boolOpts.length !== 3 || boolOpts[0].value !== '' || boolOpts[1].value !== 'on' || boolOpts[2].value !== 'off') {
    throw new Error('布尔族（mimo）槽位思考选项应为 跟随默认/开/关 三档');
  }
  const effortOpts = sandbox._thinkingOptionsFor('deepseek');
  if (effortOpts.length !== 5 || effortOpts[0].value !== '' || effortOpts[1].value !== 'off' || effortOpts[4].value !== 'max') {
    throw new Error('effort 族槽位思考选项应为 跟随默认/关/low/high/max 五档');
  }
  const graphOpts = sandbox._thinkingOptionsFor('deepseek', 'graph');
  if (!graphOpts[0].label.includes('自动')) throw new Error('Φ 槽「跟随默认」应标注自动（相位默认/按钮可覆盖）');
  return true;
});

check('model-add：无自动预置（loadUserModels 后列表为空）+ 预设添加核心（勾选入库 + 组密钥同步 + 重复跳过）', () => {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.loadUserModels();
  if (sandbox.getAllModels().length !== 0) throw new Error('loadUserModels 不得自动预置任何模型');
  const preset = sandbox.window.MODEL_PRESETS.deepseek; // const 声明只挂 window，不在沙箱全局
  if (!preset || !Array.isArray(preset.models) || preset.models.length < 2) throw new Error('deepseek 预设应 ≥2 个模型');
  const entries = preset.models.map(m => ({ model: m.id, label: m.label }));
  const n = sandbox.addModelsForProvider('deepseek', 'sk-ds-group', preset.baseUrl, entries);
  if (n !== preset.models.length) throw new Error('应新增 ' + preset.models.length + ' 个，实际 ' + n);
  const ds = sandbox.getAllModels().filter(m => m.provider === 'deepseek');
  if (ds.length !== preset.models.length) throw new Error('入库条数不符: ' + ds.length);
  if (!ds.every(m => m.hasKey)) throw new Error('组密钥未同步到条目');
  if (!ds.map(m => m.name).some(s => s.includes('Chat'))) throw new Error('label 未带入: ' + ds.map(m => m.name).join(','));
  const again = sandbox.addModelsForProvider('deepseek', 'sk-ds-group', preset.baseUrl, entries);
  if (again !== 0) throw new Error('重复添加应全部跳过，实际新增 ' + again);
  // 清理组密钥与条目缓存，避免污染后续用例的「组外不触碰」断言
  sandbox.saveGroupKey('deepseek', '');
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  return true;
});

check('model-add：组密钥写入同步到组内全部条目（组外不触碰）', () => {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.loadUserModels();
  const goPreset = sandbox.window.MODEL_PRESETS['opencode-go'];
  const picked = goPreset.models.slice(0, 3);
  const n = sandbox.addModelsForProvider('opencode-go', '', goPreset.baseUrl, picked.map(m => ({ model: m.id, label: m.label })));
  if (n !== 3) throw new Error('手动勾选 3 个应入库 3 个，实际 ' + n);
  if (sandbox.getAllModels().filter(m => m.provider === 'opencode-go').some(m => m.hasKey)) throw new Error('未填密钥不应误标已配置');
  sandbox.saveGroupKey('opencode-go', 'sk-group-test');
  const after = sandbox.getAllModels();
  if (!after.filter(m => m.provider === 'opencode-go').every(m => m.hasKey)) return false;
  if (after.filter(m => m.provider !== 'opencode-go').some(m => m.hasKey)) return false; // 组外不得被污染
  if (JSON.parse(sandbox.localStorage.getItem('phymathia_model_group_keys'))['opencode-go'] !== 'sk-group-test') return false;
  // 组密钥存在时，后加的条目自动继承（空密钥不覆盖组里已有密钥）
  const extra = sandbox.addModelsForProvider('opencode-go', '', goPreset.baseUrl, [{ model: 'late-added-model', label: '后加模型' }]);
  if (extra !== 1) throw new Error('后加条目应入库');
  // getAllModels 的行项不带 model 原文（只有拼好的 name），按显示名匹配
  const late = sandbox.getAllModels().find(m => m.provider === 'opencode-go' && m.name.includes('后加模型'));
  if (!late || !late.hasKey) throw new Error('后加条目未继承组密钥');
  sandbox.saveGroupKey('opencode-go', '');
  if (sandbox.getAllModels().filter(m => m.provider === 'opencode-go').some(m => m.hasKey)) return false; // 清空也同步
  // 整组删除：条目、组密钥一并清
  const removed = sandbox.deleteModelGroup('opencode-go');
  if (removed !== 4) throw new Error('整组删除应清 4 条，实际 ' + removed);
  if (sandbox.getAllModels().some(m => m.provider === 'opencode-go')) throw new Error('整组删除后仍有残留');
  if (JSON.parse(sandbox.localStorage.getItem('phymathia_model_group_keys') || '{}')['opencode-go'] !== undefined) throw new Error('组密钥未一并删除');
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  return true;
});

// ===== 密钥不丢三件（2026-10-24 密钥丢失复盘）=====
// ① 逐键落盘已删：分组密钥框只在失焦（onchange）提交——旧版 oninput 每敲一个字符
//    就把半截钥写进 localStorage＋整包上传，密码管理器动一下框也会写。
// ② 组密钥只灌给「继承」的条目：单条目在配置弹窗里单独设过的钥不被覆盖。
// ③ 清空＝显式：继承条目清空时把 id 记进 clearKeys 清单（服务端合并语义下
//    「缺钥」只代表不知道，清单才是唯一删钥口），且整包 blob 恒带这个字段。
check('model-key-guard：组密钥逐键落盘已删（onchange 提交）＋清空走显式清单', () => {
  if (/oninput="saveGroupKey\(/.test(code)) throw new Error('分组密钥框仍挂着 oninput 逐键落盘（密钥会被半截值覆盖）');
  if (!/onchange="saveGroupKeyCommitted\(/.test(code)) throw new Error('分组密钥框缺失焦提交');
  if (!/autocomplete="new-password"/.test(code)) throw new Error('分组密钥框未关掉密码管理器自动填充');
  const blobFn = sandbox._modelsSyncBlob();
  if (!Array.isArray(blobFn.clearKeys)) throw new Error('整包 blob 应恒带 clearKeys 数组');
  for (const k of ['userModels', 'modelGroupKeys', 'activeModels']) {
    if (!(k in blobFn)) throw new Error('整包 blob 缺字段：' + k);
  }
  if (!code.includes('clearKeys')) throw new Error('打包产物缺 clearKeys 契约');
  return true;
});

check('model-key-guard：组密钥不覆盖单条目自有钥（继承口径）＋清空登记 clearKeys', () => {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.localStorage.removeItem('phymathia_active_models');
  sandbox.loadUserModels();
  const preset = sandbox.window.MODEL_PRESETS['opencode-go'];
  sandbox.addModelsForProvider('opencode-go', 'sk-group-old', preset.baseUrl, [
    { model: 'keep-inherit', label: '继承条目' }, { model: 'own-key', label: '自定义钥条目' },
  ]);
  const own = sandbox.getAllModels().find(m => m.name.includes('自定义钥条目'));
  sandbox.updateUserModel(own.id, { apiKey: 'sk-own-override' });
  // 改组密钥：继承的那条跟着换，自定义那条不许被冲掉
  sandbox.saveGroupKey('opencode-go', 'sk-group-new');
  if (sandbox.getModelById(own.id).apiKey !== 'sk-own-override') throw new Error('组密钥覆盖了单条目自有钥');
  const inherit = sandbox.getAllModels().find(m => m.name.includes('继承条目'));
  if (sandbox.getModelById(inherit.id).apiKey !== 'sk-group-new') throw new Error('继承条目未跟随组密钥更新');
  // 清空组密钥：继承条目清空并登记 clearKeys，自定义钥条目保留（且不入清单）
  sandbox.saveGroupKey('opencode-go', '');
  const blob = sandbox._modelsSyncBlob();
  if (!blob.clearKeys.includes(inherit.id)) throw new Error('清空继承条目钥未登记 clearKeys');
  if (blob.clearKeys.includes(own.id)) throw new Error('自定义钥条目不该进清空清单');
  if (sandbox.getModelById(own.id).apiKey !== 'sk-own-override') throw new Error('清空组密钥把自定义钥也清了');
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.localStorage.removeItem('phymathia_active_models');
  return true;
});

check('model-key-guard：回包补钥只填空位（服务端合并后本地镜像自愈）', () => {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.localStorage.removeItem('phymathia_active_models');
  sandbox.loadUserModels();
  const preset = sandbox.window.MODEL_PRESETS.deepseek;
  sandbox.addModelsForProvider('deepseek', '', preset.baseUrl, [{ model: 'm-1', label: '补钥模型' }]);
  const m = sandbox.getAllModels()[0];
  if (sandbox.getModelById(m.id).apiKey) throw new Error('播种条目不该有钥');
  sandbox._applyServerKeyMerge({ modelKeys: { [m.id]: 'sk-restored' }, groupKeys: { deepseek: 'sk-group-restored' } });
  if (sandbox.getModelById(m.id).apiKey !== 'sk-restored') throw new Error('回包补钥未生效');
  if (sandbox.getGroupKey('deepseek') !== 'sk-group-restored') throw new Error('回包组密钥未补回');
  // 本地已有钥不被回包覆盖
  sandbox.updateUserModel(m.id, { apiKey: 'sk-local' });
  sandbox._applyServerKeyMerge({ modelKeys: { [m.id]: 'sk-restored' } });
  if (sandbox.getModelById(m.id).apiKey !== 'sk-local') throw new Error('回包覆盖了本地已有钥');
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.localStorage.removeItem('phymathia_active_models');
  return true;
});


check('model-update：组级更新接线（组头 ↻ 按钮 + 更新弹窗 + diff/应用函数）静态断言', () => {
  for (const t of ['openModelListUpdate', 'refetchModelListUpdate', 'closeModelListUpdate', 'applyModelListUpdate', 'diffUpstreamModels', '_applyModelListDiff', '_fetchModelListForUpdate', 'toggleUmSectionAll', 'model-group-refresh', 'updateModelsDialog']) {
    if (!code.includes(t)) throw new Error('打包产物缺：' + t);
  }
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  for (const id of ['updateModelsDialog', 'umGroupTitle', 'umFetchStatus', 'umFetchBtn', 'umNewSection', 'umNewCount', 'umNewAll', 'umNewList', 'umStaleSection', 'umStaleCount', 'umStaleAll', 'umStaleList', 'umSameNote', 'umApplyBtn']) {
    if (!html.includes(`id="${id}"`)) throw new Error('index.html 缺更新弹窗元素：' + id);
  }
  return true;
});

check('model-add：在线补充段去重（重复点获取不堆「在线获取的补充模型」）', () => {
  const f = sandbox._freshIdsNotListed;
  const listed = ['preset-a', 'preset-b', 'supp-x'];
  // 二次获取同一上游清单：已列出的（预设行 + 上次补充行）全部不再追加
  if (f(listed, ['supp-x', 'new-1', 'preset-a']).join(',') !== 'new-1') {
    throw new Error('应只追加未列出的 new-1: ' + JSON.stringify(f(listed, ['supp-x', 'new-1', 'preset-a'])));
  }
  if (f(listed, ['preset-a', 'supp-x']).length !== 0) throw new Error('全部已列出应为空追加');
  if (f(null, undefined).length !== 0) throw new Error('空输入不应抛错');
  return true;
});

check('model-update：diffUpstreamModels 纯逻辑（新增/已下线/去空白去重/空输入）', () => {
  const d = sandbox.diffUpstreamModels(['a', 'b', 'c'], ['b', 'c', 'd', ' e ']);
  if (d.added.join(',') !== 'd,e') throw new Error('added 不符: ' + JSON.stringify(d.added));
  if (d.removed.join(',') !== 'a') throw new Error('removed 不符: ' + JSON.stringify(d.removed));
  const dup = sandbox.diffUpstreamModels(['x', 'x', 'y'], ['y', 'y', 'z']);
  if (dup.added.join(',') !== 'z' || dup.removed.join(',') !== 'x') throw new Error('去重不符: ' + JSON.stringify(dup));
  const kept = sandbox.diffUpstreamModels(['m1', 'm2'], ['m2', 'm1']);
  if (kept.added.length || kept.removed.length) throw new Error('一致列表应为空 diff: ' + JSON.stringify(kept));
  for (const empty of [sandbox.diffUpstreamModels([], []), sandbox.diffUpstreamModels(null, undefined)]) {
    if (empty.added.length || empty.removed.length) throw new Error('空输入应为空 diff: ' + JSON.stringify(empty));
  }
  return true;
});

// ===== T284（2026-10-11）：模型配置服务端同步 =====
// （含 await 的 model-update 用例已按串行边界契约挪至 serial-models-sync.mjs）
check('models-sync（T284）：同步决策纯函数 adopt/push/none', () => {
  const start = code.indexOf('function _modelsSyncAction');
  if (start < 0) throw new Error('打包产物缺 _modelsSyncAction');
  let depth = 0, end = -1;
  for (let i = code.indexOf('{', start); i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('_modelsSyncAction 花括号配对失败');
  const fn = new Function('return (' + code.slice(start, end) + ');')();
  if (fn(0, 0, true) !== 'push') throw new Error('服务端空＋本地有 → 应 push（首启迁移）');
  if (fn(0, 0, false) !== 'none') throw new Error('双方皆空 → 应 none');
  if (fn(100, 0, false) !== 'adopt') throw new Error('服务端有＋本地无 → 应 adopt（浏览器被清后恢复）');
  if (fn(100, 50, true) !== 'adopt') throw new Error('服务端较新 → 应 adopt');
  if (fn(50, 100, true) !== 'push') throw new Error('本地较新（乐观戳/上传失败）→ 应 push');
  if (fn(100, 100, true) !== 'adopt') throw new Error('时间戳相等 → 应 adopt');
  return true;
});

check('models-sync（T284）：保存出口接同步、启动对齐、导入链路对接', () => {
  if (!code.includes('/api/models/config')) throw new Error('缺同步端点 /api/models/config');
  if (!code.includes('await syncModelsConfigFromServer()')) throw new Error('fetchModels 未先做服务端对齐');
  if (!/function saveUserModels\(\)\{.{0,200}?scheduleModelsSync\(\)/.test(code)) throw new Error('saveUserModels 未调度服务端同步');
  if (!/function persistActiveModels\(\)\{.{0,200}?scheduleModelsSync\(\)/.test(code)) throw new Error('persistActiveModels 未调度服务端同步');
  if (!code.includes('refreshModelsIfServerNewer')) throw new Error('缺切回标签页对齐');
  if (!code.includes('importModelGroupKeys')) throw new Error('备份导入未接组密钥合并');
  if (!code.includes('reloadModelsFromStorage')) throw new Error('导入后未把内存拉回最新');
  return true;
});

check('models-sync（T284）：快照导出补收组密钥、导入刷新前 flush', () => {
  if (!/modelGroupKeys\s*[:,]/.test(code)) throw new Error('快照导出未收集组密钥');
  if (!code.includes('await flushModelsSync()')) throw new Error('导入刷新前未 flush 模型配置');
  return true;
});

check('models-sync（T284）：_adoptModelsConfig 采纳服务端 blob 并镜像本地', () => {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.localStorage.removeItem('phymathia_active_models');
  sandbox.localStorage.removeItem('phymathia_models_synced_at');
  sandbox.loadUserModels();
  const ok = sandbox._adoptModelsConfig({
    userModels: [{ id: 'm_sync1', provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-sync' }],
    modelGroupKeys: { deepseek: 'sk-group-sync' },
    activeModels: { agent_model: 'm_sync1', html_model: '', descriptor_model: '', quiz_model: '', graph_model: '', branch_model: '' },
    updatedAt: 1728600000,
  });
  if (!ok) throw new Error('合法 blob 应被采纳');
  if (sandbox.getAllModels().length !== 1) throw new Error('条目未进内存');
  if (sandbox.localStorage.getItem('phymathia_user_models').indexOf('sk-sync') < 0) throw new Error('条目未镜像 localStorage');
  if (JSON.parse(sandbox.localStorage.getItem('phymathia_model_group_keys')).deepseek !== 'sk-group-sync') throw new Error('组密钥未镜像');
  if (JSON.parse(sandbox.localStorage.getItem('phymathia_active_models')).agent_model !== 'm_sync1') throw new Error('槽位未镜像');
  sandbox._stampSynced(1728600000);
  if (sandbox.localStorage.getItem('phymathia_models_synced_at') !== '1728600000') throw new Error('同步戳未落地');
  if (sandbox._adoptModelsConfig(null) !== false) throw new Error('非法 blob 应拒绝');
  // 清场（这些键共享沙箱 storage，别漏给后续用例）
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.localStorage.removeItem('phymathia_active_models');
  sandbox.localStorage.removeItem('phymathia_models_synced_at');
  return true;
});

// T375（2026-10-23）：viz iframe 视口门控——loading="lazy" 拦不住 srcdoc（属性只
// 管 src 导航），旧版会话恢复即全量执行全部可视化的脚本。行为用例在隔离 vm 里
// 跑挂载段真码：观察器模式下未进视口只挂壳、进视口才写 srcdoc 并摘两属性；
// force（离屏序列化）与无 IO 环境立即挂载。
check('viz-mount（T375）：进视口才写 srcdoc＋force/无IO 立即挂载', () => {
  const src = fs.readFileSync(new URL('../../src/static/js/render.js', import.meta.url), 'utf8');
  const em = src.match(/'<iframe class="viz-iframe[\s\S]*?iframe>'/);
  if (!em) throw new Error('找不到 viz iframe 发射串（buildVizCard 结构变了？）');
  if (/loading=/.test(em[0])) throw new Error('iframe 发射串仍带 loading=——该属性拦不住 srcdoc，留着只会误导');
  const gcSrc = fs.readFileSync(new URL('../../src/static/js/graph-custom.js', import.meta.url), 'utf8');
  if (!gcSrc.includes('_initVizIframes(holder, { force: true })')) {
    throw new Error('离屏序列化路径未走 force——holder 永不进视口，srcdoc 会永不落定');
  }
  const start = src.indexOf('// 延迟挂载 viz iframe');
  const end = src.indexOf('function _ensureVizFullscreenOverlay');
  if (start < 0 || end < 0 || end < start) throw new Error('挂载段定位失败（render.js 结构变了？）');
  const mountCode = src.slice(start, end);
  const mkIframe = (id) => ({
    _attrs: { 'data-viz-id': id },
    _srcdoc: null,
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
    set srcdoc(v) { this._srcdoc = v; },
    get srcdoc() { return this._srcdoc; },
  });
  const mkCtx = (withIO) => {
    const s = {
      console: { log() {}, error() {} },
      _vizStore: { viz_a: '<html>A</html>', viz_b: '<html>B</html>' },
    };
    if (withIO) {
      s._ioInstances = [];
      s.IntersectionObserver = function (cb, opts) {
        this.cb = cb; this.opts = opts;
        this.observe = () => {};
        this.unobserve = () => {};
        this.disconnect = () => {};
        s._ioInstances.push(this);
      };
    }
    s.window = s;
    vm.createContext(s);
    vm.runInContext(mountCode, s);
    return s;
  };
  // ① 观察器模式：壳挂 data-viz-pending、不写 srcdoc；进视口写并摘两属性
  const a = mkCtx(true);
  const fA = mkIframe('viz_a'), fB = mkIframe('viz_b');
  a.holder = { querySelectorAll: () => [fA, fB] };
  vm.runInContext('_initVizIframes(holder)', a);
  if (fA.getAttribute('data-viz-pending') !== '1' || fB.getAttribute('data-viz-pending') !== '1') throw new Error('未进视口应挂 data-viz-pending 壳');
  if (fA.srcdoc !== null || fB.srcdoc !== null) throw new Error('未进视口不得写 srcdoc');
  const io = a._ioInstances[0];
  if (!io || !/400px/.test(io.opts.rootMargin)) throw new Error('观察器缺预载边距 rootMargin');
  io.cb([{ isIntersecting: true, target: fA }]);
  if (fA.srcdoc !== '<html>A</html>' || fA.getAttribute('data-viz-id') !== null || fA.getAttribute('data-viz-pending') !== null) throw new Error('进视口应写 srcdoc 并摘 data-viz-id/pending');
  if (fB.srcdoc !== null) throw new Error('未进视口的 B 不该被写');
  // ② force：序列化路径立即全量挂载
  vm.runInContext('_initVizIframes(holder, { force: true })', a);
  if (fB.srcdoc !== '<html>B</html>') throw new Error('force 应立即挂载 B');
  // ③ 无 IntersectionObserver：回退立即挂载（行为同旧版，老内核/沙箱不受损）
  const b = mkCtx(false);
  const fC = mkIframe('viz_a');
  b.holder = { querySelectorAll: () => [fC] };
  vm.runInContext('_initVizIframes(holder)', b);
  if (fC.srcdoc !== '<html>A</html>') throw new Error('无 IO 环境应回退立即挂载');
  // 待载态提示样式在位（:has 不可用的老内核自动退化为空壳，可接受）
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!css.includes('.viz-card:has(iframe[data-viz-pending])::after')) throw new Error('缺待载态提示样式');
  return true;
});
}
