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
  function _graphState() {
    return typeof window.getGraphState === 'function' ? window.getGraphState(_sessionId()) : null;
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

  function _harnessGraphVersion() {
    return _harnessFingerprint(_harnessVersionSource(_graphState()));
  }

  function _harnessBinding() {
    return { sessionId: _sessionId(), graphVersion: _harnessGraphVersion(), epoch: harnessSessionEpoch };
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
    // 会话必须一致；有指纹还必须与当前画布内容一致。指纹缺失只说明建议来自
    // 迁移前的旧条目（或状态无法解析），此时按会话校验放行这条已展示过的建议。
    if (binding && binding.sessionId === _sessionId()
        && (!binding.graphVersion || binding.graphVersion === _harnessGraphVersion())) return true;
    _setHarnessStatus('画布或会话已变化，请重新生成建议后再应用', 'error');
    return false;
  }

  function resetHarnessSession() {
    harnessSessionEpoch++;
    harnessHistoryLoad++;
    if (harnessAbortController) harnessAbortController.abort();
    harnessAbortController = null;
    harnessResult = null;
    harnessSnapshot = null;
    harnessPendingClarify = null;
    harnessSingleEvalId = null;
    harnessHistory = [];
    harnessLastAppliedOps = [];
    harnessLastAppliedBeforeSnapshot = null;
    _setHarnessBusy(false);
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    const box = document.getElementById('graphHarnessResult');
    if (box) box.innerHTML = '';
    _loadHarnessHistory().then(() => {
      _renderHarnessChat();
      _showHarnessSessionSwitchNotice();
      _syncHarnessSessionBtn();
    });
  }
  window.resetHarnessSession = resetHarnessSession;

  // ===== Φ 面板内会话切换器（2026-09-30）=====
  // Φ 的对话一直按画布会话隔离存储（harness_history_<sid>），此前整个机制是静默的：
  // 标题不显示绑的是哪个画布、切换瞬间对话换茬没有解释、面板内也无法切换。
  // 这里只让机制露面并给一个入口，切换走 session.js 的主路径 switchToSession
  // （存消息、换图状态、渲染画布全在其中），不在 Φ 侧另立一套会话数据。

  function _harnessCurrentSessionInfo() {
    const sid = _sessionId();
    const info = typeof window.getSessionById === 'function' ? window.getSessionById(sid) : null;
    return { id: sid, title: (info && info.title) || '未命名画布' };
  }

  function _syncHarnessSessionBtn() {
    const btn = document.getElementById('graphHarnessSessionBtn');
    if (!btn) return;
    btn.textContent = '《' + _harnessCurrentSessionInfo().title + '》';
  }

  function _showHarnessSessionSwitchNotice() {
    const chat = document.getElementById('graphHarnessChat');
    if (!chat) return;
    const notice = document.createElement('div');
    notice.className = 'graph-harness-session-notice';
    notice.textContent = '已切换到画布《' + _harnessCurrentSessionInfo().title + '》';
    chat.prepend(notice);
  }

  function toggleHarnessSessionMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('graphHarnessSessionMenu');
    if (!menu) return;
    // 「=== false 才收起」而非「!hidden 就收起」：冒烟沙箱的宽松 DOM 代理读 hidden
    // 得到真值对象，=== false 的写法让真实 DOM 语义不变、沙箱能走到建菜单分支
    if (menu.hidden === false) { menu.hidden = true; return; }
    const sessions = typeof window.getAllSessions === 'function' ? window.getAllSessions() : [];
    const currentId = _sessionId();
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    menu.innerHTML = sessions.length
      ? sessions.map(item => '<button type="button" class="graph-harness-session-item' + (item.id === currentId ? ' current' : '') + '" onclick="chooseHarnessSession(\'' + item.id + '\')">' + _escapeHtml(item.title || '未命名画布') + '</button>').join('')
      : '<div class="graph-harness-session-empty">暂无画布会话</div>';
    menu.hidden = false;
  }

  function chooseHarnessSession(id) {
    const menu = document.getElementById('graphHarnessSessionMenu');
    if (menu) menu.hidden = true;
    if (!id || id === _sessionId()) return;
    if (typeof window.switchToSession !== 'function') return;
    window.switchToSession(id).then(() => {
      // switchToSession 对生成中/未知 id 静默早退——用结果反推，失败给出解释
      if (_sessionId() !== id) _setHarnessStatus('当前正在生成，等任务完成后再切换画布', 'error');
    });
  }
  window.toggleHarnessSessionMenu = toggleHarnessSessionMenu;
  window.chooseHarnessSession = chooseHarnessSession;

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

  function _graphNodes() {
    return typeof window.getGraphViewNodes === 'function' ? window.getGraphViewNodes() : [];
  }

  function _graphEdges() {
    return typeof window.getGraphViewEdges === 'function' ? window.getGraphViewEdges() : [];
  }

  // _edgeKey 已上移到 utils.js（与 graph.js 共用一份）。这里直接用全局的，
  // 不再各算一遍——Φ 预览态与主画布态的连线键必须逐字一致，否则「预览里看得到、
  // 应用后没了」这类症状查不出根因。

  function _edgeParts(key) {
    const match = String(key || '').match(/^(.+?):(out-\d+)->(.+?):(in-\d+)$/);
    return match
      ? { from: match[1], fromPort: match[2], to: match[3], toPort: match[4] }
      : null;
  }

  function _moduleLabel(moduleKey) {
    const labels = {
      physics: '物理视角',
      math: '数学视角',
      graph: '知识图谱',
      viz: '交互可视化',
      socratic: '苏格拉底追问',
      learn: '进阶学习',
      manual: '我的回答',
      hub: '汇聚',
      summary: 'AI 总结',
      note: '我的总结',
      source: '输入',
      knowledge: '知识点',
      relation: '联系',
    };
    return labels[moduleKey] || moduleKey || '节点';
  }

  function _nodeLabel(node) {
    if (!node) return '';
    if (node.label) return node.label;
    if (node.title) return node.title;
    if (node.kind === 'user') return node.isRoot ? '核心问题' : (node.branchLabel || '问题');
    if (node.kind === 'answer') return node.branchLabel || node.summary || _harnessNodeContent(node).slice(0, 40) || 'AI 回答';
    if (node.kind === 'module') return _moduleLabel(node.moduleKey);
    return node.summary || node.content || '节点';
  }

  function _harnessNodeContent(node) {
    if (!node) return '';
    if (node.content || node.summary) return node.content || node.summary || '';
    if (node.messageIndex >= 0) {
      const msgs = typeof window.getSessionMessages === 'function' ? (window.getSessionMessages(_sessionId()) || []) : [];
      const msg = msgs[node.messageIndex] || null;
      if (msg) {
        if (typeof _nodeContent === 'function') return _nodeContent(msg, node);
        return String(msg.content || '');
      }
    }
    return '';
  }
  function _estimateTokens(text) {
    const s = String(text || '');
    let cjk = 0;
    let ascii = 0;
    for (let i = 0; i < s.length; i++) {
      if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(s[i])) cjk++;
      else ascii++;
    }
    return Math.ceil(cjk + ascii / 4);
  }

  function _detectHarnessPhase(instruction, evalNodes) {
    const text = String(instruction || '');
    const hasApply = /应用建议|采纳建议|按建议|执行建议/.test(text);
    const hasModify = /修改|改成|更正|纠正|重写|更新|删掉|删除|补充|新增|创建|连接|加上|加一个|补一个|改进|完善/.test(text);
    const hasExpand = /拓展|进阶|延伸学习|深入学习|深化/.test(text);
    const hasEval = /评价|建议|反馈|点评|指出|哪里需要改进|挑错|有问题吗|对不对|哪里不对|帮我看看/.test(text);
    if (hasApply && evalNodes.length) return 'apply';
    if (hasExpand) return 'expand';
    if (hasModify && !hasEval) return 'normal';
    if (hasEval) return 'evaluate';
    return 'normal';
  }

  function _detectFocusNodeIds(instruction, nodes) {
    const text = String(instruction || '');
    const matches = [];
    for (const node of nodes) {
      if (node.kind === 'ai_eval') continue;
      const label = String(_nodeLabel(node) || '').trim();
      if (!label || label.length < 2) continue;
      if (text.includes(label)) matches.push(node.id);
    }
    return Array.from(new Set(matches));
  }

  const HARNESS_NEIGHBORHOOD_THRESHOLD = 40;

  function _connectedNodeIds(nodes, edges, seedIds) {
    const seeds = new Set(seedIds || []);
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const adjacency = new Map();
    nodes.forEach(node => adjacency.set(node.id, []));
    edges.forEach(edge => {
      if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
        adjacency.get(edge.from).push(edge.to);
        adjacency.get(edge.to).push(edge.from);
      }
    });
    const seen = new Set(seeds);
    const queue = Array.from(seeds);
    while (queue.length) {
      const current = queue.shift();
      for (const next of adjacency.get(current) || []) {
        if (!seen.has(next) && nodeById.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return Array.from(seen);
  }

  function _neighborhoodNodeIds(nodes, edges, seedIds, maxDepth) {
    const seeds = new Set(seedIds || []);
    const adjacency = new Map();
    nodes.forEach(node => adjacency.set(node.id, []));
    edges.forEach(edge => {
      if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
        adjacency.get(edge.from).push(edge.to);
        adjacency.get(edge.to).push(edge.from);
      }
    });
    const seen = new Set(seeds);
    let frontier = Array.from(seeds);
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next = [];
      for (const id of frontier) {
        for (const nb of adjacency.get(id) || []) {
          if (!seen.has(nb)) { seen.add(nb); next.push(nb); }
        }
      }
      frontier = next;
    }
    return Array.from(seen);
  }

  function _kindLabel(kind) {
    const labels = {
      blank: 'AI 生成空白',
      user: '问题',
      answer: 'AI 回答',
      module: '模块',
      hub: '汇聚',
      summary: 'AI 总结',
      note: '我的总结',
      source: '输入',
      knowledge: '知识点',
      relation: '联系',
      human_note: '我的理解',
      ai_eval: 'AI 评价',
    };
    return labels[kind] || kind || '节点';
  }

  function buildHarnessSnapshot(excludeEval, focusIds, singleEvalId, continentData) {
    const state = _graphState() || {};
    const rawCanvasCount = _graphNodes().length;
    const deleted = new Set(Object.keys(state.harnessDeleted || {}));
    const nodes = _graphNodes().filter(node => !deleted.has(node.id) && !(excludeEval && node.kind === 'ai_eval'));
    const selected = new Set(
      typeof window.getSelectedGraphNodeIds === 'function' ? window.getSelectedGraphNodeIds() : []
    );
    let scopeNodes = selected.size ? nodes.filter(node => selected.has(node.id)) : nodes;
    if (singleEvalId) {
      const evalNode = nodes.find(node => node.id === singleEvalId);
      if (evalNode) {
        const targetId = evalNode.target_node_id || '';
        const seedIds = [singleEvalId, targetId].filter(Boolean);
        const connected = _connectedNodeIds(nodes, _graphEdges(), seedIds);
        scopeNodes = nodes.filter(node => connected.includes(node.id));
      }
    } else if (focusIds && focusIds.length) {
      const connected = _connectedNodeIds(nodes, _graphEdges(), focusIds);
      scopeNodes = nodes.filter(node => connected.includes(node.id));
    }
    const nodeIds = new Set(scopeNodes.map(node => node.id));
    const edges = _graphEdges().filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to));
    const focusSet = new Set(selected);
    (focusIds || []).forEach(id => focusSet.add(id));
    if (singleEvalId) focusSet.add(singleEvalId);

    // P2：大图且有焦点时，非 1-2 跳邻域节点降级为目录行（仅身份字段），
    // 模型仍可引用其 id/label，但不携带正文/公式以控制快照 token。
    const largeGraph = nodes.length > HARNESS_NEIGHBORHOOD_THRESHOLD;
    const neighborSet = largeGraph && focusSet.size
      ? new Set(_neighborhoodNodeIds(nodes, _graphEdges(), Array.from(focusSet), 2))
      : null;

    const snapshot = {
      version: 1,
      nodes: scopeNodes.map(node => {
        const isFocus = focusSet.has(node.id) || node.kind === 'ai_eval';
        if (neighborSet && !isFocus && !neighborSet.has(node.id)) {
          return { id: node.id, kind: node.kind, module_key: node.moduleKey || '', label: _nodeLabel(node).slice(0, 80), directory: true };
        }
        return {
          id: node.id,
          kind: node.kind,
          module_key: node.moduleKey || '',
          manual: !!node.manual,
          read_only: node.kind === 'user' && node.isRoot,
          label: _nodeLabel(node).slice(0, 80),
          content: (isFocus ? _harnessNodeContent(node) : _harnessNodeContent(node).slice(0, 80)).slice(0, 600),
          formula: isFocus ? String(node.formula || '').slice(0, 200) : '',
          items: node.kind === 'source' && Array.isArray(node.items)
            ? node.items.slice(0, 20).map(function (it) {
              return {
                title: String(it.title || it.label || '').slice(0, 80),
                summary: String(it.summary || '').slice(0, 200),
                formulas: Array.isArray(it.formulas) ? it.formulas.slice(0, 4).map(function (f) { return String(f); }) : [],
              };
            })
            : undefined,
          target_node_id: node.target_node_id || '',
          target_label: node.target_label || '',
          suggestion: node.suggestion || '',
          priority: node.priority || '',
        };
      }),
      edges: edges.map(edge => ({
        key: _edgeKey(edge),
        from: edge.from,
        to: edge.to,
        relation: String(edge.relation || ''),
        label: String(edge.label || ''),
        custom: !!edge.custom,
      })),
      // 节点类型清单由注册表派生（graph-recipes.js，P0 起单一事实源）；
      // 后端 normalize_snapshot 会放行该字段（T76 接通），P3 注入用户配方时才扩这份清单
      available_node_types: deriveHarnessAvailableNodeTypes(),
      scope_node_ids: Array.from(selected),
    };
    // 创造模式（P3）：用户配方清单摘要随快照注入（仿 quiz_weak 范式——结构化通道，
    // 绝不拼进 instruction 文本）。Φ 据此查重/更新/删除；preset 提示词有行为规则。
    const userRecipes = typeof getUserRecipes === 'function' ? getUserRecipes() : [];
    if (userRecipes.length) {
      snapshot.user_recipes = userRecipes.map(recipe => {
        const entry = {
          id: String(recipe.id || ''),
          name: String(recipe.name || ''),
          base_kind: (recipe.base && recipe.base.kind) || '',
          content_kind: String(recipe.content_kind || ''),
        };
        if (recipe.desc) entry.desc = String(recipe.desc);
        const staticCount = (recipe.ports && Array.isArray(recipe.ports.static)) ? recipe.ports.static.length : 0;
        const hasDynamic = !!(recipe.ports && recipe.ports.dynamic);
        entry.ports = '静态 ' + staticCount + (hasDynamic ? ' ＋ 动态解析' : '');
        return entry;
      });
    }
    // M2（P0-A 检测闭环）：检测侧薄弱点随快照注入（当前会话 Top3，每条一行）。
    // 只作口头提示依据——提示词明文禁止据此创建任何状态类图元素；无薄弱点时不带该字段。
    const weakPoints = _harnessQuizWeak();
    if (weakPoints.length) snapshot.quiz_weak = weakPoints;
    // 大陆计划 v3（Φ 摆渡）：当前画布概念与其他画布的共享点随快照注入。Φ 只能
    // 【口头】建议去大陆连接——跨画布连线不是本画布图操作，落笔在大陆弹层里用户确认。
    const continentShared = continentData ? _harnessContinentShared(continentData) : [];
    if (continentShared.length) snapshot.continent_shared = continentShared;
    const serialized = JSON.stringify({ nodes: snapshot.nodes, edges: snapshot.edges, quiz_weak: snapshot.quiz_weak, continent_shared: snapshot.continent_shared });
    snapshot.snapshot_meta = {
      total_nodes: nodes.length,
      directory_nodes: snapshot.nodes.filter(n => n.directory).length,
      sent_nodes: snapshot.nodes.length,
      truncated: snapshot.nodes.length < nodes.length,
      deleted_filtered: Math.max(0, rawCanvasCount - nodes.length),
      est_tokens: _estimateTokens(serialized),
    };
    return snapshot;
  }

  // 当前会话的薄弱知识点（复用检测侧同一口径 _quizStatSummary('session').weak，取 Top3）
  function _harnessQuizWeak() {
    if (typeof _quizStatSummary !== 'function') return [];
    let summary = null;
    try {
      summary = _quizStatSummary('session');
    } catch (e) {
      return [];
    }
    return ((summary && summary.weak) || []).slice(0, 3).map(item => ({
      title: String(item.title || '').slice(0, 40),
      wrong: Number(item.wrong) || 0,
      mastery: Number(item.mastery) || 0,
      sessionId: String(item.sessionId || ''),
    })).filter(item => item.title);
  }

  // ===== 大陆计划 v3（Φ 摆渡）：跨画布共享点随快照注入 =====
  // /api/continent 是纯本地现算（无模型调用），但也不必每次审阅都拉——60s 缓存，
  // 失败静默返回 null（大陆查空是正常路径，不阻断 Φ）。
  let _harnessContinentCache = null;
  async function _harnessFetchContinent() {
    const now = Date.now();
    if (_harnessContinentCache && now - _harnessContinentCache.at < 60000) {
      return _harnessContinentCache.data;
    }
    try {
      const resp = await fetch('/api/continent', { cache: 'no-cache' });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data || !Array.isArray(data.clusters)) return null;
      _harnessContinentCache = { at: now, data };
      return data;
    } catch (e) {
      return null;
    }
  }

  // 从大陆投影里挑出**涉及当前会话**的共享概念：每条给「我这边的概念名、
  // 对面的概念名、对面画布名、共享词」。Φ 拿到后只口头建议，不落任何图操作。
  function _harnessContinentShared(data) {
    const mySid = String(_sessionId() || '');
    if (!mySid || !data) return [];
    const itemTitle = {}, clusterTitle = {};
    (data.clusters || []).forEach(c => {
      clusterTitle[c.sessionId] = c.title || '未命名画布';
      (c.items || []).forEach(it => { itemTitle[it.itemId] = it.title || ''; });
    });
    const out = [], seen = new Set();
    (data.shared || []).forEach(s => {
      if (seen.has(s.label)) return;
      // v4：弱证据（2 字共享串「表达」「坐标」级）不喂给 Φ——它是语法碎片不是共享点，
      // 让模型据此建议「去大陆连起来」只会把用户引向噪声（地图侧同样折叠它们）
      if (s.strength === 'weak') return;
      // v5.5：被更具体标签覆盖的条目（服务端 covered）地图上不单独成城，同样不喂 Φ
      if (s.covered) return;
      (s.links || []).some(l => {
        const mineIsFrom = l.fromSession === mySid;
        const mineIsTo = l.toSession === mySid;
        if (!mineIsFrom && !mineIsTo) return false;
        const myItem = mineIsFrom ? l.from : l.to;
        const peerItem = mineIsFrom ? l.to : l.from;
        const peerSid = mineIsFrom ? l.toSession : l.fromSession;
        const myTitle = itemTitle[myItem], peerTitle = itemTitle[peerItem];
        if (!myTitle || !peerTitle) return false;
        seen.add(s.label);
        out.push({
          label: String(s.label || '').slice(0, 40),
          kind: s.kind === 'formula' ? 'formula' : (s.kind === 'family' ? 'family' : 'title'),
          my_title: myTitle.slice(0, 40),
          peer_title: peerTitle.slice(0, 40),
          peer_session: String(clusterTitle[peerSid] || '').slice(0, 40),
        });
        return true;
      });
    });
    return out.slice(0, 4);
  }

  // 安全阀：此前"拒绝建议全局清场"可能把大量节点标进 harnessDeleted 且无恢复出口。
  // 该函数一键解除全部软删除标记并重绘，供异常排查/恢复使用（控制台可调）。
  function restoreAllHarnessDeletedNodes() {
    const state = _graphState();
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
    const state = _graphState();
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
      + '<button type="button" id="graphHarnessSessionBtn" class="graph-harness-session-btn" onclick="toggleHarnessSessionMenu(event)" title="当前对话绑定的画布会话，点击切换"></button>'
      + '<div id="graphHarnessSessionMenu" class="graph-harness-session-menu aurora-glass" hidden></div>'
      + '</span>'
      + '<span class="graph-harness-head-actions">'
      + '<button type="button" onclick="restoreHarnessDeletedNodesConfirm()" title="恢复被撤销/拒绝标记删除的节点">↺</button><button type="button" onclick="toggleHarnessGuide()" title="使用引导">?</button>'
      + '<button type="button" onclick="closeGraphHarness()" aria-label="关闭">✕</button>'
      + '</span>'
      + '</div>'
      + '<div class="graph-harness-chat" id="graphHarnessChat"></div>'
      + '<div class="graph-harness-result" id="graphHarnessResult"></div>'
      + '<div class="graph-harness-apply-actions" id="graphHarnessApplyActions" hidden>'
      + '<button type="button" onclick="applySelectedGraphHarness()" title="应用勾选的操作">应用所选</button>'
      + '<button type="button" onclick="applyGraphHarness()" title="应用全部操作">应用全部</button>'
      + '<button type="button" onclick="undoGraphHarness()" title="撤销本次全部修改">撤销本次</button>'
      + '</div>'
      + '<div class="graph-harness-composer">'
      + '<textarea id="graphHarnessInstruction" rows="2" placeholder="对网络助手说话…可改图，可提问"></textarea>'
      + '<div class="graph-harness-actions">'
      + '<span class="graph-harness-mode" id="graphHarnessMode">'
      + '<button type="button" id="graphHarnessModeBtn" class="graph-harness-mode-btn" onclick="toggleHarnessModeMenu(event)" title="切换工作模式：编辑可改图，答疑只读，创造做节点配方">模式：编辑</button>'
      + '<div id="graphHarnessModeMenu" class="graph-harness-mode-menu aurora-glass" hidden></div>'
      + '</span>'
      + '<button type="button" class="graph-harness-btn-undo" onclick="undoLastHarnessEdit()" title="撤销上一条已应用的修改（AI 智能撤销）">↩ 撤销上一条</button>'
      + '<button id="graphHarnessStopBtn" type="button" onclick="stopGraphHarness()" hidden>停止</button>'
      + '<button id="graphHarnessSendBtn" type="button" onclick="runGraphHarness()">发送</button>'
      + '</div>'
      + '<div id="graphHarnessStatus" class="graph-harness-status"></div>'
      + '</div>';
    document.body.appendChild(harnessPet);
    const phiEl = harnessPet.querySelector('[data-phi-pet]');
    if (phiEl && window.PhiPet && window.PhiPet.init) window.PhiPet.init(phiEl);
    document.body.appendChild(harnessPanel);
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
          if (!harnessBusy) runGraphHarness();
        }
      });
    }
    return harnessPanel;
  }

  function _setHarnessStatus(text, kind) {
    const status = document.getElementById('graphHarnessStatus');
    if (!status) return;
    status.textContent = text || '';
    status.className = 'graph-harness-status' + (kind ? ' graph-harness-status-' + kind : '');
    if (kind === 'error') {
      harnessPhiError = true;
      _setPhiMode('error');
    } else if (kind === 'running') {
      _setPhiMode('working');
    }
  }

  function _setHarnessBusy(busy) {
    harnessBusy = busy;
    if (harnessPanel) harnessPanel.classList.toggle('busy', busy);
    const send = document.getElementById('graphHarnessSendBtn');
    if (send) send.disabled = busy;
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
    const sid = _sessionId();
    const loadId = ++harnessHistoryLoad;
    harnessHistory = [];
    if (!sid) return;
    const localKey = 'phymathia_harness_history_' + sid;
    try {
      const local = JSON.parse(localStorage.getItem(localKey) || '[]');
      if (Array.isArray(local)) {
        const migrated = _migrateHarnessHistory(local, sid);
        harnessHistory = migrated.entries;
        // 只回写本地缓存：服务端副本还没读到，此刻推送可能用旧列表盖掉更新的服务端历史
        if (migrated.changed) {
          try { localStorage.setItem(localKey, JSON.stringify(harnessHistory)); } catch (e) {}
        }
      }
    } catch (e) {}
    try {
      const resp = await fetch('/api/kv/' + encodeURIComponent(_historyKey(sid)));
      if (resp.ok) {
        const data = await resp.json();
        // 加载期间用户可能已切走会话：旧会话的历史不得覆盖新会话视图
        if (loadId === harnessHistoryLoad && sid === _sessionId() && Array.isArray(data.value)) {
          const migrated = _migrateHarnessHistory(data.value, sid);
          harnessHistory = migrated.entries;
          try { localStorage.setItem(localKey, JSON.stringify(harnessHistory)); } catch (e) {}
          if (migrated.changed) _saveHarnessHistory();
        }
      }
    } catch (e) {}
  }

  async function _saveHarnessHistory() {
    const sid = _sessionId();
    if (!sid) return;
    const localKey = 'phymathia_harness_history_' + sid;
    // 本地配额满不应连累面板渲染与服务端同步：历史仍可写服务端
    try { localStorage.setItem(localKey, JSON.stringify(harnessHistory)); }
    catch (e) { console.warn('[Harness] 历史本地缓存写入失败（可能超出配额）：', e); }
    try {
      await fetch('/api/kv/' + encodeURIComponent(_historyKey(sid)), {
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
    chat.innerHTML = harnessHistory.length
      ? harnessHistory.map(entry => _historyMessageHtml(entry)).join('')
      : '<div class="graph-harness-empty">还没有助手操作记录</div>';
    // 消息正文里的 <formula>/$$..$$ 由 renderMarkdown 转成 KaTeX 定界符，
    // 这里再跑一遍 renderMath 真正渲染公式（与画布正文同口径）。
    if (typeof renderMath === 'function') {
      try { renderMath(chat); } catch (e) {}
    }
    chat.scrollTop = chat.scrollHeight;
  }

  function _historyMessageHtml(entry) {
    let actions = '';
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
      ? '<div class="graph-harness-meta">' + (entry.phase || '') + '</div>'
      : '';
    const role = entry.role || 'system';
    const avatar = role === 'assistant'
      ? '<span class="graph-harness-avatar" aria-hidden="true">Φ</span>'
      : (role === 'user' ? '<span class="graph-harness-avatar graph-harness-avatar-user" aria-hidden="true">我</span>' : '');
    const timeHtml = entry.timestamp
      ? '<span class="graph-harness-time">' + (typeof formatRelativeTime === 'function' ? formatRelativeTime(entry.timestamp) : '') + '</span>'
      : '';
    return '<div class="graph-harness-message graph-harness-message-' + role + '" data-hentry-id="' + _escapeHtml(entry.id || '') + '">'
      + avatar
      + '<div class="graph-harness-message-main">'
      + '<div class="graph-harness-message-content">' + (role === 'assistant' && typeof renderMarkdown === 'function'
        ? renderMarkdown(entry.content || '')
        : _escapeHtml(entry.content || '')) + '</div>'
      + timeHtml
      + meta
      + (actions ? '<div class="graph-harness-message-actions">' + actions + '</div>' : '')
      + '</div>'
      + '</div>';
  }

  function _appendHarnessHistory(entry) {
    harnessHistory.push(entry);
    _saveHarnessHistory().then(_renderHarnessChat);
  }

  function _showHarnessRetry(text) {
    const chat = document.getElementById('graphHarnessChat');
    if (!chat) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'graph-harness-message graph-harness-message-system';
    wrapper.innerHTML = '<div class="graph-harness-message-content">' + _escapeHtml(text) + '</div>'
      + '<div class="graph-harness-message-actions"><button type="button" onclick="retryHarnessLastRequest()">重试</button></div>';
    chat.appendChild(wrapper);
    chat.scrollTop = chat.scrollHeight;
  }

  function retryHarnessLastRequest() {
    const instructionEl = document.getElementById('graphHarnessInstruction');
    if (instructionEl && harnessLastInstruction) instructionEl.value = harnessLastInstruction;
    runGraphHarness(harnessLastPhase);
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
        session_id: _sessionId(),
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
        setTimeout(() => { petMoved = false; }, 0);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once: true });
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
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up, { once: true });
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
    const resultBox = document.getElementById('graphHarnessResult');
    if (resultBox) resultBox.innerHTML = '';
    document.getElementById('graphHarnessApplyActions')?.setAttribute('hidden', '');
    await _loadHarnessHistory();
    _renderHarnessChat();
  }

  function toggleGraphHarnessWindow() {
    if (!harnessPanel || harnessPanel.hidden) openGraphHarness();
    else closeGraphHarness();
  }

  const HARNESS_GUIDE_TEXT = [
    '# Φ 网络助手 · 使用引导',
    '',
    '我既是**改图助手**，也是**小问答助手**：既能增删、整理你的知识网络，也能直接回答物理 / 数学问题。',
    '',
    '## 三种模式（输入框下方「模式」按钮切换）',
    '- **编辑**（默认）：改图 + 问答，说「评价一下 / 进阶拓展」也会自动受理；',
    '- **答疑**（只读）：只回答、点评你的图，绝不改动它，空画布也能问；',
    '- **✦ 创造**：对话式创作 / 修改「节点配方」，还能放到画布上试试。',
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
    { id: 'preset', label: '✦ 创造', placeholder: '创造模式：告诉我你想要什么节点（用途/出口/长相），我来配…', hint: '对话式创作/修改节点配方' },
  ];

  function _harnessModeDef(id) {
    return HARNESS_MODES.find(item => item.id === id) || HARNESS_MODES[0];
  }

  function _applyHarnessModeUi() {
    const def = _harnessModeDef(harnessMode);
    const btn = document.getElementById('graphHarnessModeBtn');
    if (btn) {
      btn.textContent = '模式：' + def.label;
      btn.classList.toggle('on', harnessMode !== 'edit');
      btn.title = def.hint + '（点击切换模式）';
    }
    const inputEl = document.getElementById('graphHarnessInstruction');
    if (inputEl) inputEl.placeholder = def.placeholder;
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
    ).join('');
    menu.hidden = false;
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
  window._harnessMode = () => harnessMode;
  window.getGraphPetVisible = () => !!(harnessPet && harnessPet.style.display !== 'none');