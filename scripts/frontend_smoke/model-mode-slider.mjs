// 模型面板 简略/详细模式＋思考强度滑块（2026-10-25 建，同日滑块重做同步改）：
// 统一写入/快照三态/档位序（去「默认」档、按族给真实档）/显示回退/滑块组件沙箱实跑/
// DOM·CSS·构建·源码契约。纯同步域文件（不 await）。
// 排在 models-viz 与 serial-models-sync 之后（models 域既有段先跑完），自播自收、
// 收尾清掉本轮写的 localStorage 键并把 activeModels 复位为空对象，不污染后续域。
import fs from 'node:fs';
import { check, sandbox } from './_runner.mjs';

const html = fs.readFileSync('src/static/index.html', 'utf8');
const cssPanels = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
const modelsSrc = fs.readFileSync('src/static/js/models.js', 'utf8');
const buildSrc = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');

export function run() {
  check('model-mode：默认简略模式（无记录=simple）＋applyModelPanelMode 落盘模式键', () => {
    sandbox.localStorage.removeItem('phymathia_model_config_mode');
    sandbox.localStorage.removeItem('phymathia_model_detail_snapshot');
    if (sandbox.getModelPanelMode() !== 'simple') throw new Error('无记录应默认 simple');
    sandbox.applyModelPanelMode('detail');
    if (sandbox.getModelPanelMode() !== 'detail') throw new Error('applyModelPanelMode 应落盘 detail');
    sandbox.applyModelPanelMode('simple');
    if (sandbox.getModelPanelMode() !== 'simple') throw new Error('applyModelPanelMode 应落盘 simple');
    return true;
  });

  check('model-mode：createThinkingSlider 沙箱实跑（构造/setOptions/setValue 往返/setDisabled 不抛错）', () => {
    const mount = sandbox.document.createElement('div');
    const slider = sandbox.createThinkingSlider(mount, { options: [], value: '' });
    if (!slider || typeof slider.setOptions !== 'function' || typeof slider.getValue !== 'function') {
      throw new Error('滑块 API 缺失（setOptions/getValue）');
    }
    slider.setOptions([
      { value: 'off', short: '关', title: '强制关闭思考' },
      { value: 'low', short: '低', title: '低强度思考' },
      { value: 'medium', short: '中', title: '中等强度思考' },
      { value: 'high', short: '高', title: '高强度思考' },
    ]);
    slider.setValue('high');
    if (slider.getValue() !== 'high') throw new Error('setValue/getValue 往返失败');
    slider.setValue('不存在的档');
    if (slider.getValue() !== '') throw new Error('无效档位应回落空值');
    slider.setDisabled(true);
    return true;
  });

  check('model-mode：滑块档位序——effort 关→低→中→高；布尔 关→开；智谱5.x 低→高→最高（无关）；graph 首档「自动」', () => {
    const e = sandbox._thinkingSliderEntries(sandbox._thinkingOptionsFor('deepseek', 'agent'));
    if (e.map(o => o.value).join(',') !== 'off,low,medium,high,max') throw new Error('effort 序错：' + e.map(o => o.value).join(','));
    if (e.map(o => o.short).join(',') !== '关,低,中,高,最高') throw new Error('effort 短标签错：' + e.map(o => o.short).join(','));
    const b = sandbox._thinkingSliderEntries(sandbox._thinkingOptionsFor('mimo', 'agent'));
    if (b.map(o => o.value).join(',') !== 'off,on') throw new Error('布尔序错：' + b.map(o => o.value).join(','));
    if (b.map(o => o.short).join(',') !== '关,开') throw new Error('布尔短标签错：' + b.map(o => o.short).join(','));
    const z5 = sandbox._thinkingSliderEntries(sandbox._thinkingOptionsFor('zhipu', 'agent', 'glm-5.3-flash'));
    if (z5.map(o => o.value).join(',') !== 'low,high,max') throw new Error('智谱5.x 序错：' + z5.map(o => o.value).join(','));
    if (z5.map(o => o.short).join(',') !== '低,高,最高') throw new Error('智谱5.x 短标签错：' + z5.map(o => o.short).join(','));
    const z4 = sandbox._thinkingSliderEntries(sandbox._thinkingOptionsFor('zhipu', 'agent', 'glm-4.7'));
    if (z4.map(o => o.value).join(',') !== 'off,on') throw new Error('智谱旧代应走布尔族：' + z4.map(o => o.value).join(','));
    const g = sandbox._thinkingSliderEntries(sandbox._thinkingOptionsFor('deepseek', 'graph'));
    if (g[0].value !== '' || g[0].short !== '自动') throw new Error('graph 首档应为「自动」（Φ 按钮可覆盖）');
    return true;
  });

  check('model-mode：显示回退 _thinkingDisplayValue——空值回族默认档、旧档就近改写、有效档原样', () => {
    const D = sandbox._thinkingDisplayValue;
    const effort = sandbox._thinkingSliderEntries(sandbox._thinkingOptionsFor('deepseek', 'agent'));
    const bool = sandbox._thinkingSliderEntries(sandbox._thinkingOptionsFor('mimo', 'agent'));
    const z5 = sandbox._thinkingSliderEntries(sandbox._thinkingOptionsFor('zhipu', 'agent', 'glm-5.3'));
    const graph = sandbox._thinkingSliderEntries(sandbox._thinkingOptionsFor('deepseek', 'graph'));
    if (D('', effort) !== 'medium') throw new Error('effort 空值应显示中（OpenAI 默认档）');
    if (D('', bool) !== 'on') throw new Error('布尔空值应显示开（GLM 默认开）');
    if (D('', z5) !== 'max') throw new Error('智谱5.x 空值应显示最高（官方默认 max）');
    if (D('', graph) !== '') throw new Error('graph 空值＝自动，应原样保留');
    if (D('max', effort) !== 'max') throw new Error('max 是 effort 族正式档，应原样返回');
    if (D('low', bool) !== 'on') throw new Error('旧 low 档在布尔族应归一为开');
    if (D('high', bool) !== 'on') throw new Error('旧 high 档在布尔族应归一为开');
    if (D('on', z5) !== 'max') throw new Error('旧 on 档在智谱5.x 应归一为最高');
    if (D('off', z5) !== 'low') throw new Error('关不掉思考时 off 应就近到低');
    if (D('high', effort) !== 'high') throw new Error('有效档应原样返回');
    return true;
  });

  check('model-mode：applyUnifiedConfig 首写＝六槽模型与思考统一＋快照存住原详细配置', () => {
    sandbox.localStorage.removeItem('phymathia_user_models');
    sandbox.localStorage.removeItem('phymathia_model_group_keys');
    sandbox.localStorage.removeItem('phymathia_active_models');
    sandbox.localStorage.removeItem('phymathia_model_detail_snapshot');
    sandbox.loadUserModels();
    const preset = sandbox.window.MODEL_PRESETS.deepseek;
    if (!preset || !preset.baseUrl) throw new Error('deepseek 预设应存在');
    const seeded = sandbox.addModelsForProvider('deepseek', 'sk-x', preset.baseUrl, [
      { model: 'deepseek-chat', label: 'DS Chat' },
      { model: 'deepseek-reasoner', label: 'DS Reasoner' },
    ]);
    if (seeded !== 2) throw new Error('播种 2 条应全部入库，实际 ' + seeded);
    const all = sandbox.getAllModels();
    const m1 = all[0].id, m2 = all[1].id;
    // 模拟详细模式下的分散配置：三槽指各自模型、思考档各异（branch 也配自己的模型——
    // getSlotThinkingForRole 在槽空时按语义回主槽思考，还原断言须打在「自有模型」的槽上）
    sandbox.localStorage.setItem('phymathia_active_models', JSON.stringify({
      agent_model: m1, html_model: m2, graph_model: '', branch_model: m2, descriptor_model: '', quiz_model: '',
      agent_thinking: 'max', html_thinking: 'off', graph_thinking: '', branch_thinking: 'high', descriptor_thinking: '', quiz_thinking: 'low',
    }));
    sandbox.reloadModelsFromStorage();
    if (!sandbox.getActiveModelForRole('html') || sandbox.getActiveModelForRole('html').id !== m2) {
      throw new Error('播种态应就位（html 槽指向 m2）');
    }
    const changed = sandbox.applyUnifiedConfig(m1, 'high');
    if (changed !== true) throw new Error('统一写入应返回 true');
    for (const role of ['agent', 'html', 'graph', 'branch', 'descriptor', 'quiz']) {
      const m = sandbox.getActiveModelForRole(role);
      if (!m || m.id !== m1) throw new Error(role + ' 槽模型应统一为 m1');
      if (sandbox.getSlotThinkingForRole(role) !== 'high') throw new Error(role + ' 槽思考应统一为 high');
    }
    const snap = JSON.parse(sandbox.localStorage.getItem('phymathia_model_detail_snapshot') || 'null');
    if (!snap || !snap.models || snap.models.html_model !== m2 || snap.models.agent_model !== m1) {
      throw new Error('快照应存住统一前的详细模型配置');
    }
    if (snap.thinking.agent_thinking !== 'max' || snap.thinking.html_thinking !== 'off' || snap.thinking.quiz_thinking !== 'low') {
      throw new Error('快照应存住统一前的各槽思考档');
    }
    return true;
  });

  check('model-mode：二次统一写入不覆盖快照（快照＝首次写入前的详细配置）', () => {
    const before = sandbox.localStorage.getItem('phymathia_model_detail_snapshot');
    if (!before) throw new Error('前置态丢失：快照应已存在');
    if (sandbox.applyUnifiedConfig(sandbox.getActiveModelForRole('agent').id, 'low') !== true) {
      throw new Error('改档位应真写入');
    }
    if (sandbox.getSlotThinkingForRole('html') !== 'low') throw new Error('六槽思考应统一为 low');
    if (sandbox.localStorage.getItem('phymathia_model_detail_snapshot') !== before) {
      throw new Error('快照不应被二次写入覆盖');
    }
    return true;
  });

  check('model-mode：切回详细模式自动还原快照并清快照键', () => {
    sandbox.applyModelPanelMode('detail');
    const all = sandbox.getAllModels();
    const m2 = all[1].id;
    if (!sandbox.getActiveModelForRole('html') || sandbox.getActiveModelForRole('html').id !== m2) {
      throw new Error('详细模式应还原统一前的各槽模型（html=m2）');
    }
    if (!sandbox.getActiveModelForRole('branch') || sandbox.getActiveModelForRole('branch').id !== m2) {
      throw new Error('详细模式应还原统一前的各槽模型（branch=m2）');
    }
    if (sandbox.getSlotThinkingForRole('agent') !== 'max') throw new Error('agent 思考应还原为 max');
    if (sandbox.getSlotThinkingForRole('html') !== 'off') throw new Error('html 思考应还原为 off');
    if (sandbox.getSlotThinkingForRole('branch') !== 'high') throw new Error('branch 思考应还原为 high');
    if (sandbox.localStorage.getItem('phymathia_model_detail_snapshot') !== null) {
      throw new Error('还原后快照键应清掉');
    }
    return true;
  });

  check('model-mode：换族无效存量档语义就近改写落盘（布尔族遇旧 max 归一为 on）', () => {
    const mimoPreset = sandbox.window.MODEL_PRESETS.mimo;
    if (!mimoPreset || !mimoPreset.baseUrl) throw new Error('mimo 预设应存在');
    sandbox.addModelsForProvider('mimo', 'sk-m', mimoPreset.baseUrl, [{ model: 'MiMo-Flash', label: 'MiMo Flash' }]);
    const mimoId = sandbox.getAllModels().filter(m => m.name.includes('MiMo'))[0].id;
    sandbox.localStorage.setItem('phymathia_active_models', JSON.stringify({ agent_model: mimoId, agent_thinking: 'max' }));
    sandbox.reloadModelsFromStorage();
    sandbox._refreshSlotThinkingSelect('agent');
    if (sandbox.getSlotThinkingForRole('agent') !== 'on') throw new Error('旧 max 档在布尔族应语义等价改写为 on');
    if (JSON.parse(sandbox.localStorage.getItem('phymathia_active_models')).agent_thinking !== 'on') {
      throw new Error('归一结果应落盘');
    }
    return true;
  });

  check('model-mode：智谱5.x 槽——on 档改写为 max、空值显示最高但不落盘（不发参数语义保留）', () => {
    const zid = 'model-smoke-zhipu-5x';
    sandbox.localStorage.setItem('phymathia_user_models', JSON.stringify([{
      id: zid, provider: 'zhipu', model: 'glm-5.3', label: 'GLM-5.3', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    }]));
    sandbox.localStorage.setItem('phymathia_active_models', JSON.stringify({ agent_model: zid, agent_thinking: 'on' }));
    sandbox.reloadModelsFromStorage();
    sandbox._refreshSlotThinkingSelect('agent');
    if (sandbox.getSlotThinkingForRole('agent') !== 'max') throw new Error('旧 on 档在智谱5.x 应语义等价改写为 max');
    // 空值路径：显示回退到 max，但存储保持 ''（不发参数的语义不动，用户拖动才真写）
    sandbox.localStorage.setItem('phymathia_active_models', JSON.stringify({ agent_model: zid, agent_thinking: '' }));
    sandbox.reloadModelsFromStorage();
    sandbox._refreshSlotThinkingSelect('agent');
    if (JSON.parse(sandbox.localStorage.getItem('phymathia_active_models')).agent_thinking !== '') {
      throw new Error('空值不应被显示回退改写落盘');
    }
    return true;
  });

  check('model-mode：DOM 契约——七滑块挂载点＋模式钮＋统一控件接线＋思考下拉无残留 onchange', () => {
    for (const role of ['agent', 'html', 'graph', 'branch', 'descriptor', 'quiz']) {
      if (!html.includes(`class="thinking-slider-mount" id="${role}ModelThinking"`)) {
        throw new Error('槽位滑块挂载点缺失：' + role);
      }
    }
    if (!html.includes('id="unifiedThinkingSlider"')) throw new Error('简略模式统一滑块挂载点缺失');
    if (!html.includes('id="unifiedModelSelect"')) throw new Error('统一模型下拉缺失');
    if (!html.includes('id="unifiedModelDesc"') || !html.includes('id="unifiedModelTags"')) throw new Error('统一模型 meta 缺失');
    if (!html.includes('id="modelModeBtnSimple"') || !html.includes('id="modelModeBtnDetail"')) throw new Error('模式切换按钮缺失');
    if (!html.includes("onclick=\"setModelPanelMode('simple')\"") || !html.includes("onclick=\"setModelPanelMode('detail')\"")) {
      throw new Error('模式切换按钮接线缺失');
    }
    if (!html.includes('onchange="onUnifiedModelChange(this.value)"')) throw new Error('统一下拉接线缺失');
    if (/onchange="onSlotThinkingChange\(/.test(html)) throw new Error('思考下拉 onchange 残留（已迁滑块回调）');
    if (html.includes('model-thinking-select')) throw new Error('思考下拉类名残留');
    return true;
  });

  check('model-mode：CSS 契约——最大档三件套 keyframes＋accent 派生渐变＋滑块/模式样式', () => {
    for (const kf of ['ts-sheen-flow', 'ts-orb-pulse', 'ts-ring-burst', 'ts-spark-fly', 'ts-thumb-pop', 'ts-fill-surge']) {
      if (!cssPanels.includes('@keyframes ' + kf)) throw new Error('缺 keyframes：' + kf);
    }
    for (const cls of [
      '.thinking-slider-track', '.thinking-slider-fill', '.thinking-slider-thumb',
      '.thinking-slider-ticks', '.thinking-slider-dot', '.thinking-slider-spark',
      '.thinking-slider-fill::after', '.thinking-slider-thumb::after', '.thinking-slider-thumb::before',
      '.model-thinking-caption .ts-value',
      '.model-mode-switch', '.model-mode-btn',
      '.model-panel.mode-simple .model-simple-section', '.model-panel.mode-simple .model-detail-section',
    ]) {
      if (!cssPanels.includes(cls)) throw new Error('缺样式：' + cls);
    }
    // 防回潮：ZCode 绿（#22c55e 不随主题走，2026-10-25 用户拍板换 accent 族）、白气泡
    // 横漂、旧版标签行/旧彩蛋名、切换式渐变 ::before 一律不许再出现
    for (const dead of ['--ts-green', 'ts-bubble-flow', '.thinking-slider-bubble', '.thinking-slider-label', '.thinking-slider-ring', 'ts-celebrate', 'ts-breathe', '.thinking-slider-fill::before']) {
      if (cssPanels.includes(dead)) throw new Error('旧样式/旧彩蛋残留：' + dead);
    }
    if (!cssPanels.includes('linear-gradient(90deg, color-mix(in srgb, var(--accent) 40%, transparent), var(--accent) 55%, var(--accent-hover))')) {
      throw new Error('填充渐变应全 accent 族派生（用户拍板：绿不随主题走、违和）');
    }
    // 居中不变量：thumb 定位父级是 22px 轨道，top 必须是 (22−28)/2 = -3px
    const thumbRule = cssPanels.match(/\.thinking-slider-thumb \{[^}]*\}/);
    if (!thumbRule || !/top: -3px/.test(thumbRule[0])) {
      throw new Error('拇指 top 应为 -3px（相对 22px 轨道居中；实踩 +2px 偏下 5px）');
    }
    return true;
  });

  check('model-mode：构建契约——thinking-slider.js 已注册 entries 且位于 models.js 之前', () => {
    const a = buildSrc.indexOf("'thinking-slider.js'");
    const b = buildSrc.indexOf("'models.js'");
    if (a === -1) throw new Error('entries 未注册 thinking-slider.js');
    if (b === -1 || a > b) throw new Error('thinking-slider.js 应注册在 models.js 之前');
    return true;
  });

  check('model-mode：源码契约——模式/快照键带 phymathia_ 前缀＋滑块回调接线＋旧下拉渲染清除＋刻度重建', () => {
    if (!modelsSrc.includes("'phymathia_model_config_mode'") || !modelsSrc.includes("'phymathia_model_detail_snapshot'")) {
      throw new Error('模式/快照键未带 phymathia_ 前缀');
    }
    if (!modelsSrc.includes('_ensureThinkingSliderOn(mount, v => onSlotThinkingChange(role, v))')) {
      throw new Error('槽位滑块 onChange 接线缺失');
    }
    if (!modelsSrc.includes('_ensureThinkingSliderOn(mount, v => onUnifiedThinkingChange(v))')) {
      throw new Error('统一滑块 onChange 接线缺失');
    }
    if (modelsSrc.includes('select.innerHTML = options.map')) throw new Error('旧思考下拉选项渲染残留');
    // 刻度重建：setOptions 必须调 _renderTicks（换族重建档点；2026-10-25 真机首验教训）
    const tsSrc = fs.readFileSync('src/static/js/thinking-slider.js', 'utf8');
    if (!tsSrc.includes('function _renderTicks')) throw new Error('_renderTicks 定义缺失');
    if (!/setOptions\(list\) \{[\s\S]*?_renderTicks\(\);/.test(tsSrc)) throw new Error('setOptions 未重建档位刻度');
    if (!tsSrc.includes("contains('model-thinking-caption')")) throw new Error('档值文字应注入前置标题行');
    // 最大档一击动画接线：类名驱动＋animationend 自摘（零计时器，节奏只活在 CSS）
    if (!tsSrc.includes("'ts-burst'")) throw new Error('ts-burst 类名接线缺失');
    if (!tsSrc.includes("animationName === 'ts-thumb-pop'")) throw new Error('一击自摘应锚定 ts-thumb-pop 的 animationend');
    if (!tsSrc.includes('thinking-slider-spark')) throw new Error('爆发粒子创建缺失');
    return true;
  });

  check('model-mode：收尾清理——本轮键不残留、activeModels 复位，不污染后续域', () => {
    for (const k of ['phymathia_model_config_mode', 'phymathia_model_detail_snapshot', 'phymathia_active_models', 'phymathia_user_models', 'phymathia_model_group_keys']) {
      sandbox.localStorage.removeItem(k);
    }
    sandbox.localStorage.setItem('phymathia_active_models', JSON.stringify({}));
    sandbox.reloadModelsFromStorage();
    return true;
  });
}
