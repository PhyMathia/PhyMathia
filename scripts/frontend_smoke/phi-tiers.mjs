// Φ 第一档七件套＋第三档体验级
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 2980–3067 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
// ===== Φ 第一档七件套（T86–T92，2026-09-30 事故级修复）静态回归 =====
// 七条都是用户直接撞上的信任事故，这里锁住「不许回退」的形态：澄清不得再抹聊天区、
// 流式重试不得叠加、应用不得重入毁检查点、切换会话不得静默掐断、生成中发言不得
// 静默丢弃、phase 不得裸英文、清空不得用原生 confirm。
check('harness：第一档七件套 T86–T92（澄清不抹历史/流式重置/应用防重入/切换守卫/排队/phase 中文/清空内联确认）', () => {
  const rsrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  const hsrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  const asrc = fs.readFileSync('src/static/js/harness-apply.js', 'utf8');
  const psrc = fs.readFileSync('src/static/js/harness-preview.js', 'utf8');
  const ssrc = fs.readFileSync('src/static/js/send-queue.js', 'utf8');
  const pysrc = fs.readFileSync('harness/review.py', 'utf8');
  // T86：澄清是追加气泡（带取消出口），不得再 innerHTML 整块覆盖聊天区
  if (rsrc.includes("chat.innerHTML = '<div class=\"graph-harness-clarify\">")) {
    throw new Error('澄清又变回整块覆盖聊天区（T86 回退）');
  }
  if (!rsrc.includes('graph-harness-message-clarify')) throw new Error('澄清追加气泡缺失');
  if (!rsrc.includes('cancelHarnessClarify')) throw new Error('澄清缺「取消」出口');
  // T87：重试轮次开始时流式预览必须重置（后端 status 带 attempt，前端 attempt>0 清空）
  // T93：多步循环每步也会重发 stage='model'（带 step），同一处重置条件扩成 attempt||step
  if (!pysrc.includes('"attempt": attempt')) throw new Error('review.py 轮次 status 缺 attempt 字段');
  if (!rsrc.includes("evt.stage === 'model' && (Number(evt.attempt) > 0 || Number(evt.step) > 0)")) {
    throw new Error('前端未按 attempt/step 重置流式预览');
  }
  // T88：应用成功置位防重入标志，入口拦截重复应用；撤销/新结果/会话重置/新一轮生成复位
  if (!hsrc.includes('let harnessResultApplied')) throw new Error('harness.js 缺 harnessResultApplied 标志');
  if (!asrc.includes('这条建议已经应用过')) throw new Error('应用防重入缺用户提示');
  if (!asrc.includes('graphHarnessApplyAllBtn')) throw new Error('应用后未禁用应用按钮');
  if (!psrc.includes('graphHarnessApplyAllBtn')) throw new Error('新结果渲染未复位应用按钮');
  // T89：生成中切换 Φ 会话必须被 busy 守卫拦下（新建/删除/清空/换绑同款）
  if (!hsrc.includes('等任务完成后再切换 Φ 会话')) throw new Error('切换 Φ 会话缺 busy 守卫');
  // T90：生成中发消息入队（复用 send-queue），队列也必须认识 harnessBusy
  if (!rsrc.includes('_enqueueSend')) throw new Error('Φ 未接入 send-queue 排队');
  if (!rsrc.includes('graph-harness-queued-tag')) throw new Error('排队气泡缺「排队中」标记');
  if (!ssrc.includes('harnessBusy')) throw new Error('send-queue 忙判定不认 harnessBusy');
  // T91：助手消息 meta 只出中文标签，不得裸英文 phase
  if (!hsrc.includes('const HARNESS_PHASE_LABELS') || !hsrc.includes('审阅整理')) throw new Error('phase 中文映射表缺失');
  if (!hsrc.includes('_escapeHtml(_harnessPhaseLabel(entry.phase))')) throw new Error('meta 未走中文标签映射');
  if (hsrc.includes("'>' + (entry.phase || '') + '</div>'")) throw new Error('meta 仍直接渲染原始 phase（T91 回退）');
  // T92：清空所有 Φ 对话用菜单内联二次确认，不用原生 confirm
  if (hsrc.includes("window.confirm('确定清空所有")) throw new Error('清空 Φ 对话仍用原生 confirm（T92 回退）');
  if (!hsrc.includes('confirmClearAllHarnessSessions')) throw new Error('清空缺内联二次确认');
  return true;
});

// ===== Φ 第三档体验级（T99–T106，2026-09-30 评审路线第五步）静态回归 =====
// 八条都是对话产品化的细节，锁住「不许回退」的形态：停止不白生成、评审清单不
// 盲审、时间线回滚语义完整、流式期间有排版、重试有多个出口、会话可管、空态
// 有引导、长等待有进度感。
check('harness：体验级八件套 T99–T106（停止续接/内容diff/时间线语义/流式渲染/换模型重试/改名搜索/空态引导/进度感）', () => {
  const rsrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  const hsrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  const asrc = fs.readFileSync('src/static/js/harness-apply.js', 'utf8');
  const psrc = fs.readFileSync('src/static/js/harness-preview.js', 'utf8');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  // T99：停止后的半截回答入历史（interrupted 标记）＋「从中断处继续」出口
  if (!rsrc.includes('interrupted: true')) throw new Error('停止后半截回答未入历史（T99 回退）');
  if (!rsrc.includes('continueHarnessInterrupted')) throw new Error('缺「从中断处继续」续接函数');
  if (!hsrc.includes('graph-harness-continue-btn')) throw new Error('中断条目缺续接按钮');
  // T100：分组唯一真源＋内容级 diff（update 原文→建议文、delete 摘录）
  if (!rsrc.includes('function _harnessGroupedOps')) throw new Error('操作分组唯一真源缺失');
  if (!psrc.includes('graph-harness-op-diff-old') || !psrc.includes('graph-harness-op-diff-new')) throw new Error('update 条目缺「原文→建议文」diff');
  if (!psrc.includes('将删除：')) throw new Error('delete 条目缺被删内容摘录');
  if (!psrc.includes('data-op-index')) throw new Error('分组重排弄丢了勾选框的 data-op-index');
  if (!css.includes('.graph-harness-op-diff-old')) throw new Error('diff 行样式缺失');
  // T101：applied 批次上报带配方前态；回滚还原配方库并翻历史 decision
  if (!asrc.includes('recipes_before')) throw new Error('applied 上报缺 recipes_before');
  if (!asrc.includes('setUserRecipes(recipesBefore)')) throw new Error('时间线回滚未还原配方库');
  if (!asrc.includes('_harnessFlipHistoryDecisionsFromSeq')) throw new Error('回滚未翻历史条目 decision');
  // T102：流式期间走 Markdown 渲染＋聊天区实时气泡
  if (!rsrc.includes('renderMarkdown(text)')) throw new Error('流式期间未走 Markdown 渲染（T102 回退）');
  if (!rsrc.includes('graph-harness-message-live')) throw new Error('生成期间聊天区缺实时气泡');
  if (!css.includes('graph-harness-stream-cursor')) throw new Error('流式光标样式缺失');
  // T103：换模型重试＋复制错误详情＋降级说明入历史
  if (!hsrc.includes('_harnessNextModelCandidate')) throw new Error('缺换模型候选函数');
  if (!hsrc.includes('_copyHarnessErrorDetails')) throw new Error('缺「复制错误详情」');
  if (!rsrc.includes('degradeNotes')) throw new Error('降级说明未入历史（T103 回退）');
  // T104：会话搜索＋行内改名
  if (!hsrc.includes('filterHarnessSessions')) throw new Error('会话菜单缺搜索');
  if (!hsrc.includes('confirmRenameHarnessSession')) throw new Error('会话缺行内改名');
  // T105：空状态示例问题
  if (!hsrc.includes('HARNESS_EXAMPLE_QUESTIONS')) throw new Error('空状态缺示例问题引导');
  // T106：状态行秒表＋终态摘要（耗时/模型调用数/token）
  if (!hsrc.includes('_harnessStartProgressTick') || !hsrc.includes('_harnessStopProgressTick')) throw new Error('进度计时缺失');
  if (!hsrc.includes('data.model_calls')) throw new Error('终态摘要未读 model_calls');
  if (!hsrc.includes('context_metrics')) throw new Error('终态摘要未读 context_metrics token');
  return true;
});
}
