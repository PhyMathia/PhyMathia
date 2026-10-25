// 模型面板 简略/详细模式＋思考强度滑块（2026-10-25）：统一写入/快照三态/档位序/
// 滑块组件沙箱实跑/DOM·CSS·构建·源码契约。纯同步域文件（不 await）。
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
      { value: '', short: '默认', title: '跟随模型默认' },
      { value: 'max', short: '最深', title: '最高强度思考' },
    ]);
    slider.setValue('max');
    if (slider.getValue() !== 'max') throw new Error('setValue/getValue 往返失败');
    slider.setValue('');
    if (slider.getValue() !== '') throw new Error('回「跟随默认」失败');
    slider.setValue('不存在的档');
    if (slider.getValue() !== '') throw new Error('无效档位应回落「跟随默认」');
    slider.setDisabled(true);
    return true;
  });

  check('model-mode：滑块档位序——effort 关→默认→浅→深→最深；布尔 关→默认→开；graph 档叫「自动」', () => {
    const e = sandbox._thinkingSliderEntries(sandbox._thinkingOptionsFor('deepseek'), 'agent');
    if (e.map(o => o.value).join(',') !== 'off,,low,high,max') throw new Error('effort 序错：' + e.map(o => o.value).join(','));
    if (e.map(o => o.short).join(',') !== '关,默认,浅,深,最深') throw new Error('effort 短标签错：' + e.map(o => o.short).join(','));
    const b = sandbox._thinkingSliderEntries(sandbox._thinkingOptionsFor('mimo'), 'agent');
    if (b.map(o => o.value).join(',') !== 'off,,on') throw new Error('布尔序错：' + b.map(o => o.value).join(','));
    if (b.map(o => o.short).join(',') !== '关,默认,开') throw new Error('布尔短标签错：' + b.map(o => o.short).join(','));
    const g = sandbox._thinkingSliderEntries(sandbox._thinkingOptionsFor('deepseek', 'graph'), 'graph');
    if (g[1].short !== '自动') throw new Error('graph 默认档短标签应为「自动」（Φ 按钮可覆盖）');
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

  check('model-mode：换族无效存量档回「跟随默认」并落盘（布尔族遇 effort 档 max）', () => {
    const mimoPreset = sandbox.window.MODEL_PRESETS.mimo;
    if (!mimoPreset || !mimoPreset.baseUrl) throw new Error('mimo 预设应存在');
    sandbox.addModelsForProvider('mimo', 'sk-m', mimoPreset.baseUrl, [{ model: 'MiMo-Flash', label: 'MiMo Flash' }]);
    const mimoId = sandbox.getAllModels().filter(m => m.name.includes('MiMo'))[0].id;
    sandbox.localStorage.setItem('phymathia_active_models', JSON.stringify({ agent_model: mimoId, agent_thinking: 'max' }));
    sandbox.reloadModelsFromStorage();
    sandbox._refreshSlotThinkingSelect('agent');
    if (sandbox.getSlotThinkingForRole('agent') !== '') throw new Error('effort 档 max 在布尔族下应回「跟随默认」');
    if (JSON.parse(sandbox.localStorage.getItem('phymathia_active_models')).agent_thinking !== '') {
      throw new Error('归一结果应落盘');
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

  check('model-mode：CSS 契约——ts-* 四 keyframes＋滑块/模式样式＋面板显隐规则', () => {
    for (const kf of ['ts-thumb-glow', 'ts-ring-burst', 'ts-spark-rise', 'ts-breathe']) {
      if (!cssPanels.includes('@keyframes ' + kf)) throw new Error('缺 keyframes：' + kf);
    }
    for (const cls of [
      '.thinking-slider-track', '.thinking-slider-fill', '.thinking-slider-thumb', '.thinking-slider-ring',
      '.thinking-slider-dot', '.thinking-slider-label', '.thinking-slider-spark',
      '.model-mode-switch', '.model-mode-btn',
      '.model-panel.mode-simple .model-simple-section', '.model-panel.mode-simple .model-detail-section',
    ]) {
      if (!cssPanels.includes(cls)) throw new Error('缺样式：' + cls);
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
    // 刻度重建：setOptions 必须调 _renderTicks（2026-10-25 真机首验漏渲染点/标签行教训）
    const tsSrc = fs.readFileSync('src/static/js/thinking-slider.js', 'utf8');
    if (!tsSrc.includes('function _renderTicks')) throw new Error('_renderTicks 定义缺失');
    if (!/setOptions\(list\) \{[\s\S]*?_renderTicks\(\);/.test(tsSrc)) throw new Error('setOptions 未重建档位刻度（点/标签行）');
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
