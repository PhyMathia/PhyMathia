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
  for (const p of ['zhipu', 'moonshot', 'dashscope', 'bigmodel', 'minimaxi', 'siliconflow', 'generativelanguage', 'anthropic', 'openrouter', 'groq', '11434', '1234']) {
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

// ===== 组级「更新模型列表」（组头 ↻ → 上游 diff → 勾选应用） =====
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

check('model-update：_applyModelListDiff（新增入库 + 移除条目 + 悬空槽位清理 + 幂等）', () => {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.localStorage.removeItem('phymathia_active_models');
  sandbox.loadUserModels();
  const goPreset = sandbox.window.MODEL_PRESETS['opencode-go'];
  const seeded = sandbox.addModelsForProvider('opencode-go', 'sk-upd', goPreset.baseUrl, [
    { model: 'm-keep', label: '保留模型' }, { model: 'm-stale', label: '已下线模型' },
  ]);
  if (seeded !== 2) throw new Error('播种 2 条应全部入库，实际 ' + seeded);
  const stale = sandbox.getAllModels().find(m => m.provider === 'opencode-go' && m.name.includes('已下线模型'));
  if (!stale) throw new Error('播种条目未找到');
  // 主模型槽位指向将被移除的条目，应用后必须被清空（deleteUserModel 的悬空引用清理）
  sandbox.localStorage.setItem('phymathia_active_models', JSON.stringify({ agent_model: stale.id, html_model: '', descriptor_model: '', quiz_model: '', graph_model: '', branch_model: '' }));
  sandbox.fetchModels(); // 异步签名但函数体全同步：直接调用即完成槽位装载
  const res = sandbox._applyModelListDiff('opencode-go', goPreset.baseUrl, [{ model: 'm-new', label: '上游新增' }], ['m-stale']);
  if (res.added !== 1 || res.removed !== 1) throw new Error('应用结果不符: ' + JSON.stringify(res));
  const names = sandbox.getAllModels().filter(m => m.provider === 'opencode-go').map(m => m.name);
  if (names.length !== 2) throw new Error('应用后应剩 2 条: ' + names.join(','));
  if (!names.some(s => s.includes('保留模型')) || !names.some(s => s.includes('上游新增'))) throw new Error('保留/新增条目缺失: ' + names.join(','));
  if (JSON.parse(sandbox.localStorage.getItem('phymathia_active_models')).agent_model !== '') throw new Error('指向已移除条目的槽位未清空');
  const again = sandbox._applyModelListDiff('opencode-go', goPreset.baseUrl, [{ model: 'm-new', label: '上游新增' }], ['m-stale']);
  if (again.added !== 0 || again.removed !== 0) throw new Error('重复应用应零变更: ' + JSON.stringify(again));
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.localStorage.removeItem('phymathia_active_models');
  return true;
});
}
