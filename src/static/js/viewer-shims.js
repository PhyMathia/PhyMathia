// ===== PhyMathia Utopia 查看器：主应用依赖桩（只读） =====
// 查看器只复用画布渲染子系统（config/utils/render/graph-*），主应用的会话/AI/知识/检测/Φ 一律不进包。
// 这里把子系统会读到的会话级全局补上，并把一切「会写数据或调模型」的入口换成安全桩：
// 只读产物不该有任何副作用——不写 localStorage、不发请求、不改用户的画布。

window.__UTOPIA__ = {
  snapshot: null,   // 已解析的 .pmu 快照
  state: null,      // 快照里的图状态（getGraphState 从这里读，绝不落 localStorage）
  sessionId: '',    // 虚拟会话 id（不指向真实会话）
  fileName: '',
};

// ---------- 只读护栏：localStorage 换内存门面 ----------
// 子集里有两条真实写路径：config.js 首次访问会生成并保存设备 id（用户画像标识），
// graph.js 的撤销栈会按会话写 graph_history。查看器是只读产物，不能往用户浏览器里塞键。
// 实现：把 window.localStorage 换成内存门面——读得到本页自己的写，关掉页面即消失，绝不落盘。
(function () {
  var real = window.localStorage;
  var mem = {};
  var facade = {
    get length() { return Object.keys(mem).length; },
    key: function (i) { return Object.keys(mem)[i] || null; },
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, String(k)) ? mem[String(k)] : null; },
    setItem: function (k, v) { mem[String(k)] = String(v); },
    removeItem: function (k) { delete mem[String(k)]; },
    clear: function () { mem = {}; },
  };
  window.__utopiaMemoryStorage = mem;
  window.__utopiaRealLocalStorage = real;   // 诊断用：断言"真实存储零污染"
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return facade; } });
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: function () { return facade; } });
  } catch (e) {
    // 个别环境不允许改写：此时仍无主动写路径被触发（写入口都做了 no-op）
  }
})();

// ---------- 会话级全局（子系统按全局名读取） ----------
window.currentLevel = 'university';
window.sessions = {};
window.chatHistory = [];
window.isStreaming = false;
window.currentSessionId = '';
window.SESSION_ID = '';

window.getCurrentSessionId = function () { return window.__UTOPIA__.sessionId || ''; };
window.getSessionById = function (id) {
  var snap = window.__UTOPIA__.snapshot || {};
  return { id: id || window.__UTOPIA__.sessionId || 'utopia', title: snap.title || 'Utopia 快照', sessionId: id || '' };
};
window.getChatHistory = function () {
  var snap = window.__UTOPIA__.snapshot;
  return (snap && Array.isArray(snap.messages)) ? snap.messages : [];
};
window.getStreamingAssistant = function () { return null; };

// 图状态：只读内存态。saveGraphState 变空操作——查看器里的任何拖动/折叠都不回写任何地方。
window.getGraphState = function () { return window.__UTOPIA__.state || {}; };
window.saveGraphState = function () {};

// ---------- 提示与进度（查看器自绘 toast） ----------
window.showToast = function (msg) {
  var box = document.getElementById('utopiaToast');
  if (!box) return;
  box.textContent = String(msg || '');
  box.classList.add('show');
  clearTimeout(window.__utopiaToastTimer);
  window.__utopiaToastTimer = setTimeout(function () { box.classList.remove('show'); }, 3200);
};
window.showProgress = function () {};
window.hideProgress = function () {};

// ---------- 其余一律安全桩（只读查看器用不到这些写路径） ----------
(function () {
  var noops = [
    // 会话/消息写路径
    'saveSessionMessages', 'loadSessionMessages', 'saveSessions', 'loadSessions', 'renderSessionList',
    'switchToSession', 'createNewSession', 'deleteSession', 'sendQuick', 'sendMessage', 'clearChat',
    'startSocraticAnswer', 'updateDataStats',
    // 模型 / AI
    'getActiveModelForRole', 'getAllModels', 'getModelById', 'proxyChatWithModel', 'retryHarnessLastRequest',
    'runAllWorkflowNodes', 'stopGeneration',
    // 知识 / 公式
    'getKnowledgeItems', 'saveKnowledgeItems', 'getFormulaCache', 'setFormulaCache', 'invalidateKnowledgeCache',
    'renderKnowledgePanel', 'loadFormulas', 'saveFormulasToServer', 'loadKnowledgeFromServer',
    // Φ 助手
    'buildHarnessSnapshot', 'openGraphHarness', 'closeGraphHarness', 'toggleGraphHarnessWindow',
    'runGraphHarness', 'runGraphHarnessWithFocus', 'previewHarnessSuggestion', 'applyGraphHarness',
    'undoGraphHarness', 'toggleGraphPet', 'toggleGraphConsistencyPanel', 'toggleGraphHarnessPanel',
    // 检测闭环
    'openQuiz', 'closeQuiz', 'openQuizGlobalDashboard', 'showQuizReturnPill', 'hideQuizReturnPill',
    'showQuizRelearnGuide', 'clearQuizRelearnGuide', 'quizLocateTopic', 'quizRetestTopic',
    'getLastLocatedGraphNodeId', 'locateFormulaNode', 'goToKnowledgeNode',
    // 面板 / 主题以外的杂项
    'toggleKnowledgePanel', 'toggleDataPanel', 'toggleModelPanel', 'toggleLevelPanel', 'toggleSidebar',
    'toggleGraphView', 'sendGraphNewSession', 'openGraphHistoryPanel', 'toggleGraphHistoryPanel',
    'showGraphHarnessPreview', 'clearGraphHarnessPreview',
  ];
  noops.forEach(function (name) {
    if (typeof window[name] !== 'function') window[name] = function () {};
  });
})();
