#!/usr/bin/env node
// 发送通道真机验证（AGENTS.md 硬规则 6）：把幸存的每条通道**真发一次**并逐条记录。
//
// 这不是单元测试，也不是 mock——它配好真实模型、走真实 UI 路径发真请求。存在的
// 理由是 isCasual 事故（2026-09-25，分支/苏格拉底整整一周发不出请求，而静态回归
// 全绿）：回归沙箱没配模型走不到发送段，静态绿不等于真机能发。
//
// 2026-09-27 那一轮是为了验证 graph-workflow.js 的 SSE 读取口抽取（三处合一）。
// 抽出共用读取口最容易出的错是「某一类节点不更新了」——静态断言看不出来，只有
// 真发才知道。
//
// **2026-09-27 晚重写了 ②③④ 三条通道**（详见 docs/backlog.md T40 与文件内注释）：
// 旧版从 `node.outputPorts` 取端口，而那个字段**全仓只存在于本脚本里**，产品端口是
// 渲染时推导、写在 DOM data-* 上的——所以旧版必然报「源节点没有可用输出端口：[]」，
// 且换任何 key 都验不了，而且那条报错长得像产品回归。三条通道现已各走产品里的真实入口。
//
// 用法：node scripts/verify_send_channels.mjs
// 前置：服务在 5050 起着，且 opencode 网关可达（脚本会先探，不通就直接退出而不是
// 假装通过）。真实 data/ 只读不碰——全程在临时数据目录里跑。
//
// **不烧钱的跑法（backlog T57，2026-09-29 落地）**：先起本地 mock 上游
//   node scripts/mock_upstream.mjs        # 127.0.0.1:5065，OpenAI 兼容 SSE/JSON 双格式
// 再用环境变量把验证模型指过去（七条通道全走真实 UI 路径，只是上游换成 mock）：
//   VERIFY_PROVIDER=opencode-go VERIFY_MODEL=mock-1 \
//   VERIFY_BASE_URL=http://127.0.0.1:5065/v1 VERIFY_API_KEY=mock node scripts/verify_send_channels.mjs
// mock 回包覆盖：问题概要 / 建议模块行 / 学习卡片 XML（含 <extend> 的苏格拉底＋进阶
// 方向段——缺了产品会走兜底空端口，见 T57 坑②）/ 节点工坊草稿 JSON（T370：⑧⑩
// 走 /api/harness/recipe/draft，锚在系统提示词「节点工坊」）。

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 5079;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = ms => new Promise(r => setTimeout(r, ms));

// 模型可用环境变量换（默认走 .env 里的 opencode 免费网关）：
//   VERIFY_PROVIDER / VERIFY_MODEL / VERIFY_BASE_URL / VERIFY_API_KEY
// **2026-09-27 实测记录**：本机 .env 里的 opencode key 对**所有**模型都被上游拒了
// （Invalid credential / Model is unavailable / 免费层限 OpenCode 内部客户端），
// DeepSeek 的 key 也是 invalid。所以那天这脚本没能真正跑通五条通道——见
// docs/backlog.md T37。换一把可用 key 后直接重跑本脚本即可补上那次验证。
const MODEL = {
  id: 'verify-model', name: '验证用模型',
  provider: process.env.VERIFY_PROVIDER || 'opencode',
  model: process.env.VERIFY_MODEL || 'deepseek-v4-flash-free',
  apiKey: process.env.VERIFY_API_KEY || '',
  baseUrl: process.env.VERIFY_BASE_URL || 'https://opencode.ai/zen/v1',
};
const SLOTS = ['agent_model', 'html_model', 'descriptor_model', 'quiz_model', 'graph_model', 'branch_model'];

const results = [];
function ok(name) { results.push([true, name]); console.log('✓ ' + name); }
function bad(name, err) {
  results.push([false, name]);
  console.log('❌ ' + name + ' -> ' + (err && err.message || err));
}

async function waitHealth(base, ms = 30000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    try { if ((await fetch(base + '/health')).ok) return true; } catch (e) {}
    await wait(300);
  }
  throw new Error('服务未就绪');
}

/** 等某个节点从 busy 变成 done（或超时）。流式是否真的把内容灌进去了，看这里。 */
async function waitNodeSettled(page, nodeId, timeoutMs) {
  const dl = Date.now() + timeoutMs;
  let lastLen = -1;
  while (Date.now() < dl) {
    const st = await page.evaluate((id) => {
      const n = (typeof graphView !== 'undefined' && graphView) ? graphView.nodeById[id] : null;
      return n ? { busy: !!n.busy, status: n.status, len: String(n.content || n.analysis || '').length } : null;
    }, nodeId);
    if (st && !st.busy && st.status === 'done') return st;
    lastLen = st ? st.len : -1;
    await wait(700);
  }
  // 「长度 0」值得单独说：2026-09-27 实测 space-bunny-free **偶发**返回 HTTP 200 +
  // finish_reason="length" + content 为空（这个模型把 max_tokens 大半花在 reasoning 上，
  // 小 max_tokens 时正文根本没轮到生成——直连探测 3 次里 2 次空）。
  // 那是上游/模型特性，**不是产品回归**，报错必须说清楚，否则下一个人会误判成产品在坏。
  const emptyHint = lastLen === 0
    ? '；注意：长度 0 常见于上游返回 200 但 content 为空（finish_reason=length，'
      + '模型把 token 全用在 reasoning 上）——先重跑一次确认，别直接记成产品回归'
    : '';
  throw new Error('节点 ' + nodeId + ' 超时未完成（最后长度 ' + lastLen + '）' + emptyHint);
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'phymathia-verify-send-'));
  cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
  const server = spawn('python3', ['src/main.py', '-p', String(PORT)], {
    cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });

  let browser = null;
  try {
    await waitHealth(BASE);

    // 先探网关：不通就明说，别让「没发成」看起来像「发失败了」
    if (MODEL.provider === 'opencode') {
      const listed = await (await fetch(BASE + '/api/models/list', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'opencode' }),
      })).json();
      if (!listed.models || !listed.models.length) throw new Error('网关列不出模型，验证无从谈起');
      if (!listed.models.includes(MODEL.model)) {
        throw new Error('网关没有模型 ' + MODEL.model + '（可用：' + listed.models.slice(0, 5).join(', ') + ' …）');
      }
    }
    console.log('网关就绪，模型：' + MODEL.provider + '/' + MODEL.model + '\n');

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
    // T303 重生成预警（2026-10-13）给 force 重生成加了原生 confirm 门，headless
    // 无 dialog handler 时默认 dismiss——通道④ runWorkflowNode(id,true) 被静默
    // return，报错长得像「重生成 180 秒没反应」的假红。真机用户点是「确定」，
    // handler 对齐这个语义（其余通道的产品路径不经 confirm，accept 不改变它们；
    // 上次 9/9 全绿是 01f127b，早于 T303 落地）
    page.on('dialog', d => d.accept());
    // 空白节点通道（⑪，2026-10-24 T403）：记住所有 target.kind='blank' 的工作流请求体。
    // 既证明「卡上按钮／全部开始」走同一条统一发送链（带 workflow_context），也用来验证
    // 「已经生成过的卡第二次不该再发请求」（T400 的「每次重跑」）。
    const blankChatRequests = [];
    page.on('request', req => {
      if (!req.url().includes('/api/models/chat')) return;
      try {
        const body = JSON.parse(req.postData() || '{}');
        const wf = body && body.workflow_context;
        if (wf && wf.target && wf.target.kind === 'blank') blankChatRequests.push(body);
      } catch (e) { /* 非 JSON 请求体（理论上没有）：跳过 */ }
    });
    // 配好模型 + 跳过引导，否则发不出去（这正是硬规则 6 强调的那一点）
    // 参数传**对象**不传数组：playwright 的 addInitScript 会把数组实参再包一层，
    // 于是 `([model, slots]) => {}` 解出来 slots 是 undefined，模型静默配不上
    //（第一版就这么栽的：报的是「槽位读到 null」，看不出是种子没写进去）。
    await page.addInitScript((cfg) => {
      try {
        localStorage.setItem('phymathia_user_models', JSON.stringify([cfg.model]));
        const act = {};
        for (const s of cfg.slots) act[s] = cfg.model.id;
        localStorage.setItem('phymathia_active_models', JSON.stringify(act));
        localStorage.setItem('phymathia_onboarding_done', '1');
        localStorage.setItem('phymathia_guide_seen', '1');
      } catch (e) { console.error('[verify] 模型种子写入失败：' + e.message); }
    }, { model: MODEL, slots: SLOTS });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.startQuestionWorkflow === 'function'
      || typeof window.sendGraphNewSession === 'function', null, { timeout: 20000 });
    await page.waitForTimeout(1200);

    const modelLive = await page.evaluate(() => {
      const m = typeof getActiveModelForRole === 'function' ? getActiveModelForRole('agent') : null;
      return m ? m.model : null;
    });
    if (modelLive !== MODEL.model) throw new Error('模型没配上（槽位读到 ' + modelLive + '）');

    // 上游探针：模型「列得出来」不等于「调得动」——2026-09-27 那天就是列得出、
    // 一发就 502（上游 Model is unavailable）。先探一发，别把上游挂了记成产品回归。
    const probe = await page.evaluate(async (m) => {
      try {
        const r = await proxyChat('说三个字', 'university', '', true, new AbortController().signal,
          { workflowContext: { mode: 'analysis', question: '探针' } });
        if (!r) return { err: 'proxyChat 返回空（模型没配上）' };
        if (!r.ok) return { err: 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160) };
        return { ok: true };
      } catch (e) { return { err: e.message }; }
    });
    if (!probe.ok) {
      throw new Error('上游调不动（' + probe.err + '）——这是凭证/模型的问题，不是产品回归。'
        + '换一把可用 key 后重跑：VERIFY_MODEL=... VERIFY_API_KEY=... node scripts/verify_send_channels.mjs');
    }
    console.log('模型已就位：' + modelLive + '\n');

    // ===== 1. 工作流首问 =====
    let rootId = null;
    try {
      rootId = await page.evaluate(async () => {
        const ta = document.querySelector('.graph-new-session-input');
        if (ta) {
          ta.value = '用一句话说明简谐运动的定义';
          await window.sendGraphNewSession(ta);
        } else {
          await window.startQuestionWorkflow('用一句话说明简谐运动的定义');
        }
        for (let i = 0; i < 120; i++) {
          const n = graphView.nodes.find(x => x.kind === 'module' || x.kind === 'answer');
          if (n) return n.id;
          await new Promise(r => setTimeout(r, 500));
        }
        return null;
      });
      if (!rootId) throw new Error('首问后没长出节点');
      const st = await waitNodeSettled(page, rootId, 180000);
      if (st.len < 20) throw new Error('流式内容为空或过短（' + st.len + ' 字）——SSE 读取口可能断了');
      ok('通道① 工作流首问：已发通，流式收到 ' + st.len + ' 字');
    } catch (e) { bad('通道① 工作流首问', e); }

    // ===== 2. 节点追问 / 3. 苏格拉底回答 =====
    //
    // 2026-09-27 重写（见 docs/backlog.md T40）。**旧版三条通道全走「拖输出端口」一条路，
    // 且从 `node.outputPorts` 取端口——那个字段全仓只存在于本脚本里，产品从来没有过。**
    // 端口是渲染时从 `_nodeOutputLabels()` 推导、写在 DOM 的 data-* 上的，所以旧版必然
    // 报「源节点没有可用输出端口：[]」——**换任何 key 都验不了**，而且那条报错长得像产品回归。
    //
    // 更根本的是：这些通道在产品里根本不是同一条路，各走各的真实入口——
    //   ② 节点追问   → 拖标签含「追问」的输出端口（物理/数学/知识图谱/可视化模块都有）
    //   （原③「没看懂」＝模块节点按钮 dontUnderstandModule() 开分支弹窗，2026-10-17
    //     T335 随 confused 分支整体退役，见下方的重编号注记）
    //   ③ 苏格拉底回答 → 苏格拉底模块的端口是「问题1/2/3」、type=socratic；
    //                  「回答练习」只存在于 `GRAPH_MODULE_DEFAULT_OUTPUTS.socratic`，
    //                  而 `_moduleOutputPorts` 对 socratic 提前 return，那条配置走不到
    // 下面 `__verifyPorts()` 按产品同构的方式从 DOM 组 portMeta，取不到就把**实际存在的
    // 端口列出来**——宁可说清「没有这种端口」，也不要再伪装成产品坏了。
    if (rootId) {
      await page.evaluate(() => {
        // 与 graph-interact.js 建 portMeta 的那段同构（decodeURIComponent 兜底、
        // data-port-item 的 JSON.parse 兜底都照抄），别让脚本自己发明一套形状。
        window.__verifyPorts = () => {
          const dec = v => { try { return v ? decodeURIComponent(v) : ''; } catch (e) { return v || ''; } };
          const out = [];
          document.querySelectorAll('.graph-node[data-node-id]').forEach(el => {
            const nid = el.dataset.nodeId;
            const n = graphView.nodeById[nid];
            el.querySelectorAll(':scope > .graph-output-col > .graph-output-port').forEach(p => {
              let item = null;
              if (p.dataset.portItem) { try { item = JSON.parse(dec(p.dataset.portItem)); } catch (e) { item = null; } }
              out.push({
                nodeId: nid, portId: p.dataset.portId || 'out-0',
                nx: (n && n.x) || 0, ny: (n && n.y) || 0,
                meta: {
                  type: p.dataset.portType || 'branch',
                  branchType: p.dataset.portBranch || 'followup',
                  attribute: p.dataset.attribute || '',
                  question: dec(p.dataset.portQuestion),
                  level: p.dataset.portLevel || '',
                  label: dec(p.dataset.portLabel),
                  item,
                },
              });
            });
          });
          return out;
        };
        window.__verifyBranchFromPort = async (p, text) => {
          const before = graphView.nodes.length;
          await window._createBranchNodeFromOutput(p.nodeId, p.portId, p.meta, p.nx + 460, p.ny + 240);
          await new Promise(r => setTimeout(r, 800));
          const draft = graphView.nodes.slice(before).find(n => n.kind === 'draft');
          // 拖端口建出来的是**待填写的草稿节点**，不发就永远没有内容（第一版就死在这：
          // 报「超时未完成（最后长度 0）」）。真人接下来要么在草稿框里改字点「发送提问」，
          // 要么（苏格拉底那种没有输入框的草稿）点「直接问AI」，脚本两条都照做。
          if (!draft) return { n: graphView.nodes.length - before, id: null, why: '没建出草稿节点' };
          const el = document.querySelector('[data-node-id="' + draft.id + '"]');
          const ta = el && el.querySelector('.graph-draft-input');
          const send = el && el.querySelector('.graph-draft-send');
          const askAi = el && el.querySelector('.graph-socratic-ai');
          if (askAi) askAi.click();
          else if (ta && send) {
            ta.value = text;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            send.click();
          } else return { n: graphView.nodes.length - before, id: null, why: '草稿节点里既没有输入框/发送按钮也没有「直接问AI」' };
          return { n: graphView.nodes.length - before, draftId: draft.id, id: null, sent: true, beforeCount: before };
        };

        // 草稿发送走的是 startQuestionWorkflow（一次完整工作流，要跑好几分钟），
        // 回答节点不是立刻出现——第一版等 1.2 秒就断言「没有回答节点」，全是误判。
        // 注意这里只按**节点是否出现**来找，**不要求 content 非空**：流式期间
        // `node.content` 本来就是空的（实测生成中 clen=0 / status='running'），
        // 等它有内容会一直等到超时。「内容是否到位」交给 waitNodeSettled 判。
        // ⑤ 与 ③ 都必须**显式挑模块节点**，不能沿用 rootId：
        // rootId 是「第一个 module 或 answer 节点」，很可能是**回答节点**，而
        // `runWorkflowNode` 的守卫第一句就是 `node.messageIndex >= 0 → return`，
        // 回答节点命中它就静默什么都不做（本轮 ⑤ 就这么失败过好几轮）。
        window.__verifyPickModule = () => {
          const m = graphView.nodes.find(n => n.kind === 'module' && n.moduleKey
            && String(n.content || '').length && !n.busy);
          return m ? { id: m.id, moduleKey: m.moduleKey, len: String(m.content || '').length } : null;
        };

        window.__verifyWaitAnswer = async (beforeCount, timeoutMs) => {
          const t0 = Date.now();
          while (Date.now() - t0 < (timeoutMs || 60000)) {
            const hit = graphView.nodes.slice(beforeCount).find(n => n.kind === 'answer');
            if (hit) return { id: hit.id, waited: Date.now() - t0 };
            await new Promise(r => setTimeout(r, 500));
          }
          return { id: null, waited: Date.now() - t0 };
        };
      });

      /** 在真实端口里按条件挑一个，挑不到就把实际有哪些端口报出来（诊断信息，不是产品判决） */
      const pickPort = async (match) => {
        const r = await page.evaluate((m) => {
          const all = window.__verifyPorts();
          const ok = p => (m.exactLabel ? p.meta.label === m.exactLabel : true)
            && (m.type ? p.meta.type === m.type : true)
            && (m.branchType ? p.meta.branchType === m.branchType : true)
            && (m.preferKind ? (graphView.nodeById[p.nodeId] || {}).kind === m.preferKind : true);
          // 先在 preferKind 里找，再放宽——否则 DOM 顺序会让答案节点的「苏格拉底追问」
          // 抢在模块节点的「追问」前面（第一版就踩了：`includes('追问')` 命中了它）。
          const scoped = all.filter(p => ok(p) && m.preferKind);
          const hit = scoped[0] || all.find(ok) || null;
          return { hit, available: all.map(p => (graphView.nodeById[p.nodeId] || {}).kind + ':' + p.meta.label) };
        }, match);
        if (!r.hit) {
          throw new Error('画布上没有符合条件的输出端口（要 ' + JSON.stringify(match) + '）；'
            + '实际存在：' + (r.available.length ? r.available.join(', ') : '（一个都没有）')
            + '——这是脚本与产品 UI 不同步，不是产品回归');
        }
        return r.hit;
      };

      /**
       * 等工作流空闲。**每条通道开跑前都要调**——②③④ 各自会启动一次完整工作流，
       * 而发送入口（`sendMessage` / `submitSocraticAnswer` / `sendBranchQuick`…）都有
       * 裸 `if (isStreaming) return;` 的忙碌守卫，正在生成时发出去会被**静默丢弃**。
       * 这不是脚本的问题，是产品行为（见 docs/backlog.md T42），
       * 但脚本必须自己避开，否则会间歇性失败（本轮 ③ 就这么飘过一次：上轮过、这轮不过）。
       */
      const waitIdle = async (label) => {
        const ok = await page.evaluate(async () => {
          const t0 = Date.now();
          while (Date.now() - t0 < 300000) {
            const busyNode = graphView.nodes.some(n => n.busy);
            const runBtn = document.getElementById('statusRunBtn');
            if (!busyNode && !(runBtn && runBtn.disabled)) return true;
            await new Promise(r => setTimeout(r, 1000));
          }
          return false;
        });
        if (!ok) throw new Error('等工作流空闲超时（300 秒）——' + label + ' 之前有工作流一直没跑完');
      };

      // ② 节点追问：模块节点上标签**恰好**是「追问」的端口 → 草稿 → 发送提问
      try {
        await waitIdle('② 节点追问');
        const port = await pickPort({ exactLabel: '追问', preferKind: 'module' });
        const created = await page.evaluate(p => window.__verifyBranchFromPort(p,
          '请从数学视角进一步深入讲解：为什么散射强度与波长的四次方成反比？请给出推导。'), port);
        if (!created.id && !created.sent) throw new Error(created.why || '没有可用节点');
        const ans = await page.evaluate(c => window.__verifyWaitAnswer(c.beforeCount, 60000), created);
        if (!ans.id) throw new Error('草稿发出后 ' + Math.round(ans.waited / 1000) + ' 秒仍没有回答节点');
        const st = await waitNodeSettled(page, ans.id, 180000);
        if (st.len < 20) throw new Error('流式内容为空或过短（' + st.len + ' 字）');
        ok('通道② 节点追问：已发通（模块「追问」端口 → 草稿 → 发送提问），流式收到 ' + st.len + ' 字');
      } catch (e) { bad('通道② 节点追问', e); }

      // （原通道③「没看懂」已随 T335 退役，2026-10-17：入口按钮与 confused 分支整体拆除，
      //   幸存通道重编号——现③=苏格拉底回答，④=重试，⑤=进阶支线，⑥=方向钮，
      //   ⑦=苏格拉底闭环作答，⑧=创造模式，⑨=答疑模式，⑩=创造模式访谈。）

      // ③ 苏格拉底回答：苏格拉底模块的「问题N」端口（type=socratic）→ 草稿点「直接问AI」
      try {
        await waitIdle('③ 苏格拉底回答');
        const port = await pickPort({ type: 'socratic' });
        const created = await page.evaluate(p => window.__verifyBranchFromPort(p,
          '请围绕苏格拉底追问继续展开讲解：为什么瑞利散射公式里的四次方与分子尺度的关系要这样取？'), port);
        if (!created.id && !created.sent) throw new Error(created.why || '没有可用节点');
        const ans = await page.evaluate(c => window.__verifyWaitAnswer(c.beforeCount, 60000), created);
        if (!ans.id) throw new Error('草稿发出后 ' + Math.round(ans.waited / 1000) + ' 秒仍没有回答节点');
        const st = await waitNodeSettled(page, ans.id, 180000);
        if (st.len < 20) throw new Error('流式内容为空或过短（' + st.len + ' 字）');
        ok('通道③ 苏格拉底回答：已发通（源端口「' + port.meta.label + '」），流式收到 ' + st.len + ' 字');
      } catch (e) { bad('通道③ 苏格拉底回答', e); }

      // ===== 4. 重试（重新生成）=====
      //
      // ⚠️ 这一条**曾是假通过**，一并修掉。原来调的是 `submitRegenerateNode()`：
      // 它第一件事是 `const s = _getChatHistory()[t.messageIndex]; if (!s) return;`，
      // 而模块节点的 `messageIndex` 一律是 -1（内容存在 node.content 上，不在 chatHistory 里），
      // 所以它**静默 return、什么都没做**；脚本随后量到的是节点原有的内容，
      // 就报了「重生成后 162 字」——把一次没发生的发送记成了通过。
      //
      // 模块节点上「重新生成」按钮的真实入口是 `runWorkflowNode(id, true)`
      // （**第二个参数 force 必须传 true**：不传时 `_workflowItemNeedsProgress` 对已生成的
      // 节点返回 false，会被防重跑逻辑直接跳过——本轮实测不传 force 内容逐字节不变）。
      // 并且这里**必须断言内容真的变了**，否则同样的假通过会再来一次。
      //
      // 还要**等工作流空闲**：`runWorkflowNode` 的守卫里有 `|| workflowRunActive`，
      // 而 ②③④ 每条都启动了一次完整工作流，不等它跑完就调 → 静默 return（本轮踩过）。
      try {
        await waitIdle('④ 重试');
        const regen = await page.evaluate(async () => {
          const picked = window.__verifyPickModule();
          if (!picked) return { err: '画布上没有已生成内容的模块节点' };
          const id = picked.id;
          const n = graphView.nodeById[id];
          if (!n) return { err: '节点不在了' };
          const before = String(n.content || '');
          const p = window.runWorkflowNode(id, true);
          if (p && p.then) { try { await p; } catch (e) { return { err: 'runWorkflowNode 抛错：' + e.message }; } }
          const t0 = Date.now();
          while (Date.now() - t0 < 180000) {
            const cur = graphView.nodeById[id];
            const now = String((cur && cur.content) || '');
            if (now && now !== before) return { beforeLen: before.length, afterLen: now.length, node: id, waited: Date.now() - t0 };
            await new Promise(r => setTimeout(r, 1000));
          }
          return { err: '调 runWorkflowNode(id, true) 后 180 秒内容仍未变化（moduleKey=' + picked.moduleKey + '）', beforeLen: before.length, node: id };
        });
        if (regen.err) throw new Error(regen.err);
        const st = await waitNodeSettled(page, regen.node, 180000);
        if (st.len < 20) throw new Error('重生成后内容为空（' + st.len + ' 字）');
        ok('④ 重试：已发通，重生成后 ' + st.len + ' 字（原 ' + regen.beforeLen + ' 字，'
          + Math.round(regen.waited / 1000) + ' 秒后确实变了）');
      } catch (e) { bad('④ 重试', e); }

      // ===== 5. 进阶支线（learn 端口 → 「请详细讲解」预填草稿 → 发送提问）=====
      // 与 ②④ 同一条 __verifyBranchFromPort 真实入口，但端口类型不同：learn 端口的
      // 草稿预填是「请详细讲解：{问题}」，验证的是 type=learn 的拖出路由与预填模板。
      try {
        await waitIdle('⑤ 进阶支线');
        const port = await pickPort({ type: 'learn' });
        const created = await page.evaluate(p => window.__verifyBranchFromPort(p,
          '请详细讲解：瑞利散射的四次方依赖是怎么来的？'), port);
        if (!created.id && !created.sent) throw new Error(created.why || '没有可用节点');
        const ans = await page.evaluate(c => window.__verifyWaitAnswer(c.beforeCount, 60000), created);
        if (!ans.id) throw new Error('草稿发出后 ' + Math.round(ans.waited / 1000) + ' 秒仍没有回答节点');
        const st = await waitNodeSettled(page, ans.id, 180000);
        if (st.len < 20) throw new Error('流式内容为空或过短（' + st.len + ' 字）');
        ok('⑤ 进阶支线：已发通（learn 端口「' + port.meta.label + '」→ 预填草稿 → 发送提问），流式收到 ' + st.len + ' 字');
      } catch (e) { bad('⑤ 进阶支线', e); }

      // ===== ⑥ 方向钮（T361：learn 模块卡正文里的方向条目钮 → 工作流逐节点）=====
      // 与 ⑥ 不是同一条：⑥ 是拖 learn 端口出草稿再发；⑨ 是点卡片正文里的
      // .learn-dir-btn（convertLearnDirections 渲染的按钮）。T361 之前它走消息簇
      // 链路（sendBranchQuick），现在与端口拖拽同落 startQuestionWorkflow——
      // 两条都要真发，单链路语义才算验到。
      try {
        await waitIdle('⑥ 方向钮');
        const created = await page.evaluate(async () => {
          const nodes = [...document.querySelectorAll('.graph-node-module.graph-module-learn')];
          let btn = null;
          for (const el of nodes) { const b = el.querySelector('.learn-dir-btn'); if (b) { btn = b; break; } }
          if (!btn) return { err: '画布上没有渲染出方向条目钮（learn 模块卡正文）' };
          const before = graphView.nodes.length;
          btn.click();
          await new Promise(r => setTimeout(r, 1200));
          return { beforeCount: before, label: String(btn.textContent || '').slice(0, 20) };
        });
        if (created.err) throw new Error(created.err);
        const ans = await page.evaluate(c => window.__verifyWaitAnswer(c.beforeCount, 60000), created);
        if (!ans.id) throw new Error('点方向钮后 ' + Math.round(ans.waited / 1000) + ' 秒仍没有回答节点');
        const st = await waitNodeSettled(page, ans.id, 180000);
        if (st.len < 20) throw new Error('流式内容为空或过短（' + st.len + ' 字）');
        ok('⑥ 方向钮：已发通（learn 卡方向钮「' + created.label + '」→ 工作流逐节点），流式收到 ' + st.len + ' 字');
      } catch (e) { bad('⑥ 方向钮', e); }

      // ===== ⑦ 苏格拉底闭环作答（T361：卡上「我来回答」→ 弹窗 → 工作流承载）=====
      // 与 ④ 不是同一条：④ 是拖 socratic 端口出草稿点「直接问AI」；⑩ 是 socratic
      // 模块卡正文里的「我来回答」→ 弹窗 → 提交作答。T361 之前落一条 assistant
      // 消息（消息簇），现在建 user-custom 作答＋answer-custom 反馈两颗自定义节点，
      // branch_id 闭环状态与建议追问派生都随迁——本通道把三件都断言上。
      try {
        await waitIdle('⑦ 苏格拉底闭环作答');
        const opened = await page.evaluate(async () => {
          const nodes = [...document.querySelectorAll('.graph-node-module.graph-module-socratic')];
          let btn = null;
          for (const el of nodes) { const b = el.querySelector('.socratic-answer'); if (b) { btn = b; break; } }
          if (!btn) return { err: '画布上没有可作答的苏格拉底问题钮（socratic 模块卡正文）' };
          btn.click();
          await new Promise(r => setTimeout(r, 500));
          const modal = document.getElementById('socraticModal');
          if (!modal || modal.hidden) return { err: '点「我来回答」后弹窗没打开' };
          const ta = document.getElementById('socraticModalAnswer');
          if (!ta) return { err: '弹窗里没有作答输入框' };
          ta.value = '回复力与位移成正比、方向相反，所以 F=-kx。';
          const before = graphView.nodes.length;
          window.submitSocraticAnswer();
          return { beforeCount: before };
        });
        if (opened.err) throw new Error(opened.err);
        const ans = await page.evaluate(c => window.__verifyWaitAnswer(c.beforeCount, 60000), opened);
        if (!ans.id) throw new Error('提交作答后 ' + Math.round(ans.waited / 1000) + ' 秒仍没有反馈节点');
        const st = await waitNodeSettled(page, ans.id, 180000);
        if (st.len < 20) throw new Error('流式内容为空或过短（' + st.len + ' 字）');
        const carried = await page.evaluate(id => {
          const n = graphView.nodeById[id];
          const sq = graphView.nodes.find(x => x.sqAuto && String(x.parentId) === String(id));
          return { messageIndex: n ? n.messageIndex : null, hasMeta: !!(n && n.socraticMeta), sq: !!sq };
        }, ans.id);
        if (carried.messageIndex >= 0) throw new Error('反馈仍落在消息派生节点上（messageIndex=' + carried.messageIndex + '）');
        if (!carried.hasMeta) throw new Error('反馈节点没带闭环元数据（socraticMeta）');
        if (!carried.sq) throw new Error('建议追问没有派生成独立节点（闭环下一题断）');
        ok('⑦ 苏格拉底闭环作答：已发通（卡上「我来回答」→ 弹窗 → 工作流节点对，流式 ' + st.len + ' 字，建议追问已派生）');
      } catch (e) { bad('⑦ 苏格拉底闭环作答', e); }

      // ===== 8. Φ 创造模式（T370：2026-10-20 起「创造」直达节点工坊，一句话档）=====
      // 旧版在这里等 preset 相位＋graphHarnessInstruction——工坊重做后
      // chooseHarnessMode('preset') 不带 legacy 一律 openRecipeWorkshop，旧断言
      // 恒红（backlog T370）。现在的真实入口：Φ 面板 → 模式菜单「创造」→ 全屏工坊
      // （空白草稿默认「一句话」档）→ 说一句 → POST /api/harness/recipe/draft →
      // 结果卡长出配方即发通（mock 回 {say, recipe} JSON，锚在系统提示词「节点工坊」）。
      try {
        await waitIdle('⑧ 创造模式');
        const preset = await page.evaluate(async () => {
          if (typeof window.toggleGraphPet === 'function') window.toggleGraphPet();
          const panel = document.querySelector('.graph-harness-window');
          const panelOpen = panel && !panel.hidden;
          if (!panelOpen && typeof window.toggleGraphPet === 'function') window.toggleGraphPet();
          const modeBtn = document.getElementById('graphHarnessModeBtn');
          if (!modeBtn) return { err: '模式按钮不在面板里' };
          modeBtn.click();
          const item = [...document.querySelectorAll('#graphHarnessModeMenu .graph-harness-mode-item')]
            .find(el => /创造/.test(el.textContent));
          if (!item) return { err: '模式菜单里没有创造项' };
          item.click();
          await new Promise(r => setTimeout(r, 600));
          const overlay = document.getElementById('recipeWorkshop');
          if (!overlay || overlay.hidden) return { err: '点「创造」后节点工坊没开（入口应是模式菜单直达工坊）' };
          const shell = overlay.querySelector('.rw-shell');
          const shellMode = shell ? shell.getAttribute('data-mode') : '';
          if (shellMode !== 'smart') {
            return { err: '工坊没开在「一句话」档（data-mode=' + shellMode + '）——上一通道的草稿残留？' };
          }
          const input = document.getElementById('rwSmartInput');
          if (!input) return { err: '工坊里没有一句话输入框' };
          input.value = '帮我造一个「三级追问」节点：三条编号行，级别标记 [基础][进阶][拓展]，出口从这三行解析，兜底从正文截问题文本。';
          document.getElementById('rwSmartGo').click();
          const cleanup = () => {
            // 收尾：关工坊并丢草稿——不丢的话 ⑩ 会接上这份草稿（落 localStorage），
            // 手动档第一句就不是「从零起草」了
            if (typeof window.closeRecipeWorkshop === 'function') window.closeRecipeWorkshop({ discard: true });
          };
          const t0 = Date.now();
          while (Date.now() - t0 < 90000) {
            const nameEl = document.querySelector('#rwSmartResult .rw-card-name');
            if (nameEl && /三级追问/.test(nameEl.textContent || '')) {
              const dyn = !!document.querySelector('#rwSmartResult .rw-chip-dyn');
              const say = document.querySelector('#rwSmartResult .rw-smart-say');
              cleanup();
              return { ok: true, say: String((say && say.textContent) || '').slice(0, 60), dyn: dyn };
            }
            const errBox = document.getElementById('rwSmartError');
            if (errBox && !errBox.hidden && String(errBox.textContent || '').trim()) {
              cleanup();
              return { err: '工坊起草失败：' + String(errBox.textContent).slice(0, 140) };
            }
            await new Promise(r => setTimeout(r, 1500));
          }
          cleanup();
          return { err: '90 秒内一句话档没长出配方结果卡' };
        });
        if (preset.err) throw new Error(preset.err);
        ok('⑧ 创造模式：已发通（模式菜单「创造」直达工坊一句话档 → 草稿往返，结果卡「三级追问」'
          + (preset.dyn ? '＋动态出口' : '') + '；' + preset.say + '）');
      } catch (e) { bad('⑧ 创造模式', e); }

      // ===== 9. Φ 答疑模式（chat 相位：只读不改图）=====
      // 真实入口：模式菜单点「答疑」→ 填问题 → 发送。答疑走纯文字回答路径
      // （mock 上游兜底中文一句），回答气泡出现且画布节点数不变＝发通且确实没动图。
      try {
        await waitIdle('⑨ 答疑模式');
        const chat = await page.evaluate(async () => {
          const countNodes = () => {
            try { return Object.keys(graphView.nodeById).length; } catch (e) { return -1; }
          };
          const nodeCountBefore = countNodes();
          if (typeof window.toggleGraphPet === 'function') window.toggleGraphPet();
          const panel = document.querySelector('.graph-harness-window');
          if (!panel || panel.hidden) { if (typeof window.toggleGraphPet === 'function') window.toggleGraphPet(); }
          const modeBtn = document.getElementById('graphHarnessModeBtn');
          if (!modeBtn) return { err: '模式按钮不在面板里' };
          modeBtn.click();
          const item = [...document.querySelectorAll('#graphHarnessModeMenu .graph-harness-mode-item')]
            .find(el => /答疑/.test(el.textContent));
          if (!item) return { err: '模式菜单里没有答疑项' };
          item.click();
          if (window._harnessMode && window._harnessMode() !== 'chat') return { err: '点菜单项后未进入答疑模式' };
          const input = document.getElementById('graphHarnessInstruction');
          input.value = '用一句话解释一下什么是阻尼振动？';
          document.getElementById('graphHarnessSendBtn').click();
          const t0 = Date.now();
          while (Date.now() - t0 < 90000) {
            const bubbles = document.querySelectorAll('#graphHarnessChat .graph-harness-message-assistant');
            const last = bubbles.length ? bubbles[bubbles.length - 1] : null;
            if (last && /mock 上游回复|阻尼/.test(last.textContent || '')) {
              const nodeCountAfter = countNodes();
              if (window.chooseHarnessMode && window._harnessMode() !== 'edit') window.chooseHarnessMode('edit');
              return { ok: true, text: (last.textContent || '').slice(0, 60), nodeCountBefore, nodeCountAfter };
            }
            await new Promise(r => setTimeout(r, 1500));
          }
          if (window.chooseHarnessMode && window._harnessMode() !== 'edit') window.chooseHarnessMode('edit');
          return { err: '90 秒内没有收到答疑回答气泡' };
        });
        if (chat.err) throw new Error(chat.err);
        if (chat.nodeCountAfter !== chat.nodeCountBefore) {
          throw new Error('答疑模式动了图（节点数 ' + chat.nodeCountBefore + '→' + chat.nodeCountAfter + '）');
        }
        ok('⑨ 答疑模式：已发通（chat 相位纯文字回答「' + chat.text + '…」，画布未被改动）');
      } catch (e) { bad('⑨ 答疑模式', e); }
      // ===== ⑩ Φ 创造模式访谈流（T370：工坊手动档补丁对话——初稿＋追问 → 答完补丁收尾）=====
      // 旧版访谈在 Φ preset 相位的 ask_user 工具上；工坊重做后访谈＝draft 接口的
      // question 机制：模型「初稿＋一个问题」同轮返回（只问不答会被后端折成兜底话
      // 并丢 question，见 harness/recipe_draft.py 空补丁分支），用户答完第二轮补丁
      // 只改要改的字段。真发两轮验整条链：问得出（.rw-question 渲染进气泡）、答完
      // 改得上（卡片输入口换成「力一/力二」且出口原样＝深合并没有冲掉已配好的字段）。
      try {
        await waitIdle('⑩ 创造模式访谈');
        const round1 = await page.evaluate(async () => {
          if (typeof window.toggleGraphPet === 'function') window.toggleGraphPet();
          const panel = document.querySelector('.graph-harness-window');
          if ((!panel || panel.hidden) && typeof window.toggleGraphPet === 'function') window.toggleGraphPet();
          const modeBtn = document.getElementById('graphHarnessModeBtn');
          if (!modeBtn) return { err: '模式按钮不在面板里' };
          modeBtn.click();
          const item = [...document.querySelectorAll('#graphHarnessModeMenu .graph-harness-mode-item')]
            .find(el => /创造/.test(el.textContent));
          if (!item) return { err: '模式菜单里没有创造项' };
          item.click();
          await new Promise(r => setTimeout(r, 600));
          const overlay = document.getElementById('recipeWorkshop');
          if (!overlay || overlay.hidden) return { err: '点「创造」后节点工坊没开' };
          // 访谈住在手动档的补丁对话里；⑧ 已 discard，这里从空白草稿起（第一句＝从零起草）
          const manualBtn = overlay.querySelector('.rw-mode-btn[data-rw-mode="manual"]');
          if (!manualBtn) return { err: '工坊里没有「手动调」档钮' };
          manualBtn.click();
          const input = document.getElementById('rwChatInput');
          if (!input) return { err: '手动档里没有对话输入框' };
          input.value = '访谈试炼：帮我造一个合力计算节点';
          document.getElementById('rwAskBtn').click();
          const t0 = Date.now();
          while (Date.now() - t0 < 90000) {
            const q = document.querySelector('#rwChatLog .rw-question-text');
            const cardName = document.querySelector('#rwCard .rw-card-name');
            if (q && /输入口/.test(q.textContent || '') && cardName && /访谈试炼节点/.test(cardName.textContent || '')) {
              const ports = [...document.querySelectorAll('#rwCard .rw-card-port-row')].map(r => r.textContent || '').join(' ');
              return { ok: true, question: String(q.textContent).slice(0, 50), round1HasL1: /力一/.test(ports) };
            }
            await new Promise(r => setTimeout(r, 1500));
          }
          return { err: '第一轮追问未出现（draft 往返或 .rw-question 渲染断）' };
        });
        if (round1.err) throw new Error(round1.err);
        if (round1.round1HasL1) throw new Error('第一轮草稿就带了「力一」——第二轮补丁的改动将无法证明');
        const round2 = await page.evaluate(async () => {
          const input = document.getElementById('rwChatInput');
          input.value = '访谈定稿：输入口是力一和力二，出口要合力讲解和示意图。';
          document.getElementById('rwAskBtn').click();
          const t0 = Date.now();
          while (Date.now() - t0 < 90000) {
            const ports = [...document.querySelectorAll('#rwCard .rw-card-port-row')].map(r => r.textContent || '').join(' ');
            if (/力一/.test(ports) && /力二/.test(ports)) {
              const keep = /合力讲解/.test(ports) && /示意图/.test(ports);
              // 取**最后一个**改动标签：第一轮初稿也有一个（列了整份草稿的字段），
              // 第二轮补丁的才是这次改动的清单
              const chipList = document.querySelectorAll('#rwChatLog .rw-changed-chips');
              const chips = chipList.length ? String(chipList[chipList.length - 1].textContent).slice(0, 40) : '';
              // 收尾：关工坊丢草稿，别把访谈状态漏给后续轮次
              if (typeof window.closeRecipeWorkshop === 'function') window.closeRecipeWorkshop({ discard: true });
              return { ok: true, keep, chips };
            }
            await new Promise(r => setTimeout(r, 1500));
          }
          if (typeof window.closeRecipeWorkshop === 'function') window.closeRecipeWorkshop({ discard: true });
          return { err: '第二轮补丁未生效（历史携带或卡片没换输入口）' };
        });
        if (round2.err) throw new Error(round2.err);
        if (!round2.keep) throw new Error('补丁把没提到的出口冲掉了（深合并语义断）');
        ok('⑩ 创造模式访谈：已发通（第一轮初稿＋追问「' + round1.question + '」进气泡；'
          + '第二轮答完补丁换口，改动标签「' + round2.chips + '」，出口字段原样保留）');
      } catch (e) { bad('⑩ 创造模式访谈', e); }
      // ===== 11. 空白节点生成（2026-10-24 T403：两条路合一） =====
      // 旧空白路自带一份提示词/流式/记账，与工作流路生成两种内容（T401）；现在卡上按钮、
      // 任务重试、Φ、「全部开始」都走同一条 _executeParallelWorkflow。这条通道真发一次并
      // 断言四件：①请求带 workflow_context.target.kind='blank'＋卡上要求，提示词不再是
      // 「请生成问题节点内容。」；②收尾写 status=done＋inputHash；③再点两次「全部开始」
      // 不再为这张卡发请求（T400 的「每次重跑」）。
      try {
        const blankInfo = await page.evaluate(async () => {
          if (typeof openAddBlankNodeModal !== 'function' || typeof createManualNode !== 'function') {
            return { err: '画布入口不在（openAddBlankNodeModal/createManualNode）' };
          }
          // 走真实 UI 入口：打开添加面板 → 选「AI 生成空白」（面板项调的就是 createManualNode）
          openAddBlankNodeModal(180, 180);
          createManualNode('blank');
          await new Promise(r => setTimeout(r, 400));
          const node = graphView.nodes.find(n => n.kind === 'blank');
          if (!node) return { err: '空白节点没建出来' };
          const ta = document.querySelector('[data-node-id="' + node.id + '"] .graph-blank-input');
          if (!ta) return { err: '空白卡要求框没渲染出来' };
          ta.value = '写一个反例：大角度下单摆周期会变长';
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          const btn = ta.parentElement.querySelector('.graph-regen-btn');
          if (!btn) return { err: '空白卡生成按钮没渲染出来' };
          btn.click();
          return { id: node.id };
        });
        if (blankInfo.err) throw new Error(blankInfo.err);
        const st = await waitNodeSettled(page, blankInfo.id, 120000);
        if (st.len < 8) throw new Error('空白节点流式内容为空或过短（' + st.len + ' 字）——统一发送链可能没接上');
        const settled = await page.evaluate((id) => {
          const n = graphView.nodeById[id];
          return n ? { status: n.status, hash: n.inputHash || '', req: n.requirements || '' } : null;
        }, blankInfo.id);
        if (!settled || settled.status !== 'done') throw new Error('空白节点收尾没写 status=done（当前 ' + (settled && settled.status) + '）');
        if (!settled.hash) throw new Error('空白节点收尾没写 inputHash——「全部开始」会每次重跑（T400 回退）');
        if (settled.req.indexOf('写一个反例') < 0) throw new Error('卡上要求没同步进节点');
        const reqBody = blankChatRequests[blankChatRequests.length - 1];
        if (!reqBody) throw new Error('空白节点的请求没带 workflow_context.target.kind=blank（提示词可能又走问题节点兜底）');
        if (!String(reqBody.prompt || '').includes('写一个反例')) throw new Error('卡上要求没进提示词（T401 回退）');
        if (String(reqBody.prompt || '').includes('请生成问题节点内容')) throw new Error('空白提示词又退化成问题节点兜底（T401 回退）');
        if (String(reqBody.branch_type) !== 'blank') throw new Error('空白请求 branch_type 不是 blank：' + reqBody.branch_type);
        const beforeRuns = blankChatRequests.length;
        // 连点两次「全部开始」：不能为这张已经完成的卡再发请求
        for (let round = 0; round < 2; round++) {
          await page.evaluate(() => {
            const btn = document.getElementById('runAllBtn');
            if (btn) btn.click();
          });
          await page.waitForFunction(() => !(typeof _isSendBusy === 'function' && _isSendBusy())
            && !(typeof workflowRunActive !== 'undefined' && workflowRunActive), null, { timeout: 60000 }).catch(() => {});
          await wait(400);
          if (blankChatRequests.length !== beforeRuns) {
            throw new Error('「全部开始」第 ' + (round + 1) + ' 次又为已完成的空白卡发了请求（T400 回退）');
          }
        }
        // 另一张**没点过卡上按钮**的空白卡：第一次「全部开始」要真把它跑起来（白名单＋
        // 进度判定＋记账整链的正面），第二次再点不重复发（反面）。这才是用户验收口径的
        // 「连点两次全部开始」——上面那张是按钮生成的，只能证明已完成卡不重跑。
        const blank2 = await page.evaluate(async () => {
          openAddBlankNodeModal(560, 430);
          createManualNode('blank');
          await new Promise(r => setTimeout(r, 350));
          const nodes = graphView.nodes.filter(n => n.kind === 'blank');
          const n = nodes[nodes.length - 1];
          if (!n) return { err: '第二张空白卡没建出来' };
          const ta = document.querySelector('[data-node-id="' + n.id + '"] .graph-blank-input');
          if (!ta) return { err: '第二张空白卡要求框没渲染出来' };
          ta.value = '用一句话总结这张卡要生成什么';
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          return { id: n.id };
        });
        if (blank2.err) throw new Error(blank2.err);
        const beforeAll = blankChatRequests.length;
        await page.evaluate(() => {
          const btn = document.getElementById('runAllBtn');
          if (btn) btn.click();
        });
        await page.waitForFunction((n) => {
          const node = graphView.nodeById[n];
          return node && !node.busy && node.status === 'done' && String(node.content || '').length > 0;
        }, blank2.id, { timeout: 90000 });
        if (blankChatRequests.length !== beforeAll + 1) {
          throw new Error('「全部开始」没有为待生成的空白卡发请求（白名单/进度判定漏了）');
        }
        if (!String((blankChatRequests[blankChatRequests.length - 1] || {}).workflow_context.target.label || '').includes('空白')) {
          throw new Error('「全部开始」跑的空白卡目标标签不对');
        }
        // 这一轮可能还带着别的待生成节点：等整轮收工再点第二次
        await page.waitForFunction(() => !(typeof _isSendBusy === 'function' && _isSendBusy())
          && !(typeof workflowRunActive !== 'undefined' && workflowRunActive), null, { timeout: 90000 }).catch(() => {});
        const beforeAgain = blankChatRequests.length;
        await page.evaluate(() => {
          const btn = document.getElementById('runAllBtn');
          if (btn) btn.click();
        });
        await wait(1600);
        if (blankChatRequests.length !== beforeAgain) {
          throw new Error('第二张空白卡完成后「全部开始」又重跑了（inputHash/status 没记上）');
        }
        ok('⑪ 空白节点生成：已发通（统一工作流路，' + st.len + ' 字；收尾写 status/inputHash；'
          + '「全部开始」能生成新卡、连点两次零新增请求）');
      } catch (e) { bad('⑪ 空白节点生成', e); }

    } else {
      ['② 节点追问', '③ 苏格拉底回答', '④ 重试', '⑤ 进阶支线', '⑥ 方向钮', '⑦ 苏格拉底闭环作答', '⑧ 创造模式', '⑨ 答疑模式', '⑩ 创造模式访谈', '⑪ 空白节点生成'].forEach(n =>
        bad(n, new Error('首问未通，依赖它的通道没法验')));
    }

    if (pageErrors.length) console.log('\n页面异常：' + pageErrors.slice(0, 3).join(' | '));
  } catch (e) {
    bad('环境', e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { server.kill('SIGTERM'); } catch (e) {}
    await wait(600);
    try { server.kill('SIGKILL'); } catch (e) {}
    try { rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }

  const passed = results.filter(r => r[0]).length;
  console.log(`\n发送通道真机验证：${passed} / ${results.length} 条已发通`);
  if (passed !== results.length) {
    console.log('\n--- 服务日志尾部 ---\n' + log.split('\n').slice(-30).join('\n'));
    process.exit(1);
  }
}

main().catch(e => { console.error('运行失败：' + (e && e.message || e)); process.exit(1); });
