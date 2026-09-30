#!/usr/bin/env node
// Φ 会话解耦真机验证（AGENTS.md 硬规则 6，2026-09-30 落地于 Φ 会话与画布解耦）
// mock 上游 + 临时数据目录 + 真浏览器（Playwright），八条通道逐条真发并记录：
//   ①旧数据迁移（本地+服务端兜底，旧键本地/服务端均清理）②Φ纯问答真发
//   ③未绑定只放行问答 ④绑当前画布的改图真发＋「应用全部」真实落图
//   ⑤新建 Φ 会话 ⑥切画布不换茬＋绑非当前画布的改图拦截
//   ⑦删单个 Φ 会话 ⑧清空所有 Φ 对话（全程画布零触碰断言）
// 跑法：node scripts/verify_phi_sessions.mjs（零真实依赖，不花钱；PORT 5065 见下）
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = 5079;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = ms => new Promise(r => setTimeout(r, ms));

const MODEL = {
  id: 'verify-model', name: '验证用模型',
  provider: 'opencode-go', model: 'mock-1', apiKey: 'mock',
  baseUrl: 'http://127.0.0.1:5065/v1',
};
const SLOTS = ['agent_model', 'html_model', 'descriptor_model', 'quiz_model', 'graph_model', 'branch_model'];

const results = [];
function ok(name) { results.push([true, name]); console.log('✓ ' + name); }
function bad(name, err) { results.push([false, name]); console.log('❌ ' + name + ' -> ' + (err && err.message || err)); }
async function waitHealth(base, ms = 30000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    try { if ((await fetch(base + '/health')).ok) return true; } catch (e) {}
    await wait(300);
  }
  throw new Error('health 超时：' + base);
}

async function main() {
  // mock 上游（外部已起则复用）。端口 5065：**不能用默认 5061**——Node undici 的
// fetch 坏端口表含 5060/5061（SIP），直连会报 'bad port'；verify_send_channels
// 当年没踩到是因为它只经 Python 端转发上游，不从 Node 直连 mock
  let mock = null;
  try { await waitHealth('http://127.0.0.1:5065', 1500); } catch (e) {
    mock = spawn('node', ['scripts/mock_upstream.mjs'], { stdio: 'ignore', env: { ...process.env, PORT: '5065' } });
    mock.on('error', err => console.error('[mock] spawn 失败：', err.message));
    try { await waitHealth('http://127.0.0.1:5065', 5000); } catch (e2) { mock.kill(); throw e2; }
  }

  // 服务（临时数据目录）
  const workDir = mkdtempSync(join(tmpdir(), 'phymathia-verify-phi-'));
  cpSync(join(process.cwd(), 'src'), join(workDir, 'src'), { recursive: true });
  cpSync(join(process.cwd(), 'harness'), join(workDir, 'harness'), { recursive: true });
  for (const f of ['http_client.py', 'llm_common.py', 'usage_stats.py']) {
    cpSync(join(process.cwd(), f), join(workDir, f));
  }
  const server = spawn('python3', ['src/main.py', '-p', String(PORT)], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = '';
  server.stdout.on('data', d => { srvLog += d; });
  server.stderr.on('data', d => { srvLog += d; });
  let browser = null;
  try {
    await waitHealth(BASE);
    // 预置服务端旧数据：sess_leg2 的历史只存在于服务端 KV（测迁移的服务端兜底路径）
    await fetch(BASE + '/api/kv/' + encodeURIComponent('harness_history:sess_leg2'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: [{ id: 'h_srv', role: 'user', content: '只存在服务端的旧问题', timestamp: 1700000000000 }] }),
    });

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
    // harness 请求计数：门槛通道判「请求零发出」用
    const harnessReqs = [];
    page.on('request', r => { if (r.url().includes('/api/harness')) harnessReqs.push(r.url()); });
    await page.addInitScript((cfg) => {
      try {
        if (sessionStorage.getItem('verify_seeded')) return;  // 只种一次：防二次导航重播旧数据
        sessionStorage.setItem('verify_seeded', '1');
        localStorage.setItem('phymathia_user_models', JSON.stringify([cfg.model]));
        const act = {};
        for (const s of cfg.slots) act[s] = cfg.model.id;
        localStorage.setItem('phymathia_active_models', JSON.stringify(act));
        localStorage.setItem('phymathia_onboarding_done', '1');
        localStorage.setItem('phymathia_guide_seen', '1');
        // 旧数据形态：Φ 对话按画布 sid 存（本地 1 份 + 服务端 1 份，见上方 KV 预置）
        localStorage.setItem('phymathia_sessions', JSON.stringify({
          sess_leg1: { id: 'sess_leg1', title: '迁移画布一', sessionId: 'remote1', createdAt: 1, updatedAt: 2 },
          sess_leg2: { id: 'sess_leg2', title: '迁移画布二', sessionId: 'remote2', createdAt: 1, updatedAt: 1 },
        }));
        localStorage.setItem('phymathia_current_session', 'sess_leg1');
        localStorage.setItem('phymathia_harness_history_sess_leg1', JSON.stringify([
          { id: 'h_old1', role: 'user', content: '旧画布上的第一个问题', timestamp: 1700000000000 },
          { id: 'h_old2', role: 'assistant', content: '旧回答内容', summary: '旧回答内容', operations: [], timestamp: 1700000000001 },
        ]));
      } catch (e) { console.error('[verify] 种子写入失败：' + e.message); }
    }, { model: MODEL, slots: SLOTS });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.startQuestionWorkflow === 'function', null, { timeout: 20000 });
    await page.waitForTimeout(1500);

    // ---- 通道①：旧数据迁移（本地 + 服务端兜底 → phi 会话，旧键清理）----
    try {
      const m = await page.evaluate(async () => {
        const list = Object.values(phiSessions);
        const byTitle = {};
        list.forEach(s => { byTitle[s.title] = s; });
        const oldLocal = localStorage.getItem('phymathia_harness_history_sess_leg1');
        const oldLocalVal = oldLocal ? String(oldLocal).slice(0, 120) : null;
        const oldSrv1 = await (await fetch('/api/kv/' + encodeURIComponent('harness_history:sess_leg1'))).json();
        const oldSrv2 = await (await fetch('/api/kv/' + encodeURIComponent('harness_history:sess_leg2'))).json();
        const s1 = byTitle['迁移画布一'], s2 = byTitle['迁移画布二'];
        const h1 = JSON.parse(localStorage.getItem('phymathia_harness_history_' + (s1 && s1.id) || 'null') || '[]');
        const h2 = JSON.parse(localStorage.getItem('phymathia_harness_history_' + (s2 && s2.id) || 'null') || '[]');
        return {
          count: list.length, s1: !!s1, s2: !!s2,
          s1Bound: s1 && s1.boundSid, s2Bound: s2 && s2.boundSid,
          h1Len: h1.length, h2Len: h2.length,
          oldLocalGone: oldLocal === null, oldLocalVal,
          oldSrvGone1: !oldSrv1.value, oldSrvGone2: !oldSrv2.value,
          current: currentPhiId,
        };
      });
      if (m.count !== 2 || !m.s1 || !m.s2) throw new Error('迁移应产生 2 个 phi 会话：' + JSON.stringify(m));
      if (m.s1Bound !== 'sess_leg1' || m.s2Bound !== 'sess_leg2') throw new Error('迁移会话未绑定原画布：' + JSON.stringify(m));
      if (m.h1Len !== 2 || m.h2Len !== 1) throw new Error('迁移历史条数不对（本地2/服务端兜底1）：' + JSON.stringify(m));
      if (!m.oldLocalGone || !m.oldSrvGone1 || !m.oldSrvGone2) throw new Error('旧键未清理：' + JSON.stringify(m) + ' oldVal=' + (m.oldLocalVal || 'null'));
      if (!m.current) throw new Error('迁移后无当前 Φ 会话');
      ok('通道① 旧数据迁移：2 画布 → 2 个绑定 Φ 会话（本地+服务端兜底），旧键本地+服务端均清理');
    } catch (e) { bad('通道① 旧数据迁移', e); }

    // 打开 Φ 面板
    await page.evaluate(() => { window.openGraphHarness ? openGraphHarness() : toggleGraphPet(); });
    await page.waitForTimeout(400);


    // ---- 通道②：Φ 纯问答真发（mock 上游回包 → 气泡渲染 + 自动命名）----
    try {
      const histBefore = await page.evaluate(() => harnessHistory.length);
      await page.fill('#graphHarnessInstruction', '什么是简谐运动？');
      await page.click('#graphHarnessSendBtn');
      await page.waitForFunction(n => harnessHistory.length >= n + 2, histBefore, { timeout: 20000, polling: 200 })
        .catch(async () => {
          const st = await page.evaluate(() => JSON.stringify({
            status: document.getElementById('graphHarnessStatus').innerText,
            model: (getActiveModelForRole('graph') || {}).model,
            bound: _harnessBoundSid(), busy: harnessBusy,
          }));
          throw new Error('超时，页面状态：' + st);
        });
      const model = await page.evaluate(() => (getActiveModelForRole('graph') || {}).model);
      ok('通道② Φ 纯问答真发：经后端真发到 mock 上游（' + model + '），回包入对话（历史 ' + histBefore + '→' + (histBefore + 2) + '）');
    } catch (e) { bad('通道② Φ 纯问答真发', e); }

    // ---- 通道③：改图绑定门槛（解绑后改图指令被拦、纯问答放行）----
    try {
      const sentBefore = harnessReqs.length;
      await page.evaluate(() => toggleHarnessSessionBinding(currentPhiId)); // 解绑
      await page.fill('#graphHarnessInstruction', '帮我新增一个关于「导数」的知识点');
      await page.click('#graphHarnessSendBtn');
      await page.waitForFunction(() => document.getElementById('graphHarnessStatus').innerText.includes('未绑定画布'), null, { timeout: 8000 });
      // 拦截语义：改图请求根本没发出去（这才是「门槛」的真判据，不只看提示文案）
      if (harnessReqs.length !== sentBefore) throw new Error('被拦的改图指令不应发出请求');
      await page.fill('#graphHarnessInstruction', '什么是傅里叶变换？');
      await page.click('#graphHarnessSendBtn');
      await page.waitForFunction(() => document.getElementById('graphHarnessStatus').innerText.startsWith('已回复'), null, { timeout: 20000 });
      ok('通道③ 未绑定门槛：改图指令被拦（请求零发出），纯问答照常发通');
    } catch (e) { bad('通道③ 未绑定门槛', e); }

    // ---- 通道④：绑回当前画布 + 改图真发 + 真实应用路径 ----
    try {
      await page.evaluate(() => toggleHarnessSessionBinding(currentPhiId)); // 绑当前画布 sess_leg1
      const bound = await page.evaluate(() => _harnessBoundSid());
      if (bound !== 'sess_leg1') throw new Error('换绑失败：' + bound);
      // 先给画布种一个节点：空画布会走「没有节点」守卫，改图请求根本发不出去
      await page.evaluate(() => {
        const st = getGraphState('sess_leg1');
        st.customNodes = [{ id: 'seed_note', kind: 'human_note', label: '种子节点', content: '种子内容' }];
        saveGraphState('sess_leg1', st);
        renderGraphCanvas();
      });
      await page.waitForTimeout(300);
      await page.fill('#graphHarnessInstruction', '帮我新增一个关于「导数」的知识点');
      await page.click('#graphHarnessSendBtn');
      await page.waitForFunction(() => {
        const t = document.getElementById('graphHarnessStatus').innerText;
        return t.startsWith('已回复') || t.startsWith('审阅完成');
      }, null, { timeout: 20000 });
      // 真实应用路径：注入后端格式 ops → 「应用全部」按钮走 _applyOps 全链
      await page.evaluate(() => {
        harnessResult = {
          summary: '真机应用验证', status: 'ok', operations: [
            { op: 'create_node', temp_id: 'tmp_phi1', assigned_id: 'phi_node_1', kind: 'knowledge', label: '导数', content: '瞬时变化率（真机验证）' },
          ],
        };
        harnessResult._binding = _harnessBinding();
      });
      // 上一条 mock 回包无 ops 时应用条是隐藏的，先显出来再点（按钮仍是真实入口）
      await page.evaluate(() => document.getElementById('graphHarnessApplyActions').removeAttribute('hidden'));
      await page.click('#graphHarnessApplyActions button:nth-child(2)'); // 应用全部
      await page.waitForTimeout(600);
      const applied = await page.evaluate(() => {
        const st = getGraphState('sess_leg1');
        return { has: st.customNodes.some(n => n.id === 'phi_node_1'), label: (st.customNodes.find(n => n.id === 'phi_node_1') || {}).label };
      });
      if (!applied.has) throw new Error('应用后画布无新节点：' + JSON.stringify(applied));
      ok('通道④ Φ 改图真发（绑当前画布）：mock 回包渲染 + 「应用全部」真实落图（导数节点入画布）');
    } catch (e) { bad('通道④ Φ 改图真发', e); }

    // ---- 通道⑤：新建 Φ 会话（UI 点击）----
    try {
      const before = await page.evaluate(() => currentPhiId);
      await page.click('#graphHarnessSessionBtn');
      await page.click('.graph-harness-session-new');
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => ({ id: currentPhiId, bound: _harnessBoundSid(), len: Object.keys(phiSessions).length }));
      if (after.id === before || !after.id.startsWith('phi_')) throw new Error('新建未切换：' + JSON.stringify(after));
      if (after.bound !== 'sess_leg1') throw new Error('新建会话未默认绑当前画布：' + JSON.stringify(after));
      if (after.len !== 3) throw new Error('新建后应 3 个会话：' + JSON.stringify(after));
      ok('通道⑤ 新建 Φ 会话（菜单点击）：自动绑当前画布，原会话保留');
    } catch (e) { bad('通道⑤ 新建 Φ 会话', e); }

    // ---- 通道⑥：切画布 Φ 对话不换茬 + 绑非当前画布的改图门槛 ----
    try {
      const phiBefore = await page.evaluate(() => currentPhiId);
      const chatLen = await page.evaluate(() => harnessHistory.length);
      await page.evaluate(() => switchToSession('sess_leg2'));
      await page.waitForTimeout(800);
      const after = await page.evaluate(() => ({ phi: currentPhiId, len: harnessHistory.length, canvas: getCurrentSessionId() }));
      if (after.canvas !== 'sess_leg2') throw new Error('画布未切换');
      if (after.phi !== phiBefore || after.len !== chatLen) throw new Error('切画布重置了 Φ 对话（解耦被破坏）');
      // 当前 Φ 会话绑定的是 sess_leg1，而当前画布是 sess_leg2 → 改图应被拦
      await page.fill('#graphHarnessInstruction', '帮我新增一个知识点');
      await page.click('#graphHarnessSendBtn');
      await page.waitForFunction(() => document.getElementById('graphHarnessStatus').innerText.includes('绑定的是画布'), null, { timeout: 8000 });
      ok('通道⑥ 切画布 Φ 对话保持 + 绑非当前画布的改图被拦（提示去向）');
    } catch (e) { bad('通道⑥ 切画布不换茬/跨画布门槛', e); }

    // ---- 通道⑦：删单个 Φ 会话（UI + confirm）——画布零触碰 ----
    try {
      const canvasKeys = await page.evaluate(() => JSON.stringify({
        sessions: Object.keys(JSON.parse(localStorage.getItem('phymathia_sessions'))),
        g1: !!localStorage.getItem('phymathia_graph_sess_leg1'),
        g2: !!localStorage.getItem('phymathia_graph_sess_leg2'),
      }));
      await page.evaluate(() => switchToSession('sess_leg1'));
      await page.waitForTimeout(500);
      const victim = await page.evaluate(() => Object.values(phiSessions).find(s => s.id !== currentPhiId).id);
      page.once('dialog', d => d.accept());
      await page.evaluate(id => deleteHarnessSession(id), victim);
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => ({ count: Object.keys(phiSessions).length }));
      const canvasAfter = await page.evaluate(() => JSON.stringify({
        sessions: Object.keys(JSON.parse(localStorage.getItem('phymathia_sessions'))),
        g1: !!localStorage.getItem('phymathia_graph_sess_leg1'),
        g2: !!localStorage.getItem('phymathia_graph_sess_leg2'),
      }));
      if (after.count !== 2) throw new Error('删除后应剩 2 个：' + after.count);
      if (canvasKeys !== canvasAfter) throw new Error('画布数据被触碰：' + canvasKeys + ' -> ' + canvasAfter);
      ok('通道⑦ 删单个 Φ 会话（confirm 接受）：只删对话，画布名单与图状态零触碰');
    } catch (e) { bad('通道⑦ 删单个 Φ 会话', e); }

    // ---- 通道⑧：清空所有 Φ 对话——画布全部保留（T92 起＝菜单内联二次确认，无原生弹窗） ----
    try {
      await page.evaluate(() => _renderHarnessSessionMenu());
      await page.evaluate(() => clearAllHarnessSessions());
      // 第一下只挂内联确认条（真实用户路径）；真清空在「确认清空」那一下
      const armed = await page.evaluate(() => !!document.querySelector('#graphHarnessSessionMenu .graph-harness-clearall-confirm'));
      if (!armed) throw new Error('第一下未出现内联二次确认条（T92 回退？）');
      await page.evaluate(() => confirmClearAllHarnessSessions(true));
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => JSON.stringify({
        phi: Object.keys(phiSessions).length,
        canvases: Object.keys(JSON.parse(localStorage.getItem('phymathia_sessions'))).length,
        nodes: getGraphState('sess_leg1').customNodes.some(n => n.id === 'phi_node_1'),
      }));
      const m = JSON.parse(after);
      if (m.phi !== 1) throw new Error('清空后应只剩 1 个新建空白会话：' + m.phi);
      if (m.canvases !== 2 || !m.nodes) throw new Error('画布未完整保留：' + after);
      ok('通道⑧ 清空所有 Φ 对话（内联二次确认）：画布名单、图状态、已应用节点全部保留');
    } catch (e) { bad('通道⑧ 清空所有 Φ 对话', e); }

    if (pageErrors.length) {
      console.log('⚠ 页面错误：', pageErrors.slice(0, 5).join(' | '));
    } else {
      console.log('页面零未捕获错误');
    }
  } finally {
    browser && await browser.close().catch(() => {});
    server.kill();
    mock.kill();
  }
  const fails = results.filter(r => !r[0]).length;
  console.log(`\nΦ 解耦真机验证：${results.length - fails} PASS, ${fails} FAIL`);
  process.exitCode = fails ? 1 : 0;
}

main().catch(e => { console.error('验证脚本异常：', e); process.exit(1); });
