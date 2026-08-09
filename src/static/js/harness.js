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
  let harnessPhiError = false;
  let harnessPhiCelebrate = false;
  let harnessAbortController = null;
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

  function _graphState() {
    return typeof window.getGraphState === 'function' ? window.getGraphState(_sessionId()) : null;
  }

  function _graphNodes() {
    return typeof window.getGraphViewNodes === 'function' ? window.getGraphViewNodes() : [];
  }

  function _graphEdges() {
    return typeof window.getGraphViewEdges === 'function' ? window.getGraphViewEdges() : [];
  }

  function _edgeKey(edge) {
    return (edge.from || '') + ':' + (edge.fromPort || 'out-0') + '->' + (edge.to || '') + ':' + (edge.toPort || 'in-0');
  }

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
      manual: '非 AI 回答',
      hub: '汇聚',
      summary: 'AI 总结',
      note: '人工总结',
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

  function _kindLabel(kind) {
    const labels = {
      blank: '空白节点',
      user: '问题',
      answer: 'AI 回答',
      module: '模块',
      hub: '汇聚',
      summary: 'AI 总结',
      note: '人工总结',
      source: '输入',
      knowledge: '知识点',
      relation: '联系',
      human_note: '我的理解',
      ai_eval: 'AI 评价',
    };
    return labels[kind] || kind || '节点';
  }

  function buildHarnessSnapshot(excludeEval, focusIds, singleEvalId) {
    const state = _graphState() || {};
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

    const snapshot = {
      version: 1,
      nodes: scopeNodes.map(node => {
        const isFocus = focusSet.has(node.id) || node.kind === 'ai_eval';
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
      available_node_types: [
        { kind: 'module', module_key: 'physics', label: '物理视角' },
        { kind: 'module', module_key: 'math', label: '数学视角' },
        { kind: 'module', module_key: 'graph', label: '知识图谱' },
        { kind: 'module', module_key: 'viz', label: '交互可视化' },
        { kind: 'module', module_key: 'socratic', label: '苏格拉底追问' },
        { kind: 'module', module_key: 'learn', label: '进阶学习' },
        { kind: 'knowledge', label: '知识点' },
        { kind: 'relation', label: '联系' },
        { kind: 'human_note', label: '我的理解' },
        { kind: 'note', label: '人工总结' },
        { kind: 'hub', label: '汇聚' },
        { kind: 'summary', label: 'AI 总结' },
        { kind: 'source', label: '输入' },
        { kind: 'blank', label: '空白节点' },
        { kind: 'user', label: '问题' },
        { kind: 'answer', label: 'AI 回答' },
        { kind: 'ai_eval', label: 'AI 评价' },
      ],
      scope_node_ids: Array.from(selected),
    };
    const serialized = JSON.stringify({ nodes: snapshot.nodes, edges: snapshot.edges });
    snapshot.snapshot_meta = {
      total_nodes: nodes.length,
      sent_nodes: snapshot.nodes.length,
      truncated: snapshot.nodes.length < nodes.length,
      est_tokens: _estimateTokens(serialized),
    };
    return snapshot;
  }

  function ensureHarnessPanel() {
    if (harnessPanel) return harnessPanel;
    harnessPet = document.createElement('div');
    harnessPet.className = 'phi-pet-root';
    harnessPet.title = 'Φ · AI 网络助手';
    harnessPet.innerHTML = PHI_PET_HTML;
    harnessPanel = document.createElement('div');
    harnessPanel.className = 'graph-harness-window';
    harnessPanel.hidden = true;
    harnessPanel.innerHTML = ''
      + '<div class="graph-harness-head" id="graphHarnessWindowHead"><span>AI 网络助手</span>'
      + '<button type="button" onclick="closeGraphHarness()" aria-label="关闭">&times;</button></div>'
      + '<div class="graph-harness-chat" id="graphHarnessChat"></div>'
      + '<div class="graph-harness-composer">'
      + '<textarea id="graphHarnessInstruction" rows="2" placeholder="对 harness 说话..."></textarea>'
      + '<div class="graph-harness-actions">'
      + '<button type="button" onclick="undoLastHarnessEdit()" title="撤销上一条已应用的修改（AI 智能撤销）">↩ 撤销上一条</button>'
      + '<button type="button" onclick="runHarnessExpandQuick()" title="为选中节点生成进阶学习链">✨ 进阶学习</button>'
      + '<button id="graphHarnessStopBtn" type="button" onclick="stopGraphHarness()" hidden>停止</button>'
      + '<button id="graphHarnessSendBtn" type="button" onclick="runGraphHarness()">发送</button>'
      + '</div>'
      + '<div id="graphHarnessStatus" class="graph-harness-status"></div>'
      + '</div>'
      + '</div>'
      + '</div>';
    document.body.appendChild(harnessPet);
    const phiEl = harnessPet.querySelector('[data-phi-pet]');
    if (phiEl && window.PhiPet && window.PhiPet.init) window.PhiPet.init(phiEl);
    document.body.appendChild(harnessPanel);
    _initHarnessDrag();
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
      btn.title = visible ? 'Φ 桌宠（点击隐藏）' : 'Φ 桌宠（点击显示）';
    }
  }

  function toggleGraphPet() {
    ensureHarnessPanel();
    if (!harnessPet) return;
    const visible = harnessPet.style.display !== 'none';
    if (visible) {
      harnessPet.style.display = 'none';
      closeGraphHarness();
    } else {
      harnessPet.style.display = '';
    }
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
    harnessHistory = [];
    if (!sid) return;
    const localKey = 'phymathia_harness_history_' + sid;
    try {
      const local = JSON.parse(localStorage.getItem(localKey) || '[]');
      if (Array.isArray(local)) harnessHistory = local;
    } catch (e) {}
    try {
      const resp = await fetch('/api/kv/' + encodeURIComponent(_historyKey(sid)));
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data.value)) {
          harnessHistory = data.value;
          localStorage.setItem(localKey, JSON.stringify(harnessHistory));
        }
      }
    } catch (e) {}
  }

  async function _saveHarnessHistory() {
    const sid = _sessionId();
    if (!sid) return;
    const localKey = 'phymathia_harness_history_' + sid;
    localStorage.setItem(localKey, JSON.stringify(harnessHistory));
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
    chat.innerHTML = harnessHistory.length
      ? harnessHistory.map(entry => _historyMessageHtml(entry)).join('')
      : '<div class="graph-harness-empty">还没有 harness 对话记录</div>';
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
    actions += '<button type="button" onclick="deleteHarnessHistoryEntry(\'' + entry.id + '\')">删除记录</button>';
    const meta = entry.role === 'assistant'
      ? '<div class="graph-harness-meta">' + (entry.phase || '') + '</div>'
      : '';
    return '<div class="graph-harness-message graph-harness-message-' + (entry.role || 'system') + '">'
      + '<div class="graph-harness-message-content">' + (entry.role === 'assistant' && typeof renderMarkdown === 'function'
        ? renderMarkdown(entry.content || '')
        : _escapeHtml(entry.content || '')) + '</div>'
      + meta
      + (actions ? '<div class="graph-harness-message-actions">' + actions + '</div>' : '')
      + '</div>';
  }

  function _appendHarnessHistory(entry) {
    harnessHistory.push(entry);
    _saveHarnessHistory().then(_renderHarnessChat);
  }

  function _buildConversationContext() {
    return harnessHistory.slice(-10).map(entry => {
      const role = entry.role === 'user' ? '用户' : 'Harness';
      const content = String(entry.content || '').slice(0, 600);
      return role + '：' + content;
    }).join('\n');
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

  async function _resolveHarnessFocus(candidates, instruction) {
    const model = typeof window.getActiveModelForRole === 'function'
      ? (window.getActiveModelForRole('graph') || window.getActiveModelForRole('agent'))
      : null;
    if (!model) {
      return { status: 'error', focus_node_ids: [], ambiguous: false, question: '请先配置主模型', candidates: [] };
    }
    const snapshot = buildHarnessSnapshot(false, candidates, null);
    const resp = await fetch('/api/harness/graph/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        snapshot,
        instruction,
        model: {
          provider: model.provider,
          api_key: model.apiKey,
          model: model.model,
          base_url: model.baseUrl,
        },
        level: localStorage.getItem('phymathia_level') || 'university',
        retries: 2,
        conversation_context: _buildConversationContext(),
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.errors?.[0]?.reason || '目标解析失败');
    return data;
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

  function closeGraphHarness() {
    if (harnessPanel) harnessPanel.hidden = true;
    if (harnessPet) harnessPet.classList.remove('active');
    harnessSingleEvalId = null;
    harnessPendingClarify = null;
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
  }

  // 页面加载即创建 Φ 桌宠（默认显示）；工具栏 Φ 按钮作为显隐开关，点击桌宠开关对话框
  ensureHarnessPanel();
  window.toggleGraphPet = toggleGraphPet;
  window.stopGraphHarness = stopGraphHarness;
  window.syncGraphPetToggleButton = _syncGraphPetToggleButton;
  window.getGraphPetVisible = () => !!(harnessPet && harnessPet.style.display !== 'none');