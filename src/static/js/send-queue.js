// ===== PhyMathia 发送排队：AI 忙的时候先收下，跑完自动发 =====
//
// 为什么有这个东西（docs/backlog.md T42）：
// 发送入口过去一律是裸 `if (正在生成) return;`——不弹提示、不置灰、不留痕。
// 一次工作流在免费模型上要跑 2-8 分钟，这个「忙」窗口长得离谱，撞上的概率很高；
// 用户看到的就是弹窗原样留着、节点毫无变化，于是以为按钮坏了，反复点。
// 真发验证脚本只能靠「每条通道前等工作流空闲」绕开，**但用户没有这个绕法**。
//
// 为什么选「排队」而不是「置灰」：
// 置灰宣告的是「这功能不可用」，可这里按钮是可用的——只是要等。纯置灰的结果是
// 用户的字仍然悬在输入框里、仍然得自己再点一次，症状只从「像坏了」变成「像坏了
// 而且不让我点」。排队让点击当场有回音：弹窗立刻关、字有去处、底部看得见还剩几条。
// 这是 ChatGPT / Claude 的做法。
//
// 为什么不改发送锁的语义：
// `isStreaming` 一行动没动，队列逻辑全部排在锁**之前**同步完成，因此
// 「发送锁覆盖首个异步等待」这条冻结契约（docs/dev/linear-chat-retired.md）原样成立。
// 改的只是撞上锁之后发生什么：从「静默丢弃」变成「排队」。
//
// 队列里存的不是「消息体」而是**闭包**：每个入口把自己的活儿整个包成 run()，
// 空闲后原样再跑一遍。这样各入口原有的收尾动作（苏格拉底的 kv 落盘、分支锚点
// 消费、弹窗关闭时序）不用拆开重写——没走排队那条路时行为一字不变。

var _sendQueue = [];
// 队列正在放行中。真实忙碌位（isStreaming / workflowRunActive）要到第一条发送
// 真正开跑才置上，而那之前隔着模板构建、首个节点分析等若干 await——用户在这个
// 空窗里再点一次「提问」就会并发开出第二个工作流。这个标志把空窗也堵上。
var _sendQueueFlushing = false;

// 真实的忙碌状态：只看两个业务标志位，不含本文件自己的放行标志
function _isActuallyBusy() {
  if (typeof isStreaming !== 'undefined' && isStreaming) return true;
  if (typeof workflowRunActive !== 'undefined' && workflowRunActive) return true;
  return false;
}

// 忙碌判定集中在这里，因为「忙」有两个来源：分支/苏格拉底流式回答（isStreaming）
// 和画布工作流（workflowRunActive）。过去 startQuestionWorkflow 只查 isStreaming，
// 而工作流全程不碰 isStreaming（它走 _generateAnalysis → proxyChat，不经过 sendMessage），
// 于是那个守卫对它自己的通道形同虚设——工作流跑着还能再点一次「提问」，
// 并发开出第二个工作流、两棵节点树打架。收敛到这里，两条路都覆盖。
function _isSendBusy() {
  if (_sendQueueFlushing) return true;
  return _isActuallyBusy();
}

function _hasPendingSend() {
  return _sendQueue.length > 0;
}

// 收下一次发送请求。label 只用于提示文案（「苏格拉底回答」「追问」…），
// run 必须返回 promise：flush 靠 await 它来保证下一条等上一条真的发出去了。
function _enqueueSend(label, run) {
  if (typeof run !== 'function') return false;
  const name = label || '请求';
  _sendQueue.push({ label: name, run });
  _renderQueueChip();
  toastMsg('已收到「' + name + '」，当前回答完成后自动发送');
  return true;
}

// 空闲时把队列逐条发出去。**必须依次 await，不能并发**：苏格拉底那条要先落一次
// kv 才真正发送，如果并发发，第二条会在第一条还没占上发送锁时挤进去，两个流撞在一起。
// 循环条件看的是 _isActuallyBusy（不含放行标志），一条发起来后它立刻为真，循环自然收尾。
async function _flushSendQueue() {
  if (!_sendQueue.length) return;
  if (_sendQueueFlushing || _isActuallyBusy()) return;
  _sendQueueFlushing = true;
  try {
    while (_sendQueue.length && !_isActuallyBusy()) {
      const item = _sendQueue.shift();
      _renderQueueChip();
      try {
        await item.run();
      } catch (err) {
        console.warn('Queued send failed:', item.label, err);
      }
    }
  } finally {
    _sendQueueFlushing = false;
    _renderQueueChip();
  }
}

function _clearSendQueue(reason) {
  if (!_sendQueue.length) return;
  const n = _sendQueue.length;
  _sendQueue = [];
  _renderQueueChip();
  if (reason) toastMsg(reason + '（已丢弃 ' + n + ' 条待发送）');
}

// 「待发送 N」标记挂在进度胶囊里——那是用户盯着等的时候本来就在看的地方，
// 不用去学一个全新的位置。点它 = 全部丢弃，反悔的唯一出口。
function _renderQueueChip() {
  const chip = document.getElementById('sendQueueChip');
  if (!chip) return;
  const n = _sendQueue.length;
  chip.textContent = n > 0 ? '待发送 ' + n : '';
  chip.hidden = n === 0;
  if (n === 0) {
    chip.removeAttribute('title');
    return;
  }
  chip.title = '点击丢弃全部待发送';
  // 队列非空却不在生成中（正常只发生在收队与 flush 之间的那一瞬），
  // 胶囊可能正处在 hideProgress 的延迟退场倒计时里——把标记露出来，别让它跟着一起消失。
  const capsule = document.getElementById('progressStatus');
  if (capsule && !capsule.classList.contains('active')) capsule.classList.add('active');
}

function _initSendQueue() {
  const chip = document.getElementById('sendQueueChip');
  if (chip && !chip.dataset.bound) {
    chip.dataset.bound = '1';
    chip.addEventListener('click', function() {
      _clearSendQueue('已丢弃待发送');
    });
  }
  _renderQueueChip();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initSendQueue);
  } else {
    _initSendQueue();
  }
}
