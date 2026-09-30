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
//   node scripts/mock_upstream.mjs        # 127.0.0.1:5061，OpenAI 兼容 SSE/JSON 双格式
// 再用环境变量把验证模型指过去（七条通道全走真实 UI 路径，只是上游换成 mock）：
//   VERIFY_PROVIDER=opencode-go VERIFY_MODEL=mock-1 \
//   VERIFY_BASE_URL=http://127.0.0.1:5061/v1 VERIFY_API_KEY=mock node scripts/verify_send_channels.mjs
// mock 回包覆盖：问题概要 / 建议模块行 / 学习卡片 XML（含 <extend> 的苏格拉底＋进阶
// 方向段——缺了产品会走兜底空端口，见 T57 坑②）/ 创造模式 create_recipe tool_calls。

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
  for (const f of ['http_client.py', 'llm_common.py', 'usage_stats.py']) {
    cpSync(join(ROOT, f), join(workDir, f));
  }
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

    // ===== 2. 节点追问 / 3. 没看懂 / 4. 苏格拉底回答 =====
    //
    // 2026-09-27 重写（见 docs/backlog.md T40）。**旧版三条通道全走「拖输出端口」一条路，
    // 且从 `node.outputPorts` 取端口——那个字段全仓只存在于本脚本里，产品从来没有过。**
    // 端口是渲染时从 `_nodeOutputLabels()` 推导、写在 DOM 的 data-* 上的，所以旧版必然
    // 报「源节点没有可用输出端口：[]」——**换任何 key 都验不了**，而且那条报错长得像产品回归。
    //
    // 更根本的是：三条通道在产品里根本不是同一条路，各走各的真实入口——
    //   ② 节点追问   → 拖标签含「追问」的输出端口（物理/数学/知识图谱/可视化模块都有）
    //   ③ 没看懂     → 模块节点上的按钮，走 `dontUnderstandModule()` 开分支弹窗，
    //                  **没有名叫「没看懂」的输出端口**（`GRAPH_MODULE_DEFAULT_OUTPUTS`
    //                  里 physics/math/graph/viz 只有「追问」）
    //   ④ 苏格拉底回答 → 苏格拉底模块的端口是「问题1/2/3」、type=socratic；
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

      // ③ 没看懂：走 confused 分支。模块节点**没有 messageIndex**（内容存在 node.content 上），
      //    所以锚点要用节点自己的 timestamp —— 这也是产品自己的做法
      //    （graph-render.js 的 _vizCheckRegenerate 就是 `parentId: String(node.timestamp||'')`）。
      //    与⑤「重新生成」不是同一条路：⑤是 runWorkflowNode 重跑模块，
      //    ③是 sendBranchQuick 带锚点发一条新问题。
      try {
        await waitIdle('③ 没看懂');
        const created = await page.evaluate(async () => {
          const picked = window.__verifyPickModule();
          if (!picked) return { err: '画布上没有已生成内容的模块节点' };
          const node = graphView.nodeById[picked.id];
          if (!node) return { err: '源节点不在了' };
          const parentId = String(node.timestamp || '');
          if (!parentId) return { err: '源节点没有 timestamp 可作锚点' };
          const before = graphView.nodes.length;
          window.dontUnderstandModule(node.moduleKey || 'extend', parentId);
          await new Promise(r => setTimeout(r, 600));
          const modal = document.getElementById('branchModal');
          if (!modal || modal.hidden) return { err: '调 dontUnderstandModule 后分支弹窗没打开' };
          window.submitBranchModal();
          await new Promise(r => setTimeout(r, 1200));
          return { beforeCount: before, moduleKey: node.moduleKey || 'extend' };
        });
        if (created.err) throw new Error(created.err);
        const ans = await page.evaluate(c => window.__verifyWaitAnswer(c.beforeCount, 60000), created);
        if (!ans.id) throw new Error('提交分支弹窗后 ' + Math.round(ans.waited / 1000) + ' 秒仍没有回答节点');
        const st = await waitNodeSettled(page, ans.id, 180000);
        if (st.len < 20) throw new Error('流式内容为空或过短（' + st.len + ' 字）');
        ok('通道③ 没看懂：已发通（confused 分支，源模块 ' + created.moduleKey + '），流式收到 ' + st.len + ' 字');
      } catch (e) { bad('通道③ 没看懂', e); }

      // ④ 苏格拉底回答：苏格拉底模块的「问题N」端口（type=socratic）→ 草稿点「直接问AI」
      try {
        await waitIdle('④ 苏格拉底回答');
        const port = await pickPort({ type: 'socratic' });
        const created = await page.evaluate(p => window.__verifyBranchFromPort(p,
          '请围绕苏格拉底追问继续展开讲解：为什么瑞利散射公式里的四次方与分子尺度的关系要这样取？'), port);
        if (!created.id && !created.sent) throw new Error(created.why || '没有可用节点');
        const ans = await page.evaluate(c => window.__verifyWaitAnswer(c.beforeCount, 60000), created);
        if (!ans.id) throw new Error('草稿发出后 ' + Math.round(ans.waited / 1000) + ' 秒仍没有回答节点');
        const st = await waitNodeSettled(page, ans.id, 180000);
        if (st.len < 20) throw new Error('流式内容为空或过短（' + st.len + ' 字）');
        ok('通道④ 苏格拉底回答：已发通（源端口「' + port.meta.label + '」），流式收到 ' + st.len + ' 字');
      } catch (e) { bad('通道④ 苏格拉底回答', e); }

      // ===== 5. 重试（重新生成）=====
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
        await waitIdle('⑤ 重试');
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
        ok('⑤ 重试：已发通，重生成后 ' + st.len + ' 字（原 ' + regen.beforeLen + ' 字，'
          + Math.round(regen.waited / 1000) + ' 秒后确实变了）');
      } catch (e) { bad('⑤ 重试', e); }

      // ===== 6. 进阶支线（learn 端口 → 「请详细讲解」预填草稿 → 发送提问）=====
      // 与 ②④ 同一条 __verifyBranchFromPort 真实入口，但端口类型不同：learn 端口的
      // 草稿预填是「请详细讲解：{问题}」，验证的是 type=learn 的拖出路由与预填模板。
      try {
        await waitIdle('⑥ 进阶支线');
        const port = await pickPort({ type: 'learn' });
        const created = await page.evaluate(p => window.__verifyBranchFromPort(p,
          '请详细讲解：瑞利散射的四次方依赖是怎么来的？'), port);
        if (!created.id && !created.sent) throw new Error(created.why || '没有可用节点');
        const ans = await page.evaluate(c => window.__verifyWaitAnswer(c.beforeCount, 60000), created);
        if (!ans.id) throw new Error('草稿发出后 ' + Math.round(ans.waited / 1000) + ' 秒仍没有回答节点');
        const st = await waitNodeSettled(page, ans.id, 180000);
        if (st.len < 20) throw new Error('流式内容为空或过短（' + st.len + ' 字）');
        ok('⑥ 进阶支线：已发通（learn 端口「' + port.meta.label + '」→ 预填草稿 → 发送提问），流式收到 ' + st.len + ' 字');
      } catch (e) { bad('⑥ 进阶支线', e); }

      // ===== 7. Φ 创造模式（preset 相位 → create_recipe）=====
      // 真实入口：打开 Φ 面板 → 模式按钮开菜单 → 点「✦ 创造」→ 填指令 → 发送。
      // 后端 preset 相位返回 operations（mock 上游回 create_recipe tool_calls），
      // 预览面板出现配方行即发通。
      try {
        await waitIdle('⑦ 创造模式');
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
          if (window._harnessMode && window._harnessMode() !== 'preset') return { err: '点菜单项后未进入创造模式' };
          const input = document.getElementById('graphHarnessInstruction');
          input.value = '帮我造一个「三级追问」节点：三条编号行，级别标记 [基础][进阶][拓展]，出口从这三行解析，兜底从正文截问题文本。';
          document.getElementById('graphHarnessSendBtn').click();
          const t0 = Date.now();
          while (Date.now() - t0 < 90000) {
            const resultBox = document.getElementById('graphHarnessResult');
            const opRows = resultBox ? resultBox.querySelectorAll('.graph-harness-op') : [];
            if (opRows.length) {
              const text = [...opRows].map(el => el.textContent).join(' ');
              // 收尾：切回编辑模式，别把锁定状态留给下一轮
              if (window.chooseHarnessMode && window._harnessMode() !== 'edit') window.chooseHarnessMode('edit');
              return { ok: true, ops: opRows.length, hasRecipe: /配方/.test(text), text: text.slice(0, 80) };
            }
            await new Promise(r => setTimeout(r, 1500));
          }
          if (window.chooseHarnessMode && window._harnessMode() !== 'edit') window.chooseHarnessMode('edit');
          return { err: '90 秒内没有收到创造模式操作清单' };
        });
        if (preset.err) throw new Error(preset.err);
        if (!preset.hasRecipe) throw new Error('返回了操作但不像配方操作：' + preset.text);
        ok('⑦ 创造模式：已发通（模式菜单进入 preset 相位 → ' + preset.ops + ' 条配方操作，预览已出）');
      } catch (e) { bad('⑦ 创造模式', e); }

      // ===== 8. Φ 答疑模式（chat 相位：只读不改图）=====
      // 真实入口：模式菜单点「答疑」→ 填问题 → 发送。答疑走纯文字回答路径
      // （mock 上游兜底中文一句），回答气泡出现且画布节点数不变＝发通且确实没动图。
      try {
        await waitIdle('⑧ 答疑模式');
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
        ok('⑧ 答疑模式：已发通（chat 相位纯文字回答「' + chat.text + '…」，画布未被改动）');
      } catch (e) { bad('⑧ 答疑模式', e); }
    } else {
      ['② 节点追问', '③ 没看懂', '④ 苏格拉底回答', '⑤ 重试', '⑥ 进阶支线', '⑦ 创造模式', '⑧ 答疑模式'].forEach(n =>
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
