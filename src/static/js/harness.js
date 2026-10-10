// ===== PhyMathia 图编辑 harness：状态、面板与基础工具 =====

  const HARNESS_API = '/api/harness/graph/review';
  let harnessPanel = null;
  let harnessPet = null;
  let harnessResult = null;
  let harnessSnapshot = null;
  let harnessPhase = 'normal';
  let harnessSingleEvalId = null;
  let harnessPendingClarify = null;
  let harnessHistory = [];
let harnessLastAppliedOps = [];
let harnessLastAppliedBeforeSnapshot = null;
// T96：最近一批应用的上报标记（apply_report 只回 {status,event_id}，seq 是落盘后
// 的文件行号，前端要查 GET events 才知道）。这里只记「已上报」，去重提示用；
// 撤销折算一律现查事件列表（harness-apply.js 的 _harnessEffectiveAppliedBatches）。
let harnessLastAppliedReport = null;
  // T88：当前这批建议是否已应用过（防重复应用——重复「应用全部」会用同批 ops 空跑，
  // 并把单槽 harnessCheckpoint 覆盖成已应用态，撤销从此失效）。成功应用置 true，
  // 撤销/新结果渲染/Φ 会话重置/新一轮生成时复位。
  let harnessResultApplied = false;
  let harnessBusy = false;
  let harnessLastInstruction = '';
  let harnessLastPhase = 'normal';
  // 三模式切换器（2026-09-30，D-R6 哲学推广）：edit 编辑（默认，可改图）/
  // chat 答疑（只读）/ preset 创造（节点配方）。显式切换、不做意图自动识别；
  // 内存态不落盘——面板关闭重开保持状态，退出只能切回「编辑」
  let harnessMode = 'edit';
  let harnessPhiError = false;
  let harnessPhiCelebrate = false;
  let harnessAbortController = null;
  // T103（评审路线第五步）：换模型重试的一次性覆盖（runGraphHarness 取用即清，
  // 不动用户槽位）＋最近一次错误详情（「复制错误详情」的原料）
  let harnessModelOverride = null;
  let harnessLastError = null;
  // T106：状态行进度计时——生成中每秒叠「· Ns」，结束时追加耗时/模型调用数/
  // token 摘要（数据来自 result 的 model_calls 与 context_metrics，此前前端零消费）
  let harnessRunStartTs = 0;
  let harnessStatusTickId = null;
  let harnessStatusBaseText = '';
  // T104：会话菜单的搜索词与正在行内改名的会话 id（重渲染即复位的临时态）
  let harnessSessionFilter = '';
  let renamingPhiId = '';
  // T118：清空所有 Φ 对话的内联二次确认是否已就位。必须住在变量里而不是只写在
  // footer 的 innerHTML 里——菜单任何重渲染（切画布/删画布/换绑，见
  // notifyHarnessCanvasChanged）都会整块重建 footer，只活在 DOM 里的 armed 态
  // 会被当场抹掉，用户表现为「点了清空所有，确认条自己没了」
  let clearAllArmed = false;

  // T91：流式阶段的中文名，与后端 harness/review.py 的 _PHASE_LABELS 逐字镜像（含 undo 共 7 项）。
  // 只服务于历史消息下方 meta 的显示——entry.phase 的存储值（localStorage 历史/请求体）
  // 与 entry.phase === 'apply' 之类的程序判断一律保持英文原值，绝不在这里改写。
  const HARNESS_PHASE_LABELS = { normal: '审阅整理', evaluate: '生成评价', apply: '应用建议', expand: '拓展进阶', preset: '创造模式', chat: '答疑模式', undo: '撤销回滚' };
  function _harnessPhaseLabel(phase) {
    // 未知相位输出空串，绝不回落到英文原文（裸 phase 名不给用户看）
    return Object.prototype.hasOwnProperty.call(HARNESS_PHASE_LABELS, phase) ? HARNESS_PHASE_LABELS[phase] : '';
  }

  // 统一的 harness JSON POST。后端约定：业务结果（ok/undo/clarify/no_ops/
  // parse_error/invalid）永远是 HTTP 200；传输层故障（坏 JSON/模型侧失败/
  // 内部异常）带真实 4xx/5xx，但 body 仍是 {status:'error',errors:[...]}。
  // 这里把两层判定合成一个 throw，调用方只管 catch（SSE 流式路径不适用，
  // 流内错误永远以 200 result 事件下发，仍需带内检查）。
  async function harnessFetchJson(path, payload) {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    let data = null;
    try {
      data = await resp.json();
    } catch (err) {
      throw new Error('服务端返回非 JSON（HTTP ' + resp.status + '）');
    }
    if (!resp.ok || data.status === 'error' || (Array.isArray(data.errors) && data.errors.length)) {
      const reason = (data && Array.isArray(data.errors) && data.errors[0] && (data.errors[0].reason || data.errors[0].message))
        || ('请求失败（HTTP ' + resp.status + '）');
      throw new Error(reason);
    }
    return data;
  }

  const PHI_PET_HTML = ''
    + '<div class="phi-pet" data-phi-pet data-phi-mode="idle">'
    + '<div class="phi-code-symbols" aria-hidden="true">'
    + '<span class="phi-code-symbol phi-code-symbol-1">{}</span>'
    + '<span class="phi-code-symbol phi-code-symbol-2">&lt;&gt;</span>'
    + '<span class="phi-code-symbol phi-code-symbol-3">01</span>'
    + '<span class="phi-code-symbol phi-code-symbol-4">/</span>'
    + '<span class="phi-code-symbol phi-code-symbol-5">&lt;/&gt;</span>'
    + '</div>'
    + '<div class="phi-celebrate" aria-hidden="true">'
    + '<span class="phi-confetti">★</span>'
    + '<span class="phi-confetti">♥</span>'
    + '<span class="phi-confetti">✦</span>'
    + '<span class="phi-confetti">♥</span>'
    + '<span class="phi-confetti">★</span>'
    + '<span class="phi-confetti">✿</span>'
    + '<span class="phi-confetti">❖</span>'
    + '</div>'
    + '<div class="phi-bubbles" aria-hidden="true">'
    + '<span class="phi-bubble phi-bubble-1">●</span>'
    + '<span class="phi-bubble phi-bubble-2">▪</span>'
    + '<span class="phi-bubble phi-bubble-3">●</span>'
    + '<span class="phi-bubble phi-bubble-4">█</span>'
    + '<span class="phi-bubble phi-bubble-5">▪</span>'
    + '<span class="phi-bubble phi-bubble-6">●</span>'
    + '</div>'
    + '<div class="phi-character">'
    + '<svg class="phi-part phi-body" viewBox="0 0 48 56" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" aria-hidden="true" draggable="false"><rect x="20" y="0" width="8" height="1" fill="var(--phi-outline)"/><rect x="14" y="1" width="7" height="1" fill="var(--phi-outline)"/><rect x="27" y="1" width="7" height="1" fill="var(--phi-outline)"/><rect x="13" y="2" width="2" height="1" fill="var(--phi-outline)"/><rect x="33" y="2" width="2" height="1" fill="var(--phi-outline)"/><rect x="11" y="3" width="3" height="1" fill="var(--phi-outline)"/><rect x="34" y="3" width="3" height="1" fill="var(--phi-outline)"/><rect x="10" y="4" width="2" height="1" fill="var(--phi-outline)"/><rect x="13" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="34" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="36" y="4" width="2" height="1" fill="var(--phi-outline)"/><rect x="8" y="5" width="3" height="1" fill="var(--phi-outline)"/><rect x="37" y="5" width="3" height="1" fill="var(--phi-outline)"/><rect x="7" y="6" width="2" height="1" fill="var(--phi-outline)"/><rect x="39" y="6" width="2" height="1" fill="var(--phi-outline)"/><rect x="6" y="7" width="2" height="1" fill="var(--phi-outline)"/><rect x="40" y="7" width="2" height="1" fill="var(--phi-outline)"/><rect x="5" y="8" width="2" height="1" fill="var(--phi-outline)"/><rect x="41" y="8" width="2" height="1" fill="var(--phi-outline)"/><rect x="4" y="9" width="2" height="1" fill="var(--phi-outline)"/><rect x="16" y="9" width="5" height="1" fill="var(--phi-outline)"/><rect x="27" y="9" width="5" height="1" fill="var(--phi-outline)"/><rect x="42" y="9" width="2" height="1" fill="var(--phi-outline)"/><rect x="4" y="10" width="1" height="1" fill="var(--phi-outline)"/><rect x="15" y="10" width="2" height="1" fill="var(--phi-outline)"/><rect x="20" y="10" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="10" width="1" height="1" fill="var(--phi-outline)"/><rect x="31" y="10" width="2" height="1" fill="var(--phi-outline)"/><rect x="43" y="10" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="11" width="3" height="1" fill="var(--phi-outline)"/><rect x="13" y="11" width="3" height="1" fill="var(--phi-outline)"/><rect x="20" y="11" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="11" width="1" height="1" fill="var(--phi-outline)"/><rect x="32" y="11" width="3" height="1" fill="var(--phi-outline)"/><rect x="43" y="11" width="3" height="1" fill="var(--phi-outline)"/><rect x="2" y="12" width="1" height="1" fill="var(--phi-outline)"/><rect x="12" y="12" width="2" height="1" fill="var(--phi-outline)"/><rect x="20" y="12" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="12" width="1" height="1" fill="var(--phi-outline)"/><rect x="34" y="12" width="2" height="1" fill="var(--phi-outline)"/><rect x="45" y="12" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="13" width="1" height="1" fill="var(--phi-outline)"/><rect x="11" y="13" width="2" height="1" fill="var(--phi-outline)"/><rect x="20" y="13" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="13" width="1" height="1" fill="var(--phi-outline)"/><rect x="35" y="13" width="2" height="1" fill="var(--phi-outline)"/><rect x="45" y="13" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="14" width="1" height="1" fill="var(--phi-outline)"/><rect x="10" y="14" width="2" height="1" fill="var(--phi-outline)"/><rect x="20" y="14" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="14" width="1" height="1" fill="var(--phi-outline)"/><rect x="36" y="14" width="2" height="1" fill="var(--phi-outline)"/><rect x="45" y="14" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="15" width="3" height="1" fill="var(--phi-outline)"/><rect x="9" y="15" width="2" height="1" fill="var(--phi-outline)"/><rect x="20" y="15" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="15" width="1" height="1" fill="var(--phi-outline)"/><rect x="37" y="15" width="2" height="1" fill="var(--phi-outline)"/><rect x="45" y="15" width="3" height="1" fill="var(--phi-outline)"/><rect x="0" y="16" width="1" height="1" fill="var(--phi-outline)"/><rect x="9" y="16" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="16" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="16" width="1" height="1" fill="var(--phi-outline)"/><rect x="38" y="16" width="1" height="1" fill="var(--phi-outline)"/><rect x="47" y="16" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="17" width="1" height="1" fill="var(--phi-outline)"/><rect x="8" y="17" width="2" height="1" fill="var(--phi-outline)"/><rect x="20" y="17" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="17" width="1" height="1" fill="var(--phi-outline)"/><rect x="38" y="17" width="2" height="1" fill="var(--phi-outline)"/><rect x="47" y="17" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="18" width="1" height="1" fill="var(--phi-outline)"/><rect x="8" y="18" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="18" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="18" width="1" height="1" fill="var(--phi-outline)"/><rect x="39" y="18" width="1" height="1" fill="var(--phi-outline)"/><rect x="47" y="18" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="19" width="1" height="1" fill="var(--phi-outline)"/><rect x="8" y="19" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="19" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="19" width="1" height="1" fill="var(--phi-outline)"/><rect x="39" y="19" width="1" height="1" fill="var(--phi-outline)"/><rect x="47" y="19" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="20" width="1" height="1" fill="var(--phi-outline)"/><rect x="8" y="20" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="20" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="20" width="1" height="1" fill="var(--phi-outline)"/><rect x="39" y="20" width="1" height="1" fill="var(--phi-outline)"/><rect x="47" y="20" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="21" width="1" height="1" fill="var(--phi-outline)"/><rect x="8" y="21" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="21" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="21" width="1" height="1" fill="var(--phi-outline)"/><rect x="39" y="21" width="1" height="1" fill="var(--phi-outline)"/><rect x="47" y="21" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="22" width="1" height="1" fill="var(--phi-outline)"/><rect x="8" y="22" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="22" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="22" width="1" height="1" fill="var(--phi-outline)"/><rect x="39" y="22" width="1" height="1" fill="var(--phi-outline)"/><rect x="47" y="22" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="23" width="1" height="1" fill="var(--phi-outline)"/><rect x="8" y="23" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="23" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="23" width="1" height="1" fill="var(--phi-outline)"/><rect x="39" y="23" width="1" height="1" fill="var(--phi-outline)"/><rect x="47" y="23" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="24" width="1" height="1" fill="var(--phi-outline)"/><rect x="8" y="24" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="24" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="24" width="1" height="1" fill="var(--phi-outline)"/><rect x="39" y="24" width="1" height="1" fill="var(--phi-outline)"/><rect x="47" y="24" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="25" width="1" height="1" fill="var(--phi-outline)"/><rect x="8" y="25" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="25" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="25" width="1" height="1" fill="var(--phi-outline)"/><rect x="39" y="25" width="1" height="1" fill="var(--phi-outline)"/><rect x="47" y="25" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="26" width="1" height="1" fill="var(--phi-outline)"/><rect x="8" y="26" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="26" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="26" width="1" height="1" fill="var(--phi-outline)"/><rect x="39" y="26" width="1" height="1" fill="var(--phi-outline)"/><rect x="47" y="26" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="27" width="1" height="1" fill="var(--phi-outline)"/><rect x="8" y="27" width="2" height="1" fill="var(--phi-outline)"/><rect x="20" y="27" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="27" width="1" height="1" fill="var(--phi-outline)"/><rect x="38" y="27" width="2" height="1" fill="var(--phi-outline)"/><rect x="47" y="27" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="28" width="1" height="1" fill="var(--phi-outline)"/><rect x="9" y="28" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="28" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="28" width="1" height="1" fill="var(--phi-outline)"/><rect x="38" y="28" width="1" height="1" fill="var(--phi-outline)"/><rect x="47" y="28" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="29" width="2" height="1" fill="var(--phi-outline)"/><rect x="9" y="29" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="29" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="29" width="1" height="1" fill="var(--phi-outline)"/><rect x="38" y="29" width="1" height="1" fill="var(--phi-outline)"/><rect x="46" y="29" width="2" height="1" fill="var(--phi-outline)"/><rect x="1" y="30" width="1" height="1" fill="var(--phi-outline)"/><rect x="9" y="30" width="3" height="1" fill="var(--phi-outline)"/><rect x="20" y="30" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="30" width="1" height="1" fill="var(--phi-outline)"/><rect x="36" y="30" width="3" height="1" fill="var(--phi-outline)"/><rect x="46" y="30" width="1" height="1" fill="var(--phi-outline)"/><rect x="1" y="31" width="2" height="1" fill="var(--phi-outline)"/><rect x="11" y="31" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="31" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="31" width="1" height="1" fill="var(--phi-outline)"/><rect x="36" y="31" width="1" height="1" fill="var(--phi-outline)"/><rect x="45" y="31" width="2" height="1" fill="var(--phi-outline)"/><rect x="2" y="32" width="1" height="1" fill="var(--phi-outline)"/><rect x="11" y="32" width="3" height="1" fill="var(--phi-outline)"/><rect x="20" y="32" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="32" width="1" height="1" fill="var(--phi-outline)"/><rect x="34" y="32" width="3" height="1" fill="var(--phi-outline)"/><rect x="45" y="32" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="33" width="2" height="1" fill="var(--phi-outline)"/><rect x="13" y="33" width="3" height="1" fill="var(--phi-outline)"/><rect x="20" y="33" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="33" width="1" height="1" fill="var(--phi-outline)"/><rect x="32" y="33" width="3" height="1" fill="var(--phi-outline)"/><rect x="44" y="33" width="2" height="1" fill="var(--phi-outline)"/><rect x="3" y="34" width="1" height="1" fill="var(--phi-outline)"/><rect x="15" y="34" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="34" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="34" width="1" height="1" fill="var(--phi-outline)"/><rect x="32" y="34" width="1" height="1" fill="var(--phi-outline)"/><rect x="44" y="34" width="1" height="1" fill="var(--phi-outline)"/><rect x="3" y="35" width="2" height="1" fill="var(--phi-outline)"/><rect x="15" y="35" width="6" height="1" fill="var(--phi-outline)"/><rect x="27" y="35" width="6" height="1" fill="var(--phi-outline)"/><rect x="43" y="35" width="2" height="1" fill="var(--phi-outline)"/><rect x="4" y="36" width="3" height="1" fill="var(--phi-outline)"/><rect x="41" y="36" width="3" height="1" fill="var(--phi-outline)"/><rect x="6" y="37" width="1" height="1" fill="var(--phi-outline)"/><rect x="41" y="37" width="1" height="1" fill="var(--phi-outline)"/><rect x="6" y="38" width="3" height="1" fill="var(--phi-outline)"/><rect x="39" y="38" width="3" height="1" fill="var(--phi-outline)"/><rect x="8" y="39" width="3" height="1" fill="var(--phi-outline)"/><rect x="37" y="39" width="3" height="1" fill="var(--phi-outline)"/><rect x="10" y="40" width="1" height="1" fill="var(--phi-outline)"/><rect x="37" y="40" width="1" height="1" fill="var(--phi-outline)"/><rect x="10" y="41" width="4" height="1" fill="var(--phi-outline)"/><rect x="34" y="41" width="4" height="1" fill="var(--phi-outline)"/><rect x="13" y="42" width="2" height="1" fill="var(--phi-outline)"/><rect x="33" y="42" width="2" height="1" fill="var(--phi-outline)"/><rect x="14" y="43" width="7" height="1" fill="var(--phi-outline)"/><rect x="27" y="43" width="7" height="1" fill="var(--phi-outline)"/><rect x="20" y="44" width="2" height="1" fill="var(--phi-outline)"/><rect x="26" y="44" width="2" height="1" fill="var(--phi-outline)"/><rect x="21" y="45" width="1" height="1" fill="var(--phi-outline)"/><rect x="26" y="45" width="1" height="1" fill="var(--phi-outline)"/><rect x="20" y="46" width="2" height="1" fill="var(--phi-outline)"/><rect x="26" y="46" width="2" height="1" fill="var(--phi-outline)"/><rect x="20" y="47" width="1" height="1" fill="var(--phi-outline)"/><rect x="27" y="47" width="1" height="1" fill="var(--phi-outline)"/><rect x="18" y="48" width="3" height="1" fill="var(--phi-outline)"/><rect x="27" y="48" width="3" height="1" fill="var(--phi-outline)"/><rect x="17" y="49" width="2" height="1" fill="var(--phi-outline)"/><rect x="29" y="49" width="2" height="1" fill="var(--phi-outline)"/><rect x="17" y="50" width="1" height="1" fill="var(--phi-outline)"/><rect x="30" y="50" width="1" height="1" fill="var(--phi-outline)"/><rect x="17" y="51" width="2" height="1" fill="var(--phi-outline)"/><rect x="29" y="51" width="2" height="1" fill="var(--phi-outline)"/><rect x="18" y="52" width="1" height="1" fill="var(--phi-outline)"/><rect x="29" y="52" width="1" height="1" fill="var(--phi-outline)"/><rect x="18" y="53" width="3" height="1" fill="var(--phi-outline)"/><rect x="27" y="53" width="3" height="1" fill="var(--phi-outline)"/><rect x="20" y="54" width="2" height="1" fill="var(--phi-outline)"/><rect x="26" y="54" width="2" height="1" fill="var(--phi-outline)"/><rect x="21" y="55" width="6" height="1" fill="var(--phi-outline)"/><rect x="21" y="1" width="6" height="1" fill="var(--phi-body-hi)"/><rect x="15" y="2" width="18" height="1" fill="var(--phi-body-hi)"/><rect x="14" y="3" width="20" height="1" fill="var(--phi-body-hi)"/><rect x="12" y="4" width="1" height="1" fill="var(--phi-body-hi)"/><rect x="14" y="4" width="20" height="1" fill="var(--phi-body-hi)"/><rect x="35" y="4" width="1" height="1" fill="var(--phi-body-hi)"/><rect x="11" y="5" width="26" height="1" fill="var(--phi-body-hi)"/><rect x="9" y="6" width="30" height="1" fill="var(--phi-body-hi)"/><rect x="8" y="7" width="32" height="1" fill="var(--phi-body-hi)"/><rect x="7" y="8" width="34" height="1" fill="var(--phi-body-hi)"/><rect x="6" y="9" width="10" height="1" fill="var(--phi-body-hi)"/><rect x="21" y="9" width="6" height="1" fill="var(--phi-body-hi)"/><rect x="32" y="9" width="10" height="1" fill="var(--phi-body-hi)"/><rect x="5" y="10" width="10" height="1" fill="var(--phi-body-hi)"/><rect x="21" y="10" width="6" height="1" fill="var(--phi-body-hi)"/><rect x="33" y="10" width="10" height="1" fill="var(--phi-body-hi)"/><rect x="5" y="11" width="8" height="1" fill="var(--phi-body-hi)"/><rect x="21" y="11" width="6" height="1" fill="var(--phi-body-hi)"/><rect x="35" y="11" width="8" height="1" fill="var(--phi-body-hi)"/><rect x="3" y="12" width="9" height="1" fill="var(--phi-body-hi)"/><rect x="21" y="12" width="6" height="1" fill="var(--phi-body-hi)"/><rect x="36" y="12" width="9" height="1" fill="var(--phi-body-hi)"/><rect x="3" y="13" width="8" height="1" fill="var(--phi-body-hi)"/><rect x="21" y="13" width="6" height="1" fill="var(--phi-body-hi)"/><rect x="37" y="13" width="8" height="1" fill="var(--phi-body-hi)"/><rect x="3" y="14" width="7" height="1" fill="var(--phi-body-hi)"/><rect x="21" y="14" width="6" height="1" fill="var(--phi-body-hi)"/><rect x="38" y="14" width="7" height="1" fill="var(--phi-body-hi)"/><rect x="3" y="15" width="6" height="1" fill="var(--phi-body-hi)"/><rect x="21" y="15" width="6" height="1" fill="var(--phi-body-hi)"/><rect x="39" y="15" width="6" height="1" fill="var(--phi-body-hi)"/><rect x="1" y="16" width="8" height="1" fill="var(--phi-body-hi)"/><rect x="21" y="16" width="6" height="1" fill="var(--phi-body-hi)"/><rect x="39" y="16" width="8" height="1" fill="var(--phi-body-hi)"/><rect x="1" y="17" width="7" height="1" fill="var(--phi-body)"/><rect x="21" y="17" width="6" height="1" fill="var(--phi-body)"/><rect x="40" y="17" width="7" height="1" fill="var(--phi-body)"/><rect x="1" y="18" width="7" height="1" fill="var(--phi-body)"/><rect x="21" y="18" width="6" height="1" fill="var(--phi-body)"/><rect x="40" y="18" width="7" height="1" fill="var(--phi-body)"/><rect x="1" y="19" width="7" height="1" fill="var(--phi-body)"/><rect x="21" y="19" width="6" height="1" fill="var(--phi-body)"/><rect x="40" y="19" width="7" height="1" fill="var(--phi-body)"/><rect x="1" y="20" width="7" height="1" fill="var(--phi-body)"/><rect x="21" y="20" width="6" height="1" fill="var(--phi-body)"/><rect x="40" y="20" width="7" height="1" fill="var(--phi-body)"/><rect x="1" y="21" width="7" height="1" fill="var(--phi-body)"/><rect x="21" y="21" width="6" height="1" fill="var(--phi-body)"/><rect x="40" y="21" width="7" height="1" fill="var(--phi-body)"/><rect x="1" y="22" width="7" height="1" fill="var(--phi-body)"/><rect x="21" y="22" width="6" height="1" fill="var(--phi-body)"/><rect x="40" y="22" width="7" height="1" fill="var(--phi-body)"/><rect x="1" y="23" width="7" height="1" fill="var(--phi-body)"/><rect x="21" y="23" width="6" height="1" fill="var(--phi-body)"/><rect x="40" y="23" width="7" height="1" fill="var(--phi-body)"/><rect x="1" y="24" width="7" height="1" fill="var(--phi-body)"/><rect x="21" y="24" width="6" height="1" fill="var(--phi-body)"/><rect x="40" y="24" width="7" height="1" fill="var(--phi-body)"/><rect x="1" y="25" width="7" height="1" fill="var(--phi-body)"/><rect x="21" y="25" width="6" height="1" fill="var(--phi-body)"/><rect x="40" y="25" width="7" height="1" fill="var(--phi-body)"/><rect x="1" y="26" width="7" height="1" fill="var(--phi-body)"/><rect x="21" y="26" width="6" height="1" fill="var(--phi-body)"/><rect x="40" y="26" width="7" height="1" fill="var(--phi-body)"/><rect x="1" y="27" width="7" height="1" fill="var(--phi-body)"/><rect x="21" y="27" width="6" height="1" fill="var(--phi-body)"/><rect x="40" y="27" width="7" height="1" fill="var(--phi-body)"/><rect x="1" y="28" width="8" height="1" fill="var(--phi-body)"/><rect x="21" y="28" width="6" height="1" fill="var(--phi-body)"/><rect x="39" y="28" width="8" height="1" fill="var(--phi-body)"/><rect x="2" y="29" width="7" height="1" fill="var(--phi-body)"/><rect x="21" y="29" width="6" height="1" fill="var(--phi-body)"/><rect x="39" y="29" width="7" height="1" fill="var(--phi-body)"/><rect x="2" y="30" width="7" height="1" fill="var(--phi-body)"/><rect x="21" y="30" width="6" height="1" fill="var(--phi-body)"/><rect x="39" y="30" width="7" height="1" fill="var(--phi-body)"/><rect x="3" y="31" width="8" height="1" fill="var(--phi-body)"/><rect x="21" y="31" width="6" height="1" fill="var(--phi-body)"/><rect x="37" y="31" width="8" height="1" fill="var(--phi-body)"/><rect x="3" y="32" width="8" height="1" fill="var(--phi-body)"/><rect x="21" y="32" width="6" height="1" fill="var(--phi-body)"/><rect x="37" y="32" width="8" height="1" fill="var(--phi-body)"/><rect x="4" y="33" width="9" height="1" fill="var(--phi-body)"/><rect x="21" y="33" width="6" height="1" fill="var(--phi-body)"/><rect x="35" y="33" width="9" height="1" fill="var(--phi-body)"/><rect x="4" y="34" width="11" height="1" fill="var(--phi-body)"/><rect x="21" y="34" width="6" height="1" fill="var(--phi-body)"/><rect x="33" y="34" width="11" height="1" fill="var(--phi-body)"/><rect x="5" y="35" width="10" height="1" fill="var(--phi-body)"/><rect x="21" y="35" width="6" height="1" fill="var(--phi-body)"/><rect x="33" y="35" width="10" height="1" fill="var(--phi-body)"/><rect x="7" y="36" width="34" height="1" fill="var(--phi-body)"/><rect x="7" y="37" width="34" height="1" fill="var(--phi-body)"/><rect x="9" y="38" width="30" height="1" fill="var(--phi-body)"/><rect x="11" y="39" width="26" height="1" fill="var(--phi-body)"/><rect x="11" y="40" width="26" height="1" fill="var(--phi-body)"/><rect x="14" y="41" width="20" height="1" fill="var(--phi-body)"/><rect x="15" y="42" width="18" height="1" fill="var(--phi-body)"/><rect x="21" y="43" width="6" height="1" fill="var(--phi-body)"/><rect x="22" y="44" width="4" height="1" fill="var(--phi-body)"/><rect x="22" y="45" width="4" height="1" fill="var(--phi-body-shadow)"/><rect x="22" y="46" width="4" height="1" fill="var(--phi-body-shadow)"/><rect x="21" y="47" width="6" height="1" fill="var(--phi-body-shadow)"/><rect x="21" y="48" width="6" height="1" fill="var(--phi-body-shadow)"/><rect x="19" y="49" width="10" height="1" fill="var(--phi-body-shadow)"/><rect x="18" y="50" width="12" height="1" fill="var(--phi-body-shadow)"/><rect x="19" y="51" width="10" height="1" fill="var(--phi-body-shadow)"/><rect x="19" y="52" width="10" height="1" fill="var(--phi-body-shadow)"/><rect x="21" y="53" width="6" height="1" fill="var(--phi-body-shadow)"/><rect x="22" y="54" width="4" height="1" fill="var(--phi-body-shadow)"/></svg>'
    + '<svg class="phi-part phi-hand phi-hand-right" viewBox="0 0 13 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" aria-hidden="true" draggable="false"><rect x="6" y="0" width="5" height="1" fill="var(--phi-outline)"/><rect x="5" y="1" width="2" height="1" fill="var(--phi-outline)"/><rect x="10" y="1" width="1" height="1" fill="var(--phi-outline)"/><rect x="5" y="2" width="1" height="1" fill="var(--phi-outline)"/><rect x="10" y="2" width="2" height="1" fill="var(--phi-outline)"/><rect x="3" y="3" width="3" height="1" fill="var(--phi-outline)"/><rect x="11" y="3" width="1" height="1" fill="var(--phi-outline)"/><rect x="3" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="11" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="5" width="2" height="1" fill="var(--phi-outline)"/><rect x="11" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="6" width="3" height="1" fill="var(--phi-outline)"/><rect x="11" y="6" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="10" y="7" width="3" height="1" fill="var(--phi-outline)"/><rect x="0" y="8" width="1" height="1" fill="var(--phi-outline)"/><rect x="12" y="8" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="9" width="1" height="1" fill="var(--phi-outline)"/><rect x="12" y="9" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="10" width="1" height="1" fill="var(--phi-outline)"/><rect x="12" y="10" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="11" width="1" height="1" fill="var(--phi-outline)"/><rect x="12" y="11" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="12" width="1" height="1" fill="var(--phi-outline)"/><rect x="12" y="12" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="13" width="3" height="1" fill="var(--phi-outline)"/><rect x="9" y="13" width="1" height="1" fill="var(--phi-outline)"/><rect x="11" y="13" width="2" height="1" fill="var(--phi-outline)"/><rect x="2" y="14" width="2" height="1" fill="var(--phi-outline)"/><rect x="9" y="14" width="3" height="1" fill="var(--phi-outline)"/><rect x="3" y="15" width="7" height="1" fill="var(--phi-outline)"/><rect x="7" y="1" width="3" height="1" fill="var(--phi-body-hi)"/><rect x="6" y="2" width="4" height="1" fill="var(--phi-body-hi)"/><rect x="6" y="3" width="5" height="1" fill="var(--phi-body-hi)"/><rect x="4" y="4" width="7" height="1" fill="var(--phi-body-hi)"/><rect x="4" y="5" width="7" height="1" fill="var(--phi-body)"/><rect x="3" y="6" width="8" height="1" fill="var(--phi-body)"/><rect x="1" y="7" width="9" height="1" fill="var(--phi-body)"/><rect x="1" y="8" width="11" height="1" fill="var(--phi-body)"/><rect x="1" y="9" width="11" height="1" fill="var(--phi-body)"/><rect x="1" y="10" width="11" height="1" fill="var(--phi-body)"/><rect x="1" y="11" width="11" height="1" fill="var(--phi-body)"/><rect x="1" y="12" width="11" height="1" fill="var(--phi-body-shadow)"/><rect x="3" y="13" width="6" height="1" fill="var(--phi-body-shadow)"/><rect x="10" y="13" width="1" height="1" fill="var(--phi-body-shadow)"/><rect x="4" y="14" width="5" height="1" fill="var(--phi-body-shadow)"/></svg>'
    + '<svg class="phi-part phi-hand phi-hand-left" viewBox="0 0 13 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" aria-hidden="true" draggable="false"><rect x="2" y="0" width="5" height="1" fill="var(--phi-outline)"/><rect x="2" y="1" width="1" height="1" fill="var(--phi-outline)"/><rect x="6" y="1" width="2" height="1" fill="var(--phi-outline)"/><rect x="1" y="2" width="2" height="1" fill="var(--phi-outline)"/><rect x="7" y="2" width="1" height="1" fill="var(--phi-outline)"/><rect x="1" y="3" width="1" height="1" fill="var(--phi-outline)"/><rect x="7" y="3" width="3" height="1" fill="var(--phi-outline)"/><rect x="1" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="9" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="1" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="9" y="5" width="2" height="1" fill="var(--phi-outline)"/><rect x="1" y="6" width="1" height="1" fill="var(--phi-outline)"/><rect x="10" y="6" width="3" height="1" fill="var(--phi-outline)"/><rect x="0" y="7" width="3" height="1" fill="var(--phi-outline)"/><rect x="12" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="8" width="1" height="1" fill="var(--phi-outline)"/><rect x="12" y="8" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="9" width="1" height="1" fill="var(--phi-outline)"/><rect x="12" y="9" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="10" width="1" height="1" fill="var(--phi-outline)"/><rect x="12" y="10" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="11" width="1" height="1" fill="var(--phi-outline)"/><rect x="12" y="11" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="12" width="1" height="1" fill="var(--phi-outline)"/><rect x="12" y="12" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="13" width="2" height="1" fill="var(--phi-outline)"/><rect x="3" y="13" width="1" height="1" fill="var(--phi-outline)"/><rect x="10" y="13" width="3" height="1" fill="var(--phi-outline)"/><rect x="1" y="14" width="3" height="1" fill="var(--phi-outline)"/><rect x="9" y="14" width="2" height="1" fill="var(--phi-outline)"/><rect x="3" y="15" width="7" height="1" fill="var(--phi-outline)"/><rect x="3" y="1" width="3" height="1" fill="var(--phi-body-hi)"/><rect x="3" y="2" width="4" height="1" fill="var(--phi-body-hi)"/><rect x="2" y="3" width="5" height="1" fill="var(--phi-body-hi)"/><rect x="2" y="4" width="7" height="1" fill="var(--phi-body-hi)"/><rect x="2" y="5" width="7" height="1" fill="var(--phi-body)"/><rect x="2" y="6" width="8" height="1" fill="var(--phi-body)"/><rect x="3" y="7" width="9" height="1" fill="var(--phi-body)"/><rect x="1" y="8" width="11" height="1" fill="var(--phi-body)"/><rect x="1" y="9" width="11" height="1" fill="var(--phi-body)"/><rect x="1" y="10" width="11" height="1" fill="var(--phi-body)"/><rect x="1" y="11" width="11" height="1" fill="var(--phi-body)"/><rect x="1" y="12" width="11" height="1" fill="var(--phi-body-shadow)"/><rect x="2" y="13" width="1" height="1" fill="var(--phi-body-shadow)"/><rect x="4" y="13" width="6" height="1" fill="var(--phi-body-shadow)"/><rect x="4" y="14" width="5" height="1" fill="var(--phi-body-shadow)"/></svg>'
    + '<svg class="phi-part phi-eyes" viewBox="0 0 25 14" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" aria-hidden="true" draggable="false"><rect x="0" y="2" width="7" height="1" fill="var(--phi-outline)"/><rect x="18" y="2" width="7" height="1" fill="var(--phi-outline)"/><rect x="0" y="3" width="1" height="1" fill="var(--phi-outline)"/><rect x="6" y="3" width="1" height="1" fill="var(--phi-outline)"/><rect x="18" y="3" width="1" height="1" fill="var(--phi-outline)"/><rect x="24" y="3" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="6" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="18" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="24" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="6" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="18" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="24" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="6" width="1" height="1" fill="var(--phi-outline)"/><rect x="6" y="6" width="1" height="1" fill="var(--phi-outline)"/><rect x="18" y="6" width="1" height="1" fill="var(--phi-outline)"/><rect x="24" y="6" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="6" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="18" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="24" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="8" width="1" height="1" fill="var(--phi-outline)"/><rect x="6" y="8" width="1" height="1" fill="var(--phi-outline)"/><rect x="18" y="8" width="1" height="1" fill="var(--phi-outline)"/><rect x="24" y="8" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="9" width="1" height="1" fill="var(--phi-outline)"/><rect x="6" y="9" width="1" height="1" fill="var(--phi-outline)"/><rect x="18" y="9" width="1" height="1" fill="var(--phi-outline)"/><rect x="24" y="9" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="10" width="1" height="1" fill="var(--phi-outline)"/><rect x="6" y="10" width="1" height="1" fill="var(--phi-outline)"/><rect x="18" y="10" width="1" height="1" fill="var(--phi-outline)"/><rect x="24" y="10" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="11" width="2" height="1" fill="var(--phi-outline)"/><rect x="5" y="11" width="2" height="1" fill="var(--phi-outline)"/><rect x="18" y="11" width="2" height="1" fill="var(--phi-outline)"/><rect x="23" y="11" width="2" height="1" fill="var(--phi-outline)"/><rect x="1" y="12" width="5" height="1" fill="var(--phi-outline)"/><rect x="19" y="12" width="5" height="1" fill="var(--phi-outline)"/><rect x="1" y="3" width="5" height="1" fill="var(--phi-eye)"/><rect x="19" y="3" width="5" height="1" fill="var(--phi-eye)"/><rect x="1" y="4" width="5" height="1" fill="var(--phi-eye)"/><rect x="19" y="4" width="5" height="1" fill="var(--phi-eye)"/><rect x="1" y="5" width="5" height="1" fill="var(--phi-eye)"/><rect x="19" y="5" width="5" height="1" fill="var(--phi-eye)"/><rect x="1" y="6" width="5" height="1" fill="var(--phi-eye)"/><rect x="19" y="6" width="5" height="1" fill="var(--phi-eye)"/><rect x="1" y="7" width="5" height="1" fill="var(--phi-eye-dark)"/><rect x="19" y="7" width="5" height="1" fill="var(--phi-eye-dark)"/><rect x="1" y="8" width="5" height="1" fill="var(--phi-eye-dark)"/><rect x="19" y="8" width="5" height="1" fill="var(--phi-eye-dark)"/><rect x="1" y="9" width="5" height="1" fill="var(--phi-eye-dark)"/><rect x="19" y="9" width="5" height="1" fill="var(--phi-eye-dark)"/><rect x="1" y="10" width="5" height="1" fill="var(--phi-eye-dark)"/><rect x="19" y="10" width="5" height="1" fill="var(--phi-eye-dark)"/><rect x="2" y="11" width="3" height="1" fill="var(--phi-eye-dark)"/><rect x="20" y="11" width="3" height="1" fill="var(--phi-eye-dark)"/></svg>'
    + '<svg class="phi-part phi-lamp phi-lamp-on" viewBox="0 0 16 13" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" aria-hidden="true" draggable="false"><rect x="4" y="1" width="8" height="1" fill="var(--phi-outline)"/><rect x="3" y="2" width="2" height="1" fill="var(--phi-outline)"/><rect x="11" y="2" width="2" height="1" fill="var(--phi-outline)"/><rect x="2" y="3" width="2" height="1" fill="var(--phi-outline)"/><rect x="12" y="3" width="2" height="1" fill="var(--phi-outline)"/><rect x="2" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="13" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="13" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="6" width="1" height="1" fill="var(--phi-outline)"/><rect x="13" y="6" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="13" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="8" width="2" height="1" fill="var(--phi-outline)"/><rect x="12" y="8" width="2" height="1" fill="var(--phi-outline)"/><rect x="3" y="9" width="3" height="1" fill="var(--phi-outline)"/><rect x="10" y="9" width="3" height="1" fill="var(--phi-outline)"/><rect x="4" y="10" width="2" height="1" fill="var(--phi-outline)"/><rect x="10" y="10" width="2" height="1" fill="var(--phi-outline)"/><rect x="4" y="11" width="1" height="1" fill="var(--phi-outline)"/><rect x="11" y="11" width="1" height="1" fill="var(--phi-outline)"/><rect x="4" y="12" width="8" height="1" fill="var(--phi-outline)"/><rect x="5" y="2" width="6" height="1" fill="var(--phi-lamp-on)"/><rect x="4" y="3" width="8" height="1" fill="var(--phi-lamp-on)"/><rect x="3" y="4" width="10" height="1" fill="var(--phi-lamp-on)"/><rect x="3" y="5" width="10" height="1" fill="var(--phi-lamp-on)"/><rect x="3" y="6" width="10" height="1" fill="var(--phi-lamp-on)"/><rect x="3" y="7" width="10" height="1" fill="var(--phi-lamp-on-dark)"/><rect x="4" y="8" width="8" height="1" fill="var(--phi-lamp-on-dark)"/><rect x="6" y="9" width="4" height="1" fill="var(--phi-lamp-on-dark)"/><rect x="6" y="10" width="4" height="1" fill="var(--phi-lamp-on-dark)"/><rect x="5" y="11" width="6" height="1" fill="var(--phi-lamp-on-dark)"/></svg>'
    + '<svg class="phi-part phi-lamp phi-lamp-off" viewBox="0 0 16 13" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" aria-hidden="true" draggable="false"><rect x="4" y="1" width="8" height="1" fill="var(--phi-outline)"/><rect x="3" y="2" width="2" height="1" fill="var(--phi-outline)"/><rect x="11" y="2" width="2" height="1" fill="var(--phi-outline)"/><rect x="2" y="3" width="2" height="1" fill="var(--phi-outline)"/><rect x="12" y="3" width="2" height="1" fill="var(--phi-outline)"/><rect x="2" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="13" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="13" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="6" width="1" height="1" fill="var(--phi-outline)"/><rect x="13" y="6" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="13" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="8" width="2" height="1" fill="var(--phi-outline)"/><rect x="12" y="8" width="2" height="1" fill="var(--phi-outline)"/><rect x="3" y="9" width="2" height="1" fill="var(--phi-outline)"/><rect x="11" y="9" width="2" height="1" fill="var(--phi-outline)"/><rect x="4" y="10" width="2" height="1" fill="var(--phi-outline)"/><rect x="10" y="10" width="2" height="1" fill="var(--phi-outline)"/><rect x="4" y="11" width="1" height="1" fill="var(--phi-outline)"/><rect x="11" y="11" width="1" height="1" fill="var(--phi-outline)"/><rect x="4" y="12" width="8" height="1" fill="var(--phi-outline)"/><rect x="5" y="2" width="6" height="1" fill="var(--phi-lamp-off)"/><rect x="4" y="3" width="8" height="1" fill="var(--phi-lamp-off)"/><rect x="3" y="4" width="10" height="1" fill="var(--phi-lamp-off)"/><rect x="3" y="5" width="10" height="1" fill="var(--phi-lamp-off)"/><rect x="3" y="6" width="10" height="1" fill="var(--phi-lamp-off-dark)"/><rect x="3" y="7" width="10" height="1" fill="var(--phi-lamp-off-dark)"/><rect x="4" y="8" width="8" height="1" fill="var(--phi-lamp-off-dark)"/><rect x="5" y="9" width="6" height="1" fill="var(--phi-lamp-off-dark)"/><rect x="6" y="10" width="4" height="1" fill="var(--phi-lamp-off-dark)"/><rect x="5" y="11" width="6" height="1" fill="var(--phi-lamp-off-dark)"/></svg>'
    + '<svg class="phi-part phi-eyes phi-eyes-x" viewBox="0 0 25 14" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" aria-hidden="true" draggable="false"><rect x="0" y="3" width="10" height="1" fill="var(--phi-outline)"/><rect x="15" y="3" width="10" height="1" fill="var(--phi-outline)"/><rect x="0" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="4" width="2" height="1" fill="var(--phi-outline)"/><rect x="6" y="4" width="2" height="1" fill="var(--phi-outline)"/><rect x="9" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="15" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="17" y="4" width="2" height="1" fill="var(--phi-outline)"/><rect x="21" y="4" width="2" height="1" fill="var(--phi-outline)"/><rect x="24" y="4" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="5" width="2" height="1" fill="var(--phi-outline)"/><rect x="3" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="6" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="8" y="5" width="2" height="1" fill="var(--phi-outline)"/><rect x="15" y="5" width="2" height="1" fill="var(--phi-outline)"/><rect x="18" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="21" y="5" width="1" height="1" fill="var(--phi-outline)"/><rect x="23" y="5" width="2" height="1" fill="var(--phi-outline)"/><rect x="1" y="6" width="2" height="1" fill="var(--phi-outline)"/><rect x="4" y="6" width="2" height="1" fill="var(--phi-outline)"/><rect x="7" y="6" width="2" height="1" fill="var(--phi-outline)"/><rect x="16" y="6" width="2" height="1" fill="var(--phi-outline)"/><rect x="19" y="6" width="2" height="1" fill="var(--phi-outline)"/><rect x="22" y="6" width="2" height="1" fill="var(--phi-outline)"/><rect x="0" y="7" width="2" height="1" fill="var(--phi-outline)"/><rect x="3" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="6" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="8" y="7" width="2" height="1" fill="var(--phi-outline)"/><rect x="15" y="7" width="2" height="1" fill="var(--phi-outline)"/><rect x="18" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="21" y="7" width="1" height="1" fill="var(--phi-outline)"/><rect x="23" y="7" width="2" height="1" fill="var(--phi-outline)"/><rect x="0" y="8" width="1" height="1" fill="var(--phi-outline)"/><rect x="2" y="8" width="2" height="1" fill="var(--phi-outline)"/><rect x="6" y="8" width="2" height="1" fill="var(--phi-outline)"/><rect x="9" y="8" width="1" height="1" fill="var(--phi-outline)"/><rect x="15" y="8" width="1" height="1" fill="var(--phi-outline)"/><rect x="17" y="8" width="2" height="1" fill="var(--phi-outline)"/><rect x="21" y="8" width="2" height="1" fill="var(--phi-outline)"/><rect x="24" y="8" width="1" height="1" fill="var(--phi-outline)"/><rect x="0" y="9" width="10" height="1" fill="var(--phi-outline)"/><rect x="15" y="9" width="10" height="1" fill="var(--phi-outline)"/><rect x="1" y="4" width="1" height="1" fill="var(--phi-error)"/><rect x="4" y="4" width="2" height="1" fill="var(--phi-error)"/><rect x="8" y="4" width="1" height="1" fill="var(--phi-error)"/><rect x="16" y="4" width="1" height="1" fill="var(--phi-error)"/><rect x="19" y="4" width="2" height="1" fill="var(--phi-error)"/><rect x="23" y="4" width="1" height="1" fill="var(--phi-error)"/><rect x="2" y="5" width="1" height="1" fill="var(--phi-error)"/><rect x="4" y="5" width="2" height="1" fill="var(--phi-error)"/><rect x="7" y="5" width="1" height="1" fill="var(--phi-error)"/><rect x="17" y="5" width="1" height="1" fill="var(--phi-error)"/><rect x="19" y="5" width="2" height="1" fill="var(--phi-error)"/><rect x="22" y="5" width="1" height="1" fill="var(--phi-error)"/><rect x="3" y="6" width="1" height="1" fill="var(--phi-error)"/><rect x="6" y="6" width="1" height="1" fill="var(--phi-error)"/><rect x="18" y="6" width="1" height="1" fill="var(--phi-error)"/><rect x="21" y="6" width="1" height="1" fill="var(--phi-error)"/><rect x="2" y="7" width="1" height="1" fill="var(--phi-error)"/><rect x="4" y="7" width="2" height="1" fill="var(--phi-error)"/><rect x="7" y="7" width="1" height="1" fill="var(--phi-error)"/><rect x="17" y="7" width="1" height="1" fill="var(--phi-error)"/><rect x="19" y="7" width="2" height="1" fill="var(--phi-error)"/><rect x="22" y="7" width="1" height="1" fill="var(--phi-error)"/><rect x="1" y="8" width="1" height="1" fill="var(--phi-error)"/><rect x="4" y="8" width="2" height="1" fill="var(--phi-error)"/><rect x="8" y="8" width="1" height="1" fill="var(--phi-error)"/><rect x="16" y="8" width="1" height="1" fill="var(--phi-error)"/><rect x="19" y="8" width="2" height="1" fill="var(--phi-error)"/><rect x="23" y="8" width="1" height="1" fill="var(--phi-error)"/></svg>'
    + '<div class="phi-keyboard" aria-hidden="true">'
    + '<div class="phi-kb-row"><i></i><i></i><i></i><i></i><i></i></div>'
    + '<div class="phi-kb-row"><i></i><i></i><i></i><i></i><i></i></div>'
    + '<div class="phi-kb-row"><i></i><i></i><i></i><i></i><i></i></div>'
    + '</div>'
    + '</div>'
    + '</div>';

  function _escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _sessionId() {
    return typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '';
  }

  // 与 graph.js 的同名函数**故意不合并**：那边在 getGraphState 缺失时返回一份默认
  // 状态，这边返回 null（表示「还没有状态」）。合成一份会静默改掉 Φ 的空态语义。
  // 下次看到两处同名想合并，先读这一行。
  // 解耦后（2026-09-30）：不带参读「当前 Φ 会话绑定的画布」——未绑定返回 null；
  // 带参读指定画布（_harnessCanApply 的指纹校验用）。
  function _harnessGraphState(sid) {
    if (typeof window.getGraphState !== 'function') return null;
    const target = sid !== undefined ? sid : _harnessBoundSid();
    return target ? window.getGraphState(target) : null;
  }

  let harnessSessionEpoch = 0;
  let harnessHistoryLoad = 0;

  // 画布版本指纹：只覆盖建议操作真正读写的图内容（节点、覆盖、删除标记、连线、端口）。
  // 平移/缩放/聚焦/坐标/折叠/时间戳是纯视图字段——用户在等待生成时挪一下画布，
  // 不该让建议作废。指纹用短串而非整份状态：历史条目不再随每条建议涨一份画布副本。
  const HARNESS_VERSION_FIELDS = ['customNodes', 'harnessNodeOverrides', 'harnessDeleted',
    'connections', 'removedEdges', 'portCounts', 'inputPortCounts'];

  function _harnessVersionSource(state) {
    const source = state || {};
    return JSON.stringify(HARNESS_VERSION_FIELDS.map(key =>
      Object.prototype.hasOwnProperty.call(source, key) ? source[key] : null));
  }

  function _harnessFingerprint(source) {
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return 'v2:' + (hash >>> 0).toString(16) + ':' + source.length;
  }

  function _harnessGraphVersion(sid) {
    return _harnessFingerprint(_harnessVersionSource(_harnessGraphState(sid)));
  }

  // 配方库指纹（2026-10-09 时效边界）：只覆盖每份配方的归一化实质配置——按 id 排序、
  // 逐字段 JSON，剔除 createdAt/updatedAt（服务端镜像对账 syncUserRecipesFromServer
  // 按 updatedAt 取新、可能整份搬运或只动时间戳，那不是用户改过的配置，不该让建议
  // 失效）。字段清单与 normalizeRecipeInput 的产出对齐；无配方库的载体（viewer）返回
  // 空列表的稳定指纹。仅 preset 相位的 binding 携带（其他模式冻结契约不变）。
  const HARNESS_RECIPE_FIELDS = ['name', 'desc', 'base', 'appearance', 'generate', 'ports',
    'content_kind', 'aggregation', 'analysis_phase', 'on_generated'];

  function _harnessRecipeVersionSource() {
    const recipes = (typeof getUserRecipes === 'function' ? getUserRecipes() : [])
      .slice()
      .sort((a, b) => String((a && a.id) || '').localeCompare(String((b && b.id) || '')));
    return JSON.stringify(recipes.map(recipe => {
      const parts = [String((recipe && recipe.id) || '')];
      HARNESS_RECIPE_FIELDS.forEach(key => {
        parts.push(recipe && Object.prototype.hasOwnProperty.call(recipe, key)
          ? JSON.stringify(recipe[key]) : '');
      });
      return parts.join('\u0001');
    }));
  }

  function _harnessRecipeVersion() {
    return _harnessFingerprint(_harnessRecipeVersionSource());
  }

  function _harnessBinding(mode) {
    // sessionId = 这条建议所属的画布（绑定 sid，即改图写回目标）；phiId/epoch 守 Φ 会话切换。
    const binding = { phiId: _phiId(), sessionId: _harnessBoundSid(), graphVersion: _harnessGraphVersion(), epoch: harnessSessionEpoch };
    // 创造模式（preset）的建议额外锁配方库指纹：图没变但配方被改/删时也要在应用前拦住。
    // 其他模式不带 recipeVersion（undefined = 不校验），既定冻结契约原样保留。
    if (String(mode || harnessMode) === 'preset') binding.recipeVersion = _harnessRecipeVersion();
    return binding;
  }

  // 旧条目迁移：阶段1 把整份画布状态当版本号存进历史，既占地方又永远比对失败。
  // 能解析的换算成内容指纹；解析不了的降级为「只校验会话」。
  function _harnessMigrateBinding(binding, sid) {
    const source = binding && typeof binding === 'object' ? binding : {};
    const version = typeof source.graphVersion === 'string' ? source.graphVersion : '';
    if (version.startsWith('v2:')) {
      return source.sessionId ? source : { ...source, sessionId: sid };
    }
    let migrated = null;
    if (version) {
      try { migrated = _harnessFingerprint(_harnessVersionSource(JSON.parse(version))); } catch (e) {}
    }
    return { ...source, sessionId: source.sessionId || sid, graphVersion: migrated };
  }

  // 历史条目按会话存储，来源可证：迁移时补上会话归属，缺指纹的旧建议才不会变成
  // 永远点不动的死按钮。会话对不上或内容已变，仍然拒绝。
  function _migrateHarnessHistory(entries, sid) {
    let changed = false;
    const migrated = entries.map(entry => {
      if (!entry || typeof entry !== 'object') return entry;
      const before = entry._binding;
      const binding = _harnessMigrateBinding(before, sid);
      if (before && typeof before === 'object' && before.sessionId === binding.sessionId
          && before.graphVersion === binding.graphVersion) return entry;
      changed = true;
      return { ...entry, _binding: binding };
    });
    return { entries: migrated, changed };
  }

  function _harnessCanApply(binding) {
    // 建议所属画布必须是当前打开的画布（应用走当前画布的实时视图与撤销栈）。
    // 图指纹：缺指纹（迁移前的旧条目）按画布放行；有指纹必须与当前内容一致。
    // 试用认领（trialGraphVersion＋非空 trialNodeIds）：承认「生成后唯一的确定性
    // 变更＝用户自己放的那次试用插入」——由试用路径严格比对后写入，不是忽略指纹。
    // 任何其它改动两个哈希都不匹配，照旧拦截；删掉试用节点后指纹回到 graphVersion，
    // 建议自动恢复可应用。
    // 配方库指纹（recipeVersion，仅 preset 相位携带）：图没变但配方被改/删也要拦。
    if (binding && binding.sessionId && binding.sessionId === _sessionId()) {
      const graphNow = (binding.graphVersion || binding.trialGraphVersion)
        ? _harnessGraphVersion(binding.sessionId) : '';
      const graphOk = (!binding.graphVersion && !binding.trialGraphVersion)
        || binding.graphVersion === graphNow
        || (!!binding.trialGraphVersion && binding.trialGraphVersion === graphNow
            && Array.isArray(binding.trialNodeIds) && binding.trialNodeIds.length > 0);
      const recipeOk = binding.recipeVersion === undefined
        || binding.recipeVersion === _harnessRecipeVersion();
      if (graphOk && recipeOk) return true;
      _setHarnessStatus(graphOk && !recipeOk
        ? '配方库已变化（配方被修改或删除），请重新生成建议后再应用'
        : '画布或会话已变化，请重新生成建议后再应用', 'error');
      return false;
    }
    _setHarnessStatus('画布或会话已变化，请重新生成建议后再应用', 'error');
    return false;
  }

  // ===== T51 桌宠让位正解：面板开着时 body.harness-open + 暂存被拖拽的内联定位 =====
  // 旧兜网是纯 CSS :has()，桌宠被拖过（JS 写了内联 left/top、right/bottom 置 auto）后失效。
  // 开面板时暂存内联定位并清掉，让让位规则生效；关面板时原样归还——
  // 桌宠关面板后回到用户拖放的位置。
  let harnessPetDragBackup = null;

  function _setHarnessPetYield(on) {
    const pet = harnessPet;
    if (!pet) return;
    if (on) {
      if (!harnessPetDragBackup) {
        harnessPetDragBackup = {
          left: pet.style.left || '', top: pet.style.top || '',
          right: pet.style.right || '', bottom: pet.style.bottom || '',
        };
        pet.style.left = ''; pet.style.top = '';
        pet.style.right = ''; pet.style.bottom = '';
      }
      document.body.classList.add('harness-open');
    } else {
      document.body.classList.remove('harness-open');
      if (harnessPetDragBackup) {
        pet.style.left = harnessPetDragBackup.left;
        pet.style.top = harnessPetDragBackup.top;
        pet.style.right = harnessPetDragBackup.right;
        pet.style.bottom = harnessPetDragBackup.bottom;
        harnessPetDragBackup = null;
      }
    }
  }

  function _harnessUndoSnapshot(state) {
    const nodes = _graphNodes().map(node => {
      const custom = (state.customNodes || []).find(item => item.id === node.id);
      const copy = JSON.parse(JSON.stringify(custom || node));
      copy._undoLocal = { custom: !!custom, fields: {} };
      for (const key of ['harnessNodeOverrides', 'harnessDeleted', 'positions', 'sizes', 'pinned', 'inputPortCounts']) {
        copy._undoLocal.fields[key] = Object.prototype.hasOwnProperty.call(state[key] || {}, node.id)
          ? { value: state[key][node.id] } : {};
      }
      return copy;
    });
    return JSON.parse(JSON.stringify({ nodes, edges: _graphEdges().map(edge => ({ ...edge, key: _edgeKey(edge) })) }));
  }

  // 安全阀：此前"拒绝建议全局清场"可能把大量节点标进 harnessDeleted 且无恢复出口。
  // 该函数一键解除全部软删除标记并重绘，供异常排查/恢复使用（控制台可调）。
  // 注意：恢复工具作用于【当前打开的画布】，不走 Φ 绑定（_harnessGraphState() 是绑定语义）
  function restoreAllHarnessDeletedNodes() {
    const state = typeof window.getGraphState === 'function' ? window.getGraphState(_sessionId()) : null;
    if (!state || !state.harnessDeleted) return 0;
    const count = Object.keys(state.harnessDeleted).length;
    state.harnessDeleted = {};
    if (count && typeof window.saveGraphState === 'function') window.saveGraphState(_sessionId(), state);
    if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
    if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    if (typeof window._setHarnessStatus === 'function') window._setHarnessStatus('已恢复 ' + count + ' 个被软删除的节点', 'ok');
    return count;
  }
  if (typeof window !== 'undefined') window.restoreHarnessDeletedNodes = restoreAllHarnessDeletedNodes;

  function restoreHarnessDeletedNodesConfirm() {
    const state = typeof window.getGraphState === 'function' ? window.getGraphState(_sessionId()) : null;
    const count = state && state.harnessDeleted ? Object.keys(state.harnessDeleted).length : 0;
    if (!count) {
      if (typeof window._setHarnessStatus === 'function') window._setHarnessStatus('没有需要恢复的节点', 'ok');
      return;
    }
    if (typeof window.confirm === 'function' && !window.confirm('检测到 ' + count + ' 个节点被此前的撤销/拒绝标记为删除，确定全部恢复吗？')) return;
    restoreAllHarnessDeletedNodes();
  }
  if (typeof window !== 'undefined') window.restoreHarnessDeletedNodesConfirm = restoreHarnessDeletedNodesConfirm;

  function ensureHarnessPanel() {
    if (harnessPanel) return harnessPanel;
    harnessPet = document.createElement('div');
    harnessPet.className = 'phi-pet-root';
    harnessPet.title = 'Φ 网络助手';
    harnessPet.innerHTML = PHI_PET_HTML;
    harnessPanel = document.createElement('div');
    // 第 5 轮磨砂化：Φ 面板统一极光磨砂玻璃（--dialog：composer 有输入框，可读性优先）。
    // graph-override.css 里本载体的 background 声明已全部拔掉——那边后加载，写了就会盖掉极光层
    harnessPanel.className = 'graph-harness-window aurora-glass aurora-glass--dialog';
    harnessPanel.hidden = true;
    harnessPanel.innerHTML = ''
      + '<div class="graph-harness-head" id="graphHarnessWindowHead">'
      + '<span class="graph-harness-title">网络助手</span>'
      + '<span class="graph-harness-session" id="graphHarnessSession">'
      + '<button type="button" id="graphHarnessSessionBtn" class="graph-harness-session-btn" onclick="toggleHarnessSessionMenu(event)" title="Φ 会话管理：新建/切换/清空对话（画布不受影响）"></button>'
      + '<div id="graphHarnessSessionMenu" class="graph-harness-session-menu aurora-glass" hidden></div>'
      + '</span>'
      + '<span class="graph-harness-head-actions">'
      + '<button type="button" onclick="restoreHarnessDeletedNodesConfirm()" title="恢复被撤销/拒绝标记删除的节点">↺</button><button type="button" onclick="toggleHarnessGuide()" title="使用引导">?</button>'
      + '<button type="button" onclick="closeGraphHarness()" aria-label="关闭">✕</button>'
      + '</span>'
      + '</div>'
      + '<div class="graph-harness-chat" id="graphHarnessChat"></div>'
      // T122：操作清单（原 #graphHarnessResult）与它的应用按钮行不再作为对话区之下的
      // 独立区块——那块一有内容就长到 228px 把对话区挤成 96px 窄条，真机读成「下面把
      // 上面挡住了」。两者改由 _historyMessageHtml 渲染在各自的助手气泡里（见
      // harness-preview.js 的 _harnessOpsCardHtml），面板因此只剩一条滚动区。
      // T96 撤销时间线：composer 之前。普通文档流区块＋max-height——Φ 面板有竖向预算
      // （对话区保底），绝不能做绝对定位浮层
      + '<div id="graphHarnessUndoTimeline" class="graph-harness-undo-timeline" hidden></div>'
      + '<div class="graph-harness-composer">'
      + '<details id="graphHarnessRecipeGuide" class="graph-harness-recipe-guide" ontoggle="if(this.open) _refreshHarnessRecipeTargets()" hidden>'
      + '<summary>配方起草与修改</summary>'
      + '<label>修改目标 <select id="graphHarnessRecipeTarget" aria-label="选择要修改的配方"></select></label>'
      + '<p>选中后只把这份配方的完整配置交给 Φ，没要求改的字段会保留。修改与保存配方需先把本 Φ 会话绑定到当前画布。</p>'
      + '<div class="graph-harness-recipe-starts">'
      + '<button type="button" onclick="fillHarnessRecipeBrief(\'review\')">错题复盘</button>'
      + '<button type="button" onclick="fillHarnessRecipeBrief(\'physics\')">物理建模</button>'
      + '<button type="button" onclick="fillHarnessRecipeBrief(\'formula\')">公式理解</button>'
      + '<button type="button" onclick="fillHarnessRecipeBrief(\'proof\')">数学证明</button>'
      + '</div><p>起草示例只填入输入框，不会自动发送或保存配方。</p></details>'
      + '<textarea id="graphHarnessInstruction" rows="2" placeholder="对网络助手说话…可改图，可提问"></textarea>'
      + '<div class="graph-harness-actions">'
      + '<span class="graph-harness-mode" id="graphHarnessMode">'
      + '<button type="button" id="graphHarnessModeBtn" class="graph-harness-mode-btn" onclick="toggleHarnessModeMenu(event)" title="切换工作模式：编辑可改图，答疑只读，创造做节点配方">模式：编辑</button>'
      + '<div id="graphHarnessModeMenu" class="graph-harness-mode-menu aurora-glass" hidden></div>'
      + '</span>'
      // T121：↩/🕘 换成 UI_ICON_SVG 的线性图标（undo / history）。emoji 走系统 emoji
      // 字体渲染，与面板其余线性图标和 13px 正文都不在一套视觉里，且撑宽按钮——
      // 400px 面板里三个按钮挤不下时会换行，成两行更不协调。图标在 ensureHarnessPanel
      // 尾部按 icons 注入，与会话菜单同一套范式。
      + '<button type="button" class="graph-harness-btn-undo" onclick="undoLastHarnessEdit()" title="撤销上一条已应用的修改（AI 智能撤销）" data-icon="undo">撤销上一条</button>'
      + '<button type="button" class="graph-harness-btn-undo" onclick="toggleHarnessUndoTimeline()" title="查看本会话已应用的批次，可回滚到任意批次之前" data-icon="history">撤销历史</button>'
      + '<button id="graphHarnessStopBtn" type="button" onclick="stopGraphHarness()" hidden>停止</button>'
      + '<button id="graphHarnessSendBtn" type="button" onclick="runGraphHarness()">发送</button>'
      + '</div>'
      + '<div id="graphHarnessStatus" class="graph-harness-status"></div>'
      + '</div>';
    document.body.appendChild(harnessPet);
    const phiEl = harnessPet.querySelector('[data-phi-pet]');
    if (phiEl && window.PhiPet && window.PhiPet.init) window.PhiPet.init(phiEl);
    document.body.appendChild(harnessPanel);
    // T121：把 data-icon 标记的按钮换成 UI_ICON_SVG 线性图标（emoji ↩/🕘 视觉不统一，
    // 且撑宽按钮导致 400px 面板里换行）。图标在前、文字在后，flex 排布。
    const icons = typeof UI_ICON_SVG !== 'undefined' ? UI_ICON_SVG : {};
    harnessPanel.querySelectorAll('button[data-icon]').forEach(btn => {
      const svg = icons[btn.getAttribute('data-icon')];
      if (!svg) return;
      btn.innerHTML = '<span class="graph-harness-btn-ico" aria-hidden="true">' + svg + '</span>' + btn.textContent;
    });
    _initHarnessDrag();
    // 下拉菜单（会话 + 模式）点外部收起（面板只建一次，监听器也只挂一次）
    document.addEventListener('click', event => {
      const target = event && event.target;
      if (!target || typeof target.closest !== 'function') return;
      const sessionMenu = document.getElementById('graphHarnessSessionMenu');
      if (sessionMenu && !sessionMenu.hidden && !target.closest('#graphHarnessSession')) sessionMenu.hidden = true;
      const modeMenu = document.getElementById('graphHarnessModeMenu');
      if (modeMenu && !modeMenu.hidden && !target.closest('#graphHarnessMode')) modeMenu.hidden = true;
    });
    const inputEl = document.getElementById('graphHarnessInstruction');
    if (inputEl) {
      inputEl.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          // T90：生成中按 Enter 不再丢弃——runGraphHarness 内部排队，等任务完成接着跑
          runGraphHarness();
        }
      });
    }
    return harnessPanel;
  }

  function _setHarnessStatus(text, kind) {
    const status = document.getElementById('graphHarnessStatus');
    if (!status) return;
    // T106：基础文案与「· Ns」计时后缀分开记——秒表只重写时间部分，不覆盖阶段文案
    harnessStatusBaseText = String(text || '');
    status.textContent = harnessStatusBaseText + _harnessElapsedSuffix();
    status.className = 'graph-harness-status' + (kind ? ' graph-harness-status-' + kind : '');
    if (kind === 'error') {
      harnessPhiError = true;
      _setPhiMode('error');
    } else if (kind === 'running') {
      _setPhiMode('working');
    }
  }

  // ===== T106 进度感（2026-09-30 评审路线第五步）=====
  // p90=37.6s 的裸等待只有一行阶段文案可看。秒表后缀 3 秒起显示（短请求不打扰）；
  // 结束时把耗时（＋多次调用/上下文 token）并进当时的终态文案后面。
  function _harnessElapsedSuffix() {
    if (!harnessStatusTickId || !harnessRunStartTs) return '';
    const sec = Math.max(0, Math.round((Date.now() - harnessRunStartTs) / 1000));
    return sec >= 3 ? ' · ' + sec + 's' : '';
  }

  function _harnessStartProgressTick() {
    if (harnessStatusTickId) { clearInterval(harnessStatusTickId); harnessStatusTickId = null; }
    harnessRunStartTs = Date.now();
    harnessStatusTickId = window.setInterval(() => {
      if (!harnessBusy) { _harnessStopProgressTick(null); return; }
      const status = document.getElementById('graphHarnessStatus');
      if (status) status.textContent = harnessStatusBaseText + _harnessElapsedSuffix();
    }, 1000);
  }

  // 停表并把摘要并进状态行当前文案（data＝本轮 result，null＝只记耗时）。
  // 终态文案可能是「审阅完成：N 条操作」「审阅失败：…」「已停止」——一律追加。
  function _harnessStopProgressTick(data) {
    if (harnessStatusTickId) { clearInterval(harnessStatusTickId); harnessStatusTickId = null; }
    if (!harnessRunStartTs) return;
    const sec = (Date.now() - harnessRunStartTs) / 1000;
    harnessRunStartTs = 0;
    const el = document.getElementById('graphHarnessStatus');
    if (!el) return;
    const parts = [sec >= 10 ? Math.round(sec) + 's' : sec.toFixed(1) + 's'];
    if (data) {
      const calls = Number(data.model_calls) || 0;
      if (calls > 1) parts.push(calls + ' 次模型调用');
      const tok = Number(data && data.context_metrics && data.context_metrics.est_tokens) || 0;
      if (tok > 0) parts.push('≈' + (tok >= 1000 ? (tok / 1000).toFixed(1) + 'k' : String(tok)) + ' tok 上下文');
    }
    // 剥掉秒表可能已叠加的「· Ns」尾巴再追加，避免双份耗时
    const base = String(el.textContent || '').replace(/\s*·\s*\d+s(\s*·.*)?$/, '');
    el.textContent = base + '（' + parts.join(' · ') + '）';
  }

  function _setHarnessBusy(busy) {
    harnessBusy = busy;
    if (harnessPanel) harnessPanel.classList.toggle('busy', busy);
    // T90：生成中发送钮保持可点（点了＝排队，runGraphHarness 内部接住），
    // 不再 send.disabled = busy——busy 视觉由停止按钮显隐/面板 busy 类/桌宠承担
    const stopBtn = document.getElementById('graphHarnessStopBtn');
    if (stopBtn) stopBtn.hidden = !busy;
    if (busy) {
      harnessPhiError = false;
      harnessPhiCelebrate = false;
      _setPhiMode('working');
    } else if (harnessPhiCelebrate) {
      harnessPhiCelebrate = false;
      _setPhiMode('celebrate');
      window.setTimeout(() => {
        if (!harnessBusy) _setPhiMode(harnessPhiError ? 'error' : 'idle');
      }, 2600);
    } else if (!harnessPhiError) {
      _setPhiMode('idle');
    } else {
      _setPhiMode('error');
    }
  }

  function _setPhiMode(mode) {
    const phi = harnessPet && harnessPet.querySelector('[data-phi-pet]');
    if (phi && window.PhiPet && window.PhiPet.setMode) window.PhiPet.setMode(phi, mode);
  }

  function _syncGraphPetToggleButton() {
    const visible = !!(harnessPet && harnessPet.style.display !== 'none');
    const btn = document.querySelector('.graph-harness-btn');
    if (btn) {
      btn.classList.toggle('active', visible);
      btn.setAttribute('aria-pressed', String(visible));
      btn.title = visible ? 'Φ 网络助手（点击隐藏）' : 'Φ 网络助手（点击显示）';
    }
  }

  // 面板开合后把桌宠显示状态同步成内联值。
  // 为什么需要：桌宠创建后没设过内联 display，于是 harnessPet.style.display === ''，
  // 而 toggleGraphPet 用 style.display !== 'none' 判断可见性 —— 空字符串意味着「可见」。
  // 结果是：页面刚打开时桌宠其实是隐藏的（.phi-pet-root 初始 display:none），
  // 但按钮第一下会走「隐藏」分支，只把本来就没显示的面板关一遍，看起来就是
  // 「Φ 按钮点了没反应」。把内联值同步成真实可见性后，这个分支才与画面一致。
  function _syncPetDisplayState() {
    if (!harnessPet) return;
    const actuallyVisible = getComputedStyle(harnessPet).display !== 'none';
    const inlineVisible = harnessPet.style.display !== 'none';
    if (actuallyVisible !== inlineVisible) {
      harnessPet.style.display = actuallyVisible ? '' : 'none';
    }
  }

  function toggleGraphPet() {
    ensureHarnessPanel();
    if (!harnessPet) return;
    _syncPetDisplayState();
    const visible = harnessPet.style.display !== 'none';
    if (visible) {
      harnessPet.style.display = 'none';
      closeGraphHarness();
    } else {
      harnessPet.style.display = '';
    }
    // 只开关桌宠本体；对话面板由点桌宠触发（harnessPet click → toggleGraphHarnessWindow）。
    // 2026-09-20 的「首点无反应」修复提交混入过一句无条件 openGraphHarness()，
    // 把按钮变成了「每次点都开面板」（用户 2026-09-24 点名纠正），已还原为纯开关。
    _syncGraphPetToggleButton();
  }

  function stopGraphHarness() {
    if (harnessAbortController) {
      harnessAbortController.abort();
      harnessAbortController = null;
    }
    harnessPhiError = false;
    harnessPhiCelebrate = false;
    _setHarnessStatus('已停止', 'ok');
    _setHarnessBusy(false);
    _setPhiMode('idle');
  }

  function _historyKey(sid) {
    return 'harness_history:' + sid;
  }

  function _historyId() {
    return 'h_' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  async function _loadHarnessHistory() {
    const phiId = _phiId();
    const loadId = ++harnessHistoryLoad;
    harnessHistory = [];
    if (!phiId) return;
    const localKey = _phiLocalKey(phiId);
    // 旧条目绑定迁移的兜底会话：绑定的画布（这些条目大概率生成于其绑定画布上）
    const bindingFallback = (_currentPhiSession() && _currentPhiSession().boundSid) || '';
    try {
      const local = JSON.parse(localStorage.getItem(localKey) || '[]');
      if (Array.isArray(local)) {
        const migrated = _migrateHarnessHistory(local, bindingFallback);
        harnessHistory = migrated.entries;
        // 只回写本地缓存：服务端副本还没读到，此刻推送可能用旧列表盖掉更新的服务端历史
        if (migrated.changed) {
          try { localStorage.setItem(localKey, JSON.stringify(harnessHistory)); } catch (e) {}
        }
      }
    } catch (e) {}
    try {
      const resp = await fetch('/api/kv/' + encodeURIComponent(_historyKey(phiId)));
      if (resp.ok) {
        const data = await resp.json();
        // 加载期间用户可能已切走 Φ 会话：旧会话的历史不得覆盖新会话视图
        if (loadId === harnessHistoryLoad && phiId === _phiId() && Array.isArray(data.value)) {
          const migrated = _migrateHarnessHistory(data.value, bindingFallback);
          harnessHistory = migrated.entries;
          try { localStorage.setItem(localKey, JSON.stringify(harnessHistory)); } catch (e) {}
          if (migrated.changed) _saveHarnessHistory();
        }
      }
    } catch (e) {}
  }

  async function _saveHarnessHistory() {
    const phiId = _phiId();
    if (!phiId) return;
    const localKey = _phiLocalKey(phiId);
    // 本地配额满不应连累面板渲染与服务端同步：历史仍可写服务端
    try { localStorage.setItem(localKey, JSON.stringify(harnessHistory)); }
    catch (e) { console.warn('[Harness] 历史本地缓存写入失败（可能超出配额）：', e); }
    try {
      await fetch('/api/kv/' + encodeURIComponent(_historyKey(phiId)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: harnessHistory }),
      });
    } catch (e) {}
  }

  function _renderHarnessChat() {
    const chat = document.getElementById('graphHarnessChat');
    if (!chat) return;
    chat._guideOpen = false;
    // T122：对话区现在是面板里唯一的滚动区，没有别的区块跟它抢高度了。但「用户是否
    // 在底部」这件事变得更要命——旧结构有结果区做高度缓冲，这里是整段对话：重渲染
    // 若无条件贴底，用户翻到一半看历史时，一次后台落盘（提交反馈、保留/删除建议）
    // 就会把他硬拽回最底。判据与流式路径（harness-run.js 的 80px 口径）一致。
    const stickBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
    // 最新一条「待处理且带操作」的助手条目：只有它渲染可勾选清单与应用按钮
    let currentOpsId = '';
    for (let i = harnessHistory.length - 1; i >= 0; i--) {
      const e = harnessHistory[i];
      if (e && e.role === 'assistant' && (e.operations || []).length && (!e.decision || e.decision === 'pending')) {
        currentOpsId = e.id || '';
        break;
      }
    }
    // T105：空状态不止一行字——内置引导早就写好了（标题栏 ?），把四个示例问题
    // 直接摆到明面上，新会话第一句话有着落
    chat.innerHTML = harnessHistory.length
      ? harnessHistory.map(entry => _historyMessageHtml(entry, currentOpsId)).join('')
      : '<div class="graph-harness-empty">还没有助手操作记录，试试：</div>'
        + '<div class="graph-harness-examples">'
        + HARNESS_EXAMPLE_QUESTIONS.map((q, i) => '<button type="button" onclick="sendHarnessExample(' + i + ')">' + _escapeHtml(q) + '</button>').join('')
        + '</div>';
    // 消息正文里的 <formula>/$$..$$ 由 renderMarkdown 转成 KaTeX 定界符，
    // 这里再跑一遍 renderMath 真正渲染公式（与画布正文同口径）。
    if (typeof renderMath === 'function') {
      try { renderMath(chat); } catch (e) {}
    }
    if (stickBottom) chat.scrollTop = chat.scrollHeight;
  }

  function _historyMessageHtml(entry, currentOpsId) {
    let actions = '';
    // T99：手动停止后留下的半截回答——给「从中断处继续」出口（不发请求的静态
    // 条目没有这套按钮，唯独这个）
    if (entry.role === 'assistant' && entry.interrupted) {
      actions += '<button type="button" class="graph-harness-continue-btn" onclick="continueHarnessInterrupted()">▶ 从中断处继续</button>';
    }
    if (entry.role === 'assistant' && entry.decision === 'pending' && (entry.operations || []).length) {
      actions += '<button type="button" onclick="previewHarnessSuggestion(\'' + entry.id + '\')">查看预览</button>'
        + '<button type="button" onclick="keepHarnessSuggestion(\'' + entry.id + '\')">保留修改</button>'
        + '<button type="button" onclick="discardHarnessSuggestion(\'' + entry.id + '\')">不保留修改</button>';
    }
    if (entry.role === 'assistant' && (entry.decision === 'keep' || entry.decision === 'discard')) {
      actions += '<span class="graph-harness-decision">' + (entry.decision === 'keep' ? '已保留' : '已忽略') + '</span>';
    }
    if (entry.role === 'assistant' && entry.decision === 'discard') {
      actions += '<button type="button" onclick="reapplyHarnessSuggestion(\'' + entry.id + '\')">重新应用</button>'
        + '<button type="button" onclick="restoreHarnessSuggestion(\'' + entry.id + '\')">恢复为待处理</button>';
    }
    if (entry.role === 'assistant') {
      const fb = entry.feedback || '';
      actions += '<span class="graph-harness-feedback">'
        + '<button type="button" class="graph-harness-feedback-btn' + (fb === 'good' ? ' active-good' : '') + '" onclick="_sendHarnessFeedback(\'' + entry.id + '\', \'good\')" title="这次回答有用">👍</button>'
        + '<button type="button" class="graph-harness-feedback-btn' + (fb === 'bad' ? ' active-bad' : '') + '" onclick="_sendHarnessFeedback(\'' + entry.id + '\', \'bad\')" title="没懂/改错了，点这里反馈">👎</button>'
        + '</span>';
    }
    actions += '<button type="button" onclick="deleteHarnessHistoryEntry(\'' + entry.id + '\')">删除记录</button>';
    const meta = entry.role === 'assistant'
      ? '<div class="graph-harness-meta">' + _escapeHtml(_harnessPhaseLabel(entry.phase)) + '</div>'
      : '';
    const role = entry.role || 'system';
    const avatar = role === 'assistant'
      ? '<span class="graph-harness-avatar" aria-hidden="true">Φ</span>'
      : (role === 'user' ? '<span class="graph-harness-avatar graph-harness-avatar-user" aria-hidden="true">我</span>' : '');
    const timeHtml = entry.timestamp
      ? '<span class="graph-harness-time">' + (typeof formatRelativeTime === 'function' ? formatRelativeTime(entry.timestamp) : '') + '</span>'
      : '';
    // T122：澄清选项与可勾选操作清单都渲染在气泡内（澄清过去写独立结果区）
    const clarifyOptions = Array.isArray(entry.clarifyOptions) && entry.clarifyOptions.length
      ? '<div class="graph-harness-clarify-options">'
        + entry.clarifyOptions.map(opt => '<button type="button" class="graph-harness-clarify-opt" onclick="runGraphHarnessWithText(this.textContent)">'
          + _escapeHtml(String(opt)) + '</button>').join('')
        + '</div>'
      : '';
    const opCard = entry.role === 'assistant' && typeof _harnessOpsCardHtml === 'function'
      ? _harnessOpsCardHtml(entry, !!entry.id && entry.id === currentOpsId)
      : '';
    return '<div class="graph-harness-message graph-harness-message-' + role + '" data-hentry-id="' + _escapeHtml(entry.id || '') + '">'
      + avatar
      + '<div class="graph-harness-message-main">'
      + '<div class="graph-harness-message-content">' + (role === 'assistant' && typeof renderMarkdown === 'function'
        ? renderMarkdown(entry.content || '')
        : _escapeHtml(entry.content || '')) + '</div>'
      + clarifyOptions
      + opCard
      + timeHtml
      + meta
      + (actions ? '<div class="graph-harness-message-actions">' + actions + '</div>' : '')
      + '</div>'
      + '</div>';
  }

  function _appendHarnessHistory(entry) {
    harnessHistory.push(entry);
    // 首条用户消息自动命名 Φ 会话（取前 12 字），省得满菜单「新 Φ 会话」
    const s = _currentPhiSession();
    if (s && entry && entry.role === 'user' && (!s.title || s.title === '新 Φ 会话') && entry.content) {
      s.title = String(entry.content).trim().slice(0, 12) || s.title;
      s.updatedAt = Date.now();
      _savePhiSessions();
      _syncHarnessSessionBtn();
    }
    _saveHarnessHistory().then(_renderHarnessChat);
  }

  function _showHarnessRetry(text) {
    const chat = document.getElementById('graphHarnessChat');
    if (!chat) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'graph-harness-message graph-harness-message-system';
    // T103：重试不再只有「原话重发」一个出口——配置了别的模型时给「换模型重试」
    //（一次性覆盖，不动用户槽位），外加「复制错误详情」便于排查/求助
    const alt = _harnessNextModelCandidate();
    const actions = '<button type="button" onclick="retryHarnessLastRequest()">重试</button>'
      + (alt ? '<button type="button" title="换 ' + _escapeHtml(alt.model || '') + ' 重发这次请求" onclick="retryHarnessLastRequest(true)">换模型重试</button>' : '')
      + '<button type="button" onclick="_copyHarnessErrorDetails()">复制错误详情</button>';
    wrapper.innerHTML = '<div class="graph-harness-message-content">' + _escapeHtml(text) + '</div>'
      + '<div class="graph-harness-message-actions">' + actions + '</div>';
    chat.appendChild(wrapper);
    chat.scrollTop = chat.scrollHeight;
  }

  // 从用户已配置模型里取「当前主模型之外」的第一个候选（T103 换模型重试用）。
  // 返回 null＝只配了一个模型/没配，按钮不出现。
  function _harnessNextModelCandidate() {
    let list = [];
    try { list = JSON.parse(localStorage.getItem('phymathia_user_models') || '[]'); } catch (e) { list = []; }
    if (!Array.isArray(list)) return null;
    const current = typeof window.getActiveModelForRole === 'function'
      ? (window.getActiveModelForRole('graph') || window.getActiveModelForRole('agent'))
      : null;
    const curId = current && current.id ? String(current.id) : '';
    const curName = String((current && current.model) || '');
    for (const item of list) {
      if (!item || !item.model) continue;
      if (curId && String(item.id || '') === curId) continue;
      if (!curId && curName && String(item.model) === curName) continue;
      return item;
    }
    return null;
  }

  function retryHarnessLastRequest(switchModel) {
    if (switchModel) {
      const alt = _harnessNextModelCandidate();
      if (!alt) { _setHarnessStatus('没有可切换的其他模型：请在「模型配置」里再配一个', 'error'); return; }
      harnessModelOverride = alt;
    }
    const instructionEl = document.getElementById('graphHarnessInstruction');
    if (instructionEl && harnessLastInstruction) instructionEl.value = harnessLastInstruction;
    runGraphHarness(harnessLastPhase);
  }

  // T103：把最近一次失败的模型/相位/指令/原始报错拼成可复制的文本
  function _copyHarnessErrorDetails() {
    const info = harnessLastError || {};
    const text = [
      '时间: ' + (info.ts ? new Date(info.ts).toLocaleString() : ''),
      '模型: ' + (info.model || ''),
      '相位: ' + (info.phase || ''),
      '指令: ' + (info.instruction || ''),
      '错误: ' + (info.raw || info.message || ''),
    ].join('\n');
    const done = () => { if (typeof toastMsg === 'function') toastMsg('已复制错误详情'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => _copyHarnessErrorFallback(text, done));
    } else {
      _copyHarnessErrorFallback(text, done);
    }
  }

  function _copyHarnessErrorFallback(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } catch (e) {
      if (typeof toastMsg === 'function') toastMsg('复制失败，请截图状态行');
    }
  }

  async function _sendHarnessFeedback(entryId, kind) {
    const entry = (harnessHistory || []).find(item => item.id === entryId);
    if (!entry || entry.feedback) return;
    if (kind === 'bad') {
      // 差评备注走面板内联小表单（Enter 提交 / Esc 跳过），不用 window.prompt——
      // 原生弹窗会打断画布沉浸，且样式与应用完全不搭
      _showHarnessFeedbackForm(entryId);
      return;
    }
    _submitHarnessFeedback(entry, kind, '');
  }

  function _showHarnessFeedbackForm(entryId) {
    const msg = (harnessPanel || document).querySelector('.graph-harness-message[data-hentry-id="' + entryId + '"]');
    if (!msg || msg.querySelector('.graph-harness-feedback-form')) return;
    const form = document.createElement('div');
    form.className = 'graph-harness-feedback-form';
    form.innerHTML = '<input type="text" maxlength="200" placeholder="Φ 哪里没懂 / 做错了？（一句话，可选）">'
      + '<button type="button" data-act="submit">提交反馈</button>'
      + '<button type="button" data-act="skip">跳过</button>';
    (msg.querySelector('.graph-harness-message-main') || msg).appendChild(form);
    const input = form.querySelector('input');
    const submitWith = (note) => {
      form.remove();
      const entry = (harnessHistory || []).find(item => item.id === entryId);
      _submitHarnessFeedback(entry, 'bad', note);
    };
    form.addEventListener('click', evt => {
      const act = evt.target && evt.target.dataset ? evt.target.dataset.act : '';
      if (act === 'submit') submitWith(String(input.value || '').trim());
      else if (act === 'skip') submitWith('');
    });
    input.addEventListener('keydown', evt => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        submitWith(String(input.value || '').trim());
      } else if (evt.key === 'Escape') {
        evt.stopPropagation();
        submitWith('');
      }
    });
    input.focus();
  }

  async function _submitHarnessFeedback(entry, kind, note) {
    if (!entry || entry.feedback) return;
    entry.feedback = kind;
    if (note) entry.feedbackNote = note;
    _saveHarnessHistory().then(_renderHarnessChat);
    try {
      await harnessFetchJson('/api/harness/graph/feedback', {
        kind,
        instruction: entry.instruction || entry.content || '',
        summary: entry.summary || entry.content || '',
        ops_count: Array.isArray(entry.operations) ? entry.operations.length : 0,
        phase: entry.phase || '',
        note,
        // session_id 是画布 id（后端历史语义，不许改）；T96 另加两个字段：本条回复
        // 对应的 review 事件 id（归因模型名/操作明细）与 Φ 会话 id（写进哪个事件文件）
        session_id: _sessionId(),
        event_id: entry.eventId || '',
        phi_session_id: (typeof _phiId === 'function' ? _phiId() : '') || '',
        // T109 归因三件套：设备号、模型名（条目落盘的当轮模型，旧数据空串）、
        // 操作明细（后端截前 20 条）——服务端不再只靠 event_id join 才能归因
        device_id: (typeof getDeviceId === 'function' ? getDeviceId() : ''),
        model: entry.model || '',
        operations: Array.isArray(entry.operations) ? entry.operations : [],
      });
      _setHarnessStatus('已记录反馈', 'ok');
    } catch (err) {
      _setHarnessStatus('反馈保存失败：' + err.message, 'error');
    }
  }

  async function _resolveHarnessFocus(candidates, instruction) {
    const model = typeof window.getActiveModelForRole === 'function'
      ? (window.getActiveModelForRole('graph') || window.getActiveModelForRole('agent'))
      : null;
    if (!model) {
      return { status: 'error', focus_node_ids: [], ambiguous: false, question: '请先配置主模型', candidates: [] };
    }
    const snapshot = buildHarnessSnapshot(false, candidates, null);
    try {
      return await harnessFetchJson('/api/harness/graph/resolve', {
        snapshot,
        instruction,
        model: _harnessModelForRequest(model),
        level: localStorage.getItem('phymathia_level') || 'university',
        retries: 2,
      });
    } catch (err) {
      throw new Error(_harnessErrorToHuman(String((err && err.message) || err || '目标解析失败')));
    }
  }

  function _initHarnessDrag() {
    if (!harnessPet || !harnessPanel) return;
    let petMoved = false;
    harnessPet.addEventListener('pointerdown', event => {
      event.preventDefault();
      const rect = harnessPet.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      petMoved = false;
      const move = ev => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 4) petMoved = true;
        harnessPet.style.left = (rect.left + dx) + 'px';
        harnessPet.style.top = (rect.top + dy) + 'px';
        harnessPet.style.right = 'auto';
        harnessPet.style.bottom = 'auto';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        // T229：触屏被系统抢占（来电/手势）只发 pointercancel 不发 pointerup——不收尾则
        // pointermove 残留，下次触摸用旧起点瞬移；cancel 与 up 走同一收尾（参照
        // graph-continent-view.js / chat.js 的 pointercancel 处理）
        window.removeEventListener('pointercancel', up);
        setTimeout(() => { petMoved = false; }, 0);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once: true });
      window.addEventListener('pointercancel', up);
    });
    harnessPet.addEventListener('click', () => {
      if (!petMoved) toggleGraphHarnessWindow();
    });
    const head = document.getElementById('graphHarnessWindowHead');
    if (head) {
      let winMoved = false;
      head.addEventListener('pointerdown', event => {
        if (event.target.closest('button')) return;
        event.preventDefault();
        const rect = harnessPanel.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        winMoved = false;
        const move = ev => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (Math.abs(dx) + Math.abs(dy) > 3) winMoved = true;
          harnessPanel.style.left = (rect.left + dx) + 'px';
          harnessPanel.style.top = (rect.top + dy) + 'px';
          harnessPanel.style.right = 'auto';
          harnessPanel.style.bottom = 'auto';
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          // T229：同上——系统抢占手势只发 pointercancel，不收尾则 pointermove 残留瞬移
          window.removeEventListener('pointercancel', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up, { once: true });
        window.addEventListener('pointercancel', up);
      });
    }
  }

  async function openGraphHarness() {
    const panel = ensureHarnessPanel();
    if (harnessPet) harnessPet.style.display = '';
    _syncGraphPetToggleButton();
    panel.hidden = false;
    if (harnessPet) harnessPet.classList.add('active');
    _setHarnessPetYield(true);
    _syncHarnessSessionBtn();
    _setHarnessStatus('');
    // T122：面板不再有独立结果区与应用按钮行要清（两者都在对话流里，随历史渲染）
    await _loadHarnessHistory();
    _renderHarnessChat();
  }

  function toggleGraphHarnessWindow() {
    if (!harnessPanel || harnessPanel.hidden) openGraphHarness();
    else closeGraphHarness();
  }

  // T105：空状态示例问题（点按钮＝回填输入框并发送；问答/改图各半，未绑定画布
  // 的会话点改图类会被现有门槛温和拦下并说明去向）
  const HARNESS_EXAMPLE_QUESTIONS = [
    '帮我梳理这张图的核心脉络，整理成一条主线',
    '细读画布里的内容，指出哪里理解有偏差',
    '用物理直觉和数学本质两个视角解释一下导数',
    '这张图还缺什么？给我一些拓展建议',
  ];

  function sendHarnessExample(index) {
    if (harnessBusy) { _setHarnessStatus('当前正在生成，等完成后再试', 'error'); return; }
    const q = HARNESS_EXAMPLE_QUESTIONS[Number(index)];
    if (!q) return;
    const inputEl = document.getElementById('graphHarnessInstruction');
    if (inputEl) inputEl.value = q;
    runGraphHarness();
  }

  const HARNESS_GUIDE_TEXT = [
    '# Φ 网络助手 · 使用引导',
    '',
    '我既是**改图助手**，也是**小问答助手**：既能增删、整理你的知识网络，也能直接回答物理 / 数学问题。',
    '',
    '## 三种模式（输入框下方「模式」按钮切换）',
    '- **编辑**（默认）：改图 + 问答，说「评价一下 / 进阶拓展」也会自动受理；',
    '- **答疑**（只读）：只回答、点评你的图，绝不改动它，空画布也能问；我会**先查再答**——自己去翻图里相关节点的全文、检索你的知识库和公式速查，引用时注明出处；',
    '- **✦ 创造**：对话式创作 / 修改**自定义节点**配方，详见下方「自定义节点」一节。',
    '',
    '## 自定义节点（切到「创造」模式对我说）',
    '- 想要画布上没有的节点类型？说清**叫什么、干什么用、要几个出口、喜欢什么颜色**，例如「做一个错题本节点，出口出 3 个复习问题」；',
    '- 配方和改图一样先预览、确认再应用；说「**放一个到画布上试试**」，我能直接帮你摆一张；**编辑模式也能直接放置**——对我说「把我的『错题本』配方放到画布上」即可；',
    '- 已有配方随时能改（「把错题本的出口改成 5 个」）也能删——**删配方不影响**画布上已建好的节点；',
    '- 画布**双击空白处**打开添加节点面板，「我的配方」组里随时手动加；右键模块类节点（模块/总结/知识点等）选「**存为配方**」，能把好用的节点变成模板反复用。',
    '',
    '## Φ 会话（与画布独立）',
    '- 标题旁的按钮管理 **Φ 会话**：新建 / 切换 / 清空对话——**画布永远不受影响**；',
    '- 会话可绑定一张画布，改的是绑定的画布；未绑定的会话只回答问题；',
    '- 删画布请用左侧栏，这里没有任何删除画布的入口。',
    '',
    '## 改图示例',
    '- 「帮我新增一个关于『导数』的知识点」',
    '- 「给『导数』补一个物理视角，连上去」',
    '- 「在『导数』后面加一条进阶学习链：AI回答 → 进阶学习」',
    '- 「评价一下『我的理解』这个节点，哪里不对」',
    '- 「把 A 和 B 连起来，说明它们的顺序」',
    '- 「撤销刚才的修改」',
    '',
    '## 问答示例（空画布也能问）',
    '- 「什么是牛顿第二定律？」',
    '- 「解释一下傅里叶变换的物理意义和数学本质」',
    '- 「导数和积分是什么关系？」',
    '- 「$$E=mc^2$$ 是什么？」',
    '',
    '## 使用技巧',
    '- 想改局部：先在画布**选中相关节点**再让我改，范围更准、更快。',
    '- 图太大时我只处理你选中的节点邻域，避免超长。',
    '- 修改不是立刻落图：结果里可「预览 / 应用所选 / 应用全部 / 撤销本次」。',
    '- 公式会自动用 KaTeX 渲染，markdown 也完整支持。',
    '',
  ].join('\n');

  function toggleHarnessGuide() {
    const chat = document.getElementById('graphHarnessChat');
    if (!chat) return;
    if (chat._guideOpen) {
      chat._guideOpen = false;
      _renderHarnessChat();
      return;
    }
    chat._guideOpen = true;
    chat.innerHTML = '<div class="graph-harness-guide">'
      + (typeof renderMarkdown === 'function' ? renderMarkdown(HARNESS_GUIDE_TEXT) : _escapeHtml(HARNESS_GUIDE_TEXT))
      + '<div class="graph-harness-guide-back"><button type="button" onclick="toggleHarnessGuide()">← 返回聊天</button></div>'
      + '</div>';
    if (typeof renderMath === 'function') {
      try { renderMath(chat); } catch (e) {}
    }
    chat.scrollTop = 0;
  }

  // ===== 三模式切换器（2026-09-30，D-R6 哲学推广）=====
  // edit 编辑（默认：可改图可问答，保留打字自动路由）/ chat 答疑（只读：
  // 只回答不改图，空画布可用）/ preset 创造（节点配方）。显式切换、意图
  // 自动识别让位；交互骨架复用会话切换器（含「hidden === false 才收起」拍板）
  const HARNESS_MODES = [
    { id: 'edit', label: '编辑', placeholder: '对网络助手说话…可改图，可提问', hint: '可改图，可问答' },
    { id: 'chat', label: '答疑', placeholder: '答疑模式：随便问，我不会动你的图', hint: '只读：只回答，不改图' },
    { id: 'preset', label: '创造', placeholder: '创造模式：告诉我你想要什么节点（用途/出口/长相），我来配…', hint: '对话式创作/修改节点配方' },
  ];

  function _harnessModeDef(id) {
    return HARNESS_MODES.find(item => item.id === id) || HARNESS_MODES[0];
  }

  function _applyHarnessModeUi() {
    const def = _harnessModeDef(harnessMode);
    const btn = document.getElementById('graphHarnessModeBtn');
    if (btn) {
      btn.textContent = '模式：' + def.label;
      btn.title = def.hint + '（点击切换模式）';
    }
    const inputEl = document.getElementById('graphHarnessInstruction');
    if (inputEl) inputEl.placeholder = def.placeholder;
    const guide = document.getElementById('graphHarnessRecipeGuide');
    if (guide) guide.hidden = harnessMode !== 'preset';
    if (harnessMode === 'preset') _refreshHarnessRecipeTargets();
  }

  function _refreshHarnessRecipeTargets() {
    const select = document.getElementById('graphHarnessRecipeTarget');
    if (!select) return;
    const current = select.value;
    const recipes = typeof getUserRecipes === 'function' ? getUserRecipes() : [];
    select.innerHTML = '<option value="">新建配方 / 未指定目标</option>'
      + recipes.map(recipe => '<option value="' + _escapeHtml(recipe.id) + '">'
        + _escapeHtml(recipe.name) + '</option>').join('');
    select.value = recipes.some(recipe => recipe.id === current) ? current : '';
  }

  // 本次请求锁定的创造模式上下文（发送起点解析一次；排队回放经 opts 传入入队
  // 时刻的值）。只影响这一次请求的快照与 binding，不写回 UI——用户当前看到的
  // 模式/目标不被后台回放改写，全局模式也不自动切换。
  function _harnessResolveRequestMode(opts) {
    const locked = opts && typeof opts.mode === 'string' ? opts.mode : '';
    return locked || harnessMode;
  }

  function _harnessResolveRecipeTargetId(opts) {
    if (opts && typeof opts.recipeTargetId === 'string') return opts.recipeTargetId;
    const select = document.getElementById('graphHarnessRecipeTarget');
    return select ? String(select.value || '') : '';
  }

  // targetId 显式传入（含空串＝明确不指定目标）时不再读 DOM：发送队列回放按
  // 入队时刻锁定的目标走，途中用户改下拉不影响在途请求。undefined 保持旧行为。
  function _attachHarnessRecipeContext(snapshot, targetId) {
    const targetValue = targetId === undefined
      ? _harnessResolveRecipeTargetId(null)
      : String(targetId || '');
    const recipes = typeof getUserRecipes === 'function' ? getUserRecipes() : [];
    const recipe = recipes.find(item => item.id === targetValue);
    if (!recipe) return snapshot;
    snapshot.recipe_detail = JSON.parse(JSON.stringify(recipe));
    const summaries = snapshot.user_recipes || recipes.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(item => ({ id: item.id, name: item.name }));
    snapshot.user_recipes = [{ id: recipe.id, name: recipe.name }, ...summaries.filter(item => item.id !== recipe.id)].slice(0, 32);
    return snapshot;
  }

  function fillHarnessRecipeBrief(key) {
    if (phyIsReadonly()) { phyReadonlyBlock('起草配方'); return; }
    const briefs = {
      review: '帮我创建一个错题复盘节点：用于高中学生，输出错因、正确思路、同类练习，提供「提示」和「再测一道」出口。',
      physics: '帮我创建一个物理建模节点：用于高中学生，依次说明研究对象、假设、受力、方程和结果检查，提供「解释假设」和「换个条件」出口。',
      formula: '帮我创建一个公式理解节点：用于高中学生，讲清适用条件、各量含义、量纲和常见误用，提供「推导过程」和「应用练习」出口。',
      proof: '帮我创建一个数学证明节点：用于高中学生，列出已知条件、关键思路、证明步骤和条件检查，提供「给个提示」和「反例检查」出口。',
    };
    const input = document.getElementById('graphHarnessInstruction');
    if (!input || !briefs[key]) return;
    if (String(input.value || '').trim()) {
      _setHarnessStatus('输入框已有内容，请先保留或清空，再选择起草示例。', 'ok');
      return;
    }
    const target = document.getElementById('graphHarnessRecipeTarget');
    if (target) target.value = '';
    input.value = briefs[key];
    input.focus();
  }

  function toggleHarnessModeMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('graphHarnessModeMenu');
    if (!menu) return;
    // 会话切换器同款：=== false 才收起（宽松 DOM 代理兼容，见手册 09-30 节拍板）
    if (menu.hidden === false) { menu.hidden = true; return; }
    menu.innerHTML = HARNESS_MODES.map(item =>
      '<button type="button" class="graph-harness-mode-item' + (item.id === harnessMode ? ' current' : '') + '" onclick="chooseHarnessMode(\'' + item.id + '\')">'
      + (item.id === harnessMode ? '✓ ' : '') + _escapeHtml(item.label)
      + '<span class="graph-harness-mode-hint">' + _escapeHtml(item.hint) + '</span>'
      + '</button>'
    ).join('')
      // T97/T95 前端半边：模式项之下的两个用户级开关。行内 onclick 必带 event——
      // 两个 handler 都 stopPropagation，点击只换文案不收菜单（与模式项「选中即收起」相反）。
      + '<div class="graph-harness-mode-sep"></div>'
      + '<button type="button" id="graphHarnessThinkingBtn" class="graph-harness-mode-item graph-harness-mode-toggle" onclick="cycleHarnessThinking(event)">'
      + '<span class="graph-harness-mode-label">' + HARNESS_THINKING_TEXT() + '</span></button>'
      + '<button type="button" id="graphHarnessFallbackBtn" class="graph-harness-mode-item graph-harness-mode-toggle" onclick="toggleHarnessFallback(event)">'
      + '<span class="graph-harness-btn-ico graph-harness-mode-icon" aria-hidden="true">'
      + ((typeof UI_ICON_SVG !== 'undefined' && UI_ICON_SVG.repeat) || '') + '</span>'
      + '<span class="graph-harness-mode-label">' + HARNESS_FALLBACK_TEXT() + '</span></button>';
    menu.hidden = false;
  }

  // ===== T97 深度思考档位 / T95 失败换备用模型开关（2026-09-30）=====
  // 两行都活在模式菜单底部：点击只更新自身文案＋toast（不收菜单），状态落 localStorage。
  // 档位是 ''/low/high/max 四档循环（显示：自动/浅/深/最深），参数映射同模型条目上的
  // thinking 字段，由后端按供应商族做；备用模型开关默认关（兜底是用户开关不是默认）。
  const HARNESS_THINKING_LEVELS = ['', 'low', 'high', 'max'];
  const HARNESS_THINKING_LABELS = { '': '自动', low: '浅', high: '深', max: '最深' };

  function _harnessThinkingLevel() {
    try {
      const value = String(localStorage.getItem(STORAGE_KEY_HARNESS_THINKING) || '');
      return HARNESS_THINKING_LEVELS.includes(value) ? value : '';
    } catch (e) { return ''; }
  }

  // 2026-10-10：两行的 emoji 前缀（🧠/🔁）换成图标制——深度思考整枚去掉，
  // 备用模型那行换 UI_ICON_SVG.repeat 线性图标。文案更新只写 .graph-harness-mode-label，
  // 免得 textContent 整节点覆盖把图标一起冲掉。
  function HARNESS_THINKING_TEXT() {
    return '深度思考：' + (HARNESS_THINKING_LABELS[_harnessThinkingLevel()] || '自动');
  }

  // 自动 → 浅 → 深 → 最深 → 自动；返回新档位（纯逻辑，smoke 直接调）
  function _cycleHarnessThinking() {
    const current = _harnessThinkingLevel();
    const next = HARNESS_THINKING_LEVELS[(HARNESS_THINKING_LEVELS.indexOf(current) + 1) % HARNESS_THINKING_LEVELS.length];
    if (typeof safeLocalStorageSet === 'function') safeLocalStorageSet(STORAGE_KEY_HARNESS_THINKING, next);
    const btn = document.getElementById('graphHarnessThinkingBtn');
    if (btn) _setHarnessToggleText(btn, HARNESS_THINKING_TEXT());
    if (typeof toastMsg === 'function') toastMsg('深度思考：' + HARNESS_THINKING_LABELS[next]);
    return next;
  }

  function cycleHarnessThinking(event) {
    if (event) event.stopPropagation();
    return _cycleHarnessThinking();
  }

  function _harnessFallbackEnabled() {
    try { return localStorage.getItem(STORAGE_KEY_HARNESS_FALLBACK) === '1'; } catch (e) { return false; }
  }

  function HARNESS_FALLBACK_TEXT() {
    return '失败自动换备用模型：' + (_harnessFallbackEnabled() ? '开' : '关');
  }

  // 只改按钮里的文案 span；宽松 DOM（冒烟沙箱）下 querySelector 返回代理时走 textContent 兜底。
  function _setHarnessToggleText(btn, text) {
    if (!btn) return;
    const label = typeof btn.querySelector === 'function' ? btn.querySelector('.graph-harness-mode-label') : null;
    if (label) label.textContent = text;
    else btn.textContent = text;
  }

  function toggleHarnessFallback(event) {
    if (event) event.stopPropagation();
    const next = !_harnessFallbackEnabled();
    if (typeof safeLocalStorageSet === 'function') safeLocalStorageSet(STORAGE_KEY_HARNESS_FALLBACK, next ? '1' : '0');
    const btn = document.getElementById('graphHarnessFallbackBtn');
    if (btn) _setHarnessToggleText(btn, HARNESS_FALLBACK_TEXT());
    if (typeof toastMsg === 'function') toastMsg('失败自动换备用模型：' + (next ? '开' : '关'));
    return next;
  }

  function chooseHarnessMode(id) {
    const menu = document.getElementById('graphHarnessModeMenu');
    if (menu) menu.hidden = true;
    if (!id || id === harnessMode) return;
    harnessMode = id;
    _applyHarnessModeUi();
    const notices = {
      edit: '已切回编辑模式：可改图，可问答',
      chat: '已切到答疑模式：只回答，不改图',
      preset: '✦ 创造模式已开启：只创作节点配方',
    };
    _setHarnessStatus(notices[harnessMode] || '模式已切换', 'ok');
  }

  function closeGraphHarness() {
    if (harnessPanel) harnessPanel.hidden = true;
    if (harnessPet) harnessPet.classList.remove('active');
    _setHarnessPetYield(false);
    harnessSingleEvalId = null;
    harnessPendingClarify = null;
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
  }

  // 页面加载即创建 Φ 桌宠（默认显示）；工具栏 Φ 按钮作为显隐开关，点击桌宠开关对话框
  ensureHarnessPanel();

  window._sendHarnessFeedback = _sendHarnessFeedback;
  window.toggleGraphPet = toggleGraphPet;
  window.stopGraphHarness = stopGraphHarness;
  window.syncGraphPetToggleButton = _syncGraphPetToggleButton;
  window.toggleHarnessGuide = toggleHarnessGuide;
  window.toggleHarnessModeMenu = toggleHarnessModeMenu;
  window.chooseHarnessMode = chooseHarnessMode;
  // T97/T95 前端半边：模式菜单底部两个开关的 handler 与纯函数（行内 onclick 与 smoke 用）
  window.cycleHarnessThinking = cycleHarnessThinking;
  window.toggleHarnessFallback = toggleHarnessFallback;
  window._harnessThinkingLevel = _harnessThinkingLevel;
  window._cycleHarnessThinking = _cycleHarnessThinking;
  window._harnessFallbackEnabled = _harnessFallbackEnabled;
  window._harnessMode = () => harnessMode;
  window.getGraphPetVisible = () => !!(harnessPet && harnessPet.style.display !== 'none');