// 演示前两批（T45/T49/T52/T60/T70＋T69/T68 画布渲染性能）
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 7598–7706 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
// ===== 演示前第一批：T45/T49/T52/T60/T70（2026-10-01）=====
// 全部为静态源断言（同步、不碰共享键），追加在串行边界之后安全。
{
  const qcheck = (name, fn) => {
    try {
      const r = fn();
      if (r === false) { addFailed(); console.error('❌', name, '-> 断言未通过'); }
      else console.log('✓', name);
    } catch (e) {
      addFailed(); console.error('❌', name, '->', (e && e.message) || e);
    }
  };
  const uiSrc = fs.readFileSync('src/static/js/ui.js', 'utf8');
  const sessSrc = fs.readFileSync('src/static/js/session.js', 'utf8');
  const contSrc = readContinentSrc();
  const modelsSrc = fs.readFileSync('src/static/js/models.js', 'utf8');
  const idxHtml = fs.readFileSync('src/static/index.html', 'utf8');
  const stylesCss = fs.readFileSync('src/static/css/styles.css', 'utf8');
  const panelsCss = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');

  qcheck('T45：resize 不再静默关浮动面板，面板按触发按钮重定位', () => {
    if (uiSrc.includes('Close floating panels on resize to avoid mispositioning')) throw new Error('旧的「resize 一律关面板」还在');
    // 2026-10-02 第二轮起 skinPanel/bgPanel 并入 themePanel，另加两个收纳小菜单
    for (const pid of ['modelPanel', 'dataPanel', 'levelPanel', 'themePanel', 'knowledgeMenu', 'moreMenu']) {
      if (!uiSrc.includes(`_repositionShownPanel('${pid}'`)) throw new Error('缺重定位：' + pid);
    }
    if (!uiSrc.includes("panel.classList.contains('show')")) throw new Error('重定位前未判面板打开态');
    return true;
  });

  qcheck('T49：大陆顶栏补「⌂ 适配 / ⤢ 全屏」手动手柄＋全屏态样式', () => {
    if (!contSrc.includes('id="continentFitBtn"')) throw new Error('缺适配按钮');
    if (!contSrc.includes('id="continentFullBtn"')) throw new Error('缺全屏按钮');
    if (!contSrc.includes('_continentToggleFullscreen') || !contSrc.includes('_continentSyncFullBtn')) throw new Error('缺全屏切换/文案同步函数');
    if (!panelsCss.includes('.continent-layer:fullscreen')) throw new Error('缺全屏态样式');
    return true;
  });

  qcheck('T52：graph 坏键守卫（对象 sessionId 拦下不落键）＋启动清扫 [object Object]', () => {
    if (!sessSrc.includes('_isBadGraphSid')) throw new Error('缺坏参守卫');
    for (const fn of ['function getGraphState', 'function saveGraphState', 'async function _postGraphState', 'async function _loadGraphStateFromServer', 'async function _deleteGraphStateOnServer']) {
      const i = sessSrc.indexOf(fn);
      if (i < 0) throw new Error('找不到 ' + fn);
      if (!sessSrc.slice(i, i + 400).includes('_isBadGraphSid(sid)')) throw new Error(fn + ' 未挂守卫');
    }
    if (!sessSrc.includes('_sweepCorruptedKeys')) throw new Error('缺启动清扫');
    return true;
  });

  qcheck('T70：_syncFromServer 首请求即探活，不再 _checkServer＋全量拉各一次', () => {
    const i = sessSrc.indexOf('async function _syncFromServer');
    if (i < 0) throw new Error('找不到 _syncFromServer');
    const j = sessSrc.indexOf('const [sessResp', i);
    if (j < 0) throw new Error('找不到 Promise.all 拉取');
    if (sessSrc.slice(i, j).includes('await _checkServer()')) throw new Error('仍先 _checkServer() 探活（/api/sessions 每轮 ×2）');
    return true;
  });

  qcheck('T60：模型探活端点接线＋行内测活按钮＋免费/付费标注样式', () => {
    if (!modelsSrc.includes('/api/models/probe')) throw new Error('前端未接探活端点');
    if (!modelsSrc.includes('probeCheckedPresetModels')) throw new Error('缺批量测活');
    if (!modelsSrc.includes("_probePresetRow(this,'${opts.probe}')") || !modelsSrc.includes("probe: 'update'")) throw new Error('更新弹窗新增行缺测活按钮');
    if (!idxHtml.includes('presetProbeBtn')) throw new Error('添加弹窗缺「测活勾选项」按钮');
    if (!stylesCss.includes('.am-probe-state')) throw new Error('缺探活徽标样式');
    if (!stylesCss.includes('.am-model-free')) throw new Error('缺免费/付费标注样式');
    return true;
  });
}

// ===== 演示前第二批：T69/T68 画布渲染性能（2026-10-01）=====
{
  const qcheck = (name, fn) => {
    try {
      const r = fn();
      if (r === false) { addFailed(); console.error('❌', name, '-> 断言未通过'); }
      else console.log('✓', name);
    } catch (e) {
      addFailed(); console.error('❌', name, '->', (e && e.message) || e);
    }
  };
  const grSrc = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
  const giSrc = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  const gwSrc = fs.readFileSync('src/static/js/graph-workflow.js', 'utf8');

  qcheck('T69：KaTeX 可视性分档（屏外不铺公式进视口补铺）＋折叠跳内容子树', () => {
    if (!grSrc.includes('function _graphKatexVisiblePass') || !grSrc.includes('function _minimizedBodyHtml')) throw new Error('缺 T69 助手');
    if (!grSrc.includes('function _graphKatexCaptureByIds')) throw new Error('缺按实铺节点回填渲染记忆');
    if (!giSrc.includes('_graphKatexVisiblePass()')) throw new Error('重建 rAF 未接可视性分档');
    const raf = giSrc.indexOf('requestAnimationFrame(() => {');
    if (raf < 0) throw new Error('找不到重建 rAF');
    if (!giSrc.slice(raf, raf + 400).includes('else if (typeof renderMath')) throw new Error('rAF 缺老路径兜底');
    const phCount = (grSrc.match(/_minimizedBodyHtml\(\)/g) || []).length;
    if (phCount < 6) throw new Error('折叠占位符接线不足（helper＋4 builder＋generic）：' + phCount);
    if (!giSrc.includes("el.querySelector('[data-body-ph]')")) throw new Error('展开未接占位符补水');
    if (!gwSrc.includes('[data-body-ph]')) throw new Error('定位跳转展开未接占位符补水');
    return true;
  });

  qcheck('T68：mermaid 节点级可见性门控（IntersectionObserver＋800px 余量）', () => {
    if (!giSrc.includes('_mermaidIO') || !giSrc.includes("rootMargin: '800px 0px'")) throw new Error('缺 mermaid 可视性观察器');
    const i = giSrc.indexOf('function _scheduleGraphMermaidRender');
    if (i < 0) throw new Error('找不到调度函数');
    const seg = giSrc.slice(i, i + 1600);
    if (!seg.includes('.mermaid:not([data-processed="true"])')) throw new Error('门控未按未解析块过滤');
    if (!seg.includes('isConnected')) throw new Error('解析前未防节点被重建移除');
    return true;
  });
}
}
