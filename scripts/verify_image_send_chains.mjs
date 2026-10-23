#!/usr/bin/env node
// 取材附图接入其余发送链的真机验证（2026-10-23，T381/T382；AGENTS.md 硬规则 6）。
//
// 与 verify_source_image_send.mjs 的分工：那一支验**服务端**（ingest/文件路由/images
// 消毒/页转图路由），本支验**前端发送链**真的把图带上了——真实页面跑真实发送链，
// 在假上游侧捕获转发后的请求体，逐条断言：
//   A. 问题分析 _generateAnalysis 带图（1 图＋2 页扫描件＝3 张，配额轮转）
//   B. 模块生成 _generateCustomNode 带图
//   C. 重试/带字重生成（messages 直传格式）带图，system 仍是纯字符串
//   D. 扫描版 PDF 页真的走 /api/input/pdf_pages
//   E. 无图请求最后一条 user 消息仍是纯字符串（回归锚）
//
// 用法：VERIFY_PYTHON=/abs/path/.venv-linux/bin/python node scripts/verify_image_send_chains.mjs
//（页渲染要 pypdfium2；默认 python3。自带临时数据目录与捕获型假上游，不碰真实 data/）
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 5082;
const UPSTREAM_PORT = 5067;
const BASE = `http://127.0.0.1:${PORT}`;
const PYTHON = process.env.VERIFY_PYTHON || 'python3';
const wait = ms => new Promise(r => setTimeout(r, ms));
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SCANNED_PDF_B64 = 'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgKHB5cGRmKQo+PgplbmRvYmoKMiAwIG9iago8PAovVHlwZSAvUGFnZXMKL0NvdW50IDIKL0tpZHMgWyA0IDAgUiA1IDAgUiBdCj4+CmVuZG9iagozIDAgb2JqCjw8Ci9UeXBlIC9DYXRhbG9nCi9QYWdlcyAyIDAgUgo+PgplbmRvYmoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUmVzb3VyY2VzIDw8Cj4+Ci9NZWRpYUJveCBbIDAuMCAwLjAgMjAwIDI2MCBdCi9QYXJlbnQgMiAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1Jlc291cmNlcyA8PAo+PgovTWVkaWFCb3ggWyAwLjAgMC4wIDIwMCAyNjAgXQovUGFyZW50IDIgMCBSCj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1NCAwMDAwMCBuIAowMDAwMDAwMTE5IDAwMDAwIG4gCjAwMDAwMDAxNjggMDAwMDAgbiAKMDAwMDAwMDI2MiAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKPj4Kc3RhcnR4cmVmCjM1NgolJUVPRgo=';

// ===== 捕获型假上游：每条请求摘摘要留档（服务端转发后的形状） =====
const captured = [];
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { body = null; }
    const msgs = (body && Array.isArray(body.messages)) ? body.messages : [];
    const last = msgs[msgs.length - 1] || {};
    const lastParts = Array.isArray(last.content) ? last.content : [];
    let imageTotal = 0;
    for (const m of msgs) {
      if (Array.isArray(m.content)) imageTotal += m.content.filter(p => p && p.type === 'image_url').length;
    }
    captured.push({
      msgCount: msgs.length,
      images: imageTotal,
      lastIsString: typeof last.content === 'string',
      lastParts: lastParts.length,
      firstIsString: typeof (msgs[0] || {}).content === 'string',
      url: String((body && body.model) || ''),
    });
    const stream = !!(body && body.stream);
    res.writeHead(200, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' });
    if (stream) {
      res.end('data: {"choices":[{"delta":{"content":"mock 收到，这里是一条足够长的讲解占位文本，用来让前端把流跑完。"}}]}\n\n'
        + 'data: {"choices":[{"delta":{"content":""}}],"usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20}}\n\n'
        + 'data: [DONE]\n\n');
    } else {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'mock 收到' } }] }));
    }
  });
});

const MODEL = {
  id: 'verify-image-model', name: '看图验证模型', provider: 'opencode-go',
  model: 'mock-1', apiKey: 'mock', baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
};
const SLOTS = ['agent_model', 'html_model', 'descriptor_model', 'quiz_model', 'graph_model', 'branch_model'];

const results = [];
function ok(name) { results.push([true, name]); console.log('✓ ' + name); }
function bad(name, err) { results.push([false, name]); console.log('❌ ' + name + ' -> ' + ((err && err.message) || err)); }

async function waitHealth(base) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch { /* 未起 */ }
    await wait(500);
  }
  throw new Error('服务 60 秒没起来');
}
async function main() {
  await new Promise(done => upstream.listen(UPSTREAM_PORT, '127.0.0.1', done));
  const workDir = mkdtempSync(join(tmpdir(), 'phymathia-verify-imgchains-'));
  cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
  const server = spawn(PYTHON, ['src/main.py', '-p', String(PORT)], {
    cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  let browser = null;
  let page = null;
  try {
    await waitHealth(BASE);
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String((e && e.message) || e)));
    page.on('dialog', d => d.accept());
    const pdfPageRequests = [];
    page.on('request', req => {
      const u = req.url();
      if (u.includes('/api/input/pdf_pages')) pdfPageRequests.push(u);
    });
    await page.addInitScript((cfg) => {
      try {
        localStorage.setItem('phymathia_user_models', JSON.stringify([cfg.model]));
        const act = {};
        for (const s of cfg.slots) act[s] = cfg.model.id;
        localStorage.setItem('phymathia_active_models', JSON.stringify(act));
        localStorage.setItem('phymathia_onboarding_done', '1');
        localStorage.setItem('phymathia_guide_seen', '1');
      } catch (e) { /* 种子失败会以「模型没配上」报出来 */ }
    }, { model: MODEL, slots: SLOTS });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof runWorkflowNode === 'function', null, { timeout: 20000 });
    await page.waitForTimeout(1000);
    const modelLive = await page.evaluate(() => (typeof getActiveModelForRole === 'function'
      ? (getActiveModelForRole('agent') || {}).model : null));
    if (modelLive !== MODEL.model) throw new Error('模型没配上（槽位读到 ' + modelLive + '）');

    // ① ingest 两张料：一张图、一份 2 页扫描版 PDF
    const played = await page.evaluate(async ({ png, pdf }) => {
      const post = async (body) => {
        const r = await fetch('/api/input/ingest', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        return r.json();
      };
      const img = await post({ fileName: '受力图.png', contentBase64: png });
      const pdfIng = await post({ fileName: '扫描讲义.pdf', contentBase64: pdf });
      return { img, pdfIng };
    }, { png: PNG_B64, pdf: SCANNED_PDF_B64 });
    if (!played.img.ok || !played.pdfIng.ok) throw new Error('ingest 失败：' + JSON.stringify(played).slice(0, 200));
    if (played.pdfIng.pdf.scanned !== true || played.pdfIng.pdf.pages !== 2) {
      throw new Error('扫描版判定不符：' + JSON.stringify(played.pdfIng.pdf));
    }
    ok('① ingest：图片 + 2 页扫描版 PDF（scanned=true pages=2）');
    const pageProbeStatus = await page.evaluate(async (id) => {
      const r = await fetch('/api/input/pdf_pages?fileId=' + id + '&page=1');
      return r.status;
    }, played.pdfIng.fileId);
    if (pageProbeStatus === 422) {
      throw new Error('该解释器缺 pypdfium2（页渲染 422）：用 VERIFY_PYTHON=/abs/path/.venv-linux/bin/python 重跑');
    }
    if (pageProbeStatus !== 200) throw new Error('页转图路由异常：HTTP ' + pageProbeStatus);

    // ② 画布：素材篮（图 out-0／扫描件 out-1）→ 问题 → 分析节点
    const seeded = await page.evaluate(({ fileId, pdfId }) => {
      const now = Date.now();
      const mk = (extra) => Object.assign({
        moduleKey: '', manual: false, label: '', formula: '', source: '', content: '', status: 'done',
        summary: '', analysis: '', analysisHash: '', inputHash: '', generatedAt: 0, requirements: '',
        busy: false, generated: false, maxItems: 0, edges: [], fileId: '', fileName: '',
        generatedNodeIds: [], category: '', formulas: [], x: 0, y: 0, depth: 1,
        targetAngle: 0, isRoot: false, messageIndex: -1, pinned: false, fixedX: null, fixedY: null,
        customWidth: 320, customHeight: null, w: 0, h: 0, vx: 0, vy: 0, timestamp: now,
      }, extra);
      const src = mk({ id: 'src-e2e', kind: 'source', ocrOn: false, timestamp: now + 1, items: [
        { id: 'it-img', kind: 'image', name: '受力图', fileName: '受力图.png', text: '', fileId, createdAt: now },
        { id: 'it-pdf', kind: 'file', name: '扫描讲义', fileName: '扫描讲义.pdf', text: '', fileId: pdfId, scanned: true, pages: 2, createdAt: now },
      ] });
      const q = mk({ id: 'q-e2e', kind: 'user', manual: true, content: '看图讲讲这道受力分析的题', timestamp: now + 2 });
      const a = mk({ id: 'a-e2e', kind: 'answer', timestamp: now + 3 });
      graphView.nodes.push(src, q, a);
      for (const n of [src, q, a]) graphView.nodeById[n.id] = n;
      graphView.edges = [
        { from: 'src-e2e', fromPort: 'out-0', to: 'q-e2e', toPort: 'in-0', type: 'custom', custom: true },
        { from: 'src-e2e', fromPort: 'out-1', to: 'q-e2e', toPort: 'in-1', type: 'custom', custom: true },
        { from: 'q-e2e', fromPort: 'out-0', to: 'a-e2e', toPort: 'in-0', type: 'custom', custom: true },
      ];
      if (typeof _saveCustomNodes === 'function') _saveCustomNodes();
      // 连线也要落 state：renderGraphCanvas 会从持久 state 重建 edges，只放内存会被刷掉
      const st = typeof _graphState === 'function' ? _graphState() : null;
      if (st) { st.connections = graphView.edges; if (typeof _saveGraphState === 'function') _saveGraphState(st); }
      if (typeof renderGraphCanvas === 'function') renderGraphCanvas();
      return { sourceId: src.id, answerId: a.id };
    }, { fileId: played.img.fileId, pdfId: played.pdfIng.fileId });
    ok('② 画布就位：素材篮两口 → 问题 → 分析节点');
    // ③ 问题分析（首问链第一跳）：直接调产品函数，带 3 张图（图 + 扫描件前 2 页）
    const beforeAnalysis = captured.length;
    await page.evaluate(async (id) => {
      await _generateAnalysis(graphView.nodeById[id]);
    }, seeded.answerId);
    await page.waitForTimeout(800);
    const analysisReqs = captured.slice(beforeAnalysis).filter(c => c.images > 0);
    if (!analysisReqs.length) throw new Error('问题分析请求没带图（捕获 ' + (captured.length - beforeAnalysis) + ' 条全是纯文本）');
    const ana = analysisReqs[analysisReqs.length - 1];
    if (ana.images !== 3) throw new Error('问题分析应带 3 张图（1 图＋2 页扫描件），实际 ' + ana.images);
    ok('③ 问题分析：上游收到 3 张图（图＋扫描件前 2 页）');

    // ④ 模块生成：同一份上游，同样带图
    const beforeModule = captured.length;
    const modId = await page.evaluate(async (answerId) => {
      const now = Date.now();
      const m = { id: 'm-e2e', kind: 'module', moduleKey: 'physics', manual: false, label: '', formula: '',
        source: 'ai', content: '', status: 'empty', summary: '', analysis: '', analysisHash: '', inputHash: '',
        generatedAt: 0, requirements: '', busy: false, generated: false, maxItems: 0, edges: [], fileId: '',
        fileName: '', generatedNodeIds: [], category: '', formulas: [], x: 400, y: 0,
        depth: 3, targetAngle: 0, isRoot: false, messageIndex: -1, pinned: false, fixedX: null, fixedY: null,
        customWidth: 320, customHeight: null, w: 0, h: 0, vx: 0, vy: 0, timestamp: now };
      graphView.nodes.push(m);
      graphView.nodeById[m.id] = m;
      graphView.edges.push({ from: answerId, fromPort: 'out-0', to: m.id, toPort: 'in-0', type: 'custom', custom: true });
      if (typeof _saveCustomNodes === 'function') _saveCustomNodes();
      const st = typeof _graphState === 'function' ? _graphState() : null;
      if (st) { st.connections = graphView.edges; if (typeof _saveGraphState === 'function') _saveGraphState(st); }
      await _generateCustomNode(graphView.nodeById[m.id]);
      return m.id;
    }, seeded.answerId);
    await page.waitForTimeout(800);
    const moduleReqs = captured.slice(beforeModule).filter(c => c.images > 0);
    if (!moduleReqs.length) throw new Error('模块生成请求没带图');
    const mod = moduleReqs[moduleReqs.length - 1];
    if (mod.images !== 3) throw new Error('模块生成应带 3 张图，实际 ' + mod.images);
    ok('④ 模块生成：上游收到 3 张图');

    // ⑤ 页转图：扫描件页真的走了 /api/input/pdf_pages
    if (!pdfPageRequests.length) throw new Error('扫描件页没走 /api/input/pdf_pages');
    if (!pdfPageRequests.some(u => /[?&]page=1\b/.test(u) || /page=1$/.test(u))) throw new Error('没有取扫描件第 1 页：' + pdfPageRequests.join(', '));
    ok('⑤ 页转图：前端按 /api/input/pdf_pages 取页（' + pdfPageRequests.length + ' 次，含 page=1）');
    // ⑥ 重试/带字重生成（messages 直传格式）：带图、system 仍纯字符串
    const beforeRegen = captured.length;
    await page.evaluate(async (id) => {
      await _applyWorkflowNodeRegenerate(id, '换个讲法，重点讲受力方向');
    }, modId);
    const regen = captured.slice(beforeRegen).filter(c => c.msgCount >= 2);
    if (!regen.length) throw new Error('带字重生成没有发出 messages 格式请求');
    const regenLast = regen[regen.length - 1];
    if (regenLast.images !== 3) throw new Error('带字重生成应带 3 张图，实际 ' + regenLast.images);
    if (!regenLast.firstIsString) throw new Error('messages 格式附图：system 消息必须仍是纯字符串');
    ok('⑥ 重试/带字重生成：messages 直传格式挂 3 张图，system 消息不动');

    // ⑦ 回归锚：没有上游素材的链（纯文字问题）必须仍是纯字符串消息
    const beforePlain = captured.length;
    await page.evaluate(async () => {
      const now = Date.now();
      const q2 = { id: 'q-plain', kind: 'user', manual: true, moduleKey: '', content: '纯文字提问：什么是简谐运动',
        status: 'done', summary: '', analysis: '', x: 0, y: 400, depth: 1, messageIndex: -1, timestamp: now };
      const a2 = { id: 'a-plain', kind: 'answer', manual: false, moduleKey: '', content: '', status: 'empty',
        summary: '', analysis: '', x: 0, y: 600, depth: 2, messageIndex: -1, timestamp: now + 1 };
      graphView.nodes.push(q2, a2);
      graphView.nodeById[q2.id] = q2;
      graphView.nodeById[a2.id] = a2;
      graphView.edges.push({ from: 'q-plain', fromPort: 'out-0', to: 'a-plain', toPort: 'in-0', type: 'custom', custom: true });
      if (typeof _saveCustomNodes === 'function') _saveCustomNodes();
      const st = typeof _graphState === 'function' ? _graphState() : null;
      if (st) { st.connections = graphView.edges; if (typeof _saveGraphState === 'function') _saveGraphState(st); }
      await _generateAnalysis(graphView.nodeById[a2.id]);
    });
    await page.waitForTimeout(800);
    const plain = captured.slice(beforePlain);
    if (!plain.length) throw new Error('纯文字链没有发出请求，回归锚无从验证');
    if (!plain.every(c => c.images === 0)) throw new Error('纯文字链不该带图');
    if (!plain.every(c => c.lastIsString)) throw new Error('不带图时最后一条 user 消息必须仍是字符串');
    ok('⑦ 回归锚：纯文字链仍是纯字符串消息（' + plain.length + ' 条）');

    if (pageErrors.length) throw new Error('页面异常：' + pageErrors.slice(0, 3).join(' | '));
    console.log('\n发送链附图真机验证：' + results.filter(r => r[0]).length + ' / ' + results.length + ' 段通过');
  } catch (e) {
    bad('验证', e);
    try {
      const dump = await page.evaluate(() => ({
        nodes: (typeof graphView !== 'undefined' ? graphView.nodes : []).map(n => ({
          id: n.id, kind: n.kind, moduleKey: n.moduleKey, status: n.status, busy: !!n.busy,
          len: String(n.content || '').length, analysis: String(n.analysis || '').length,
        })),
        busy: typeof _isSendBusy === 'function' ? _isSendBusy() : null,
        model: typeof getActiveModelForRole === 'function' ? (getActiveModelForRole('agent') || {}).model : null,
      }));
      console.error('--- 画布状态 ---\n' + JSON.stringify(dump, null, 1).slice(0, 1800));
    } catch (inner) { /* 页面已关 */ }
    console.error('--- 捕获到的请求 ---\n' + JSON.stringify(captured.map(c => ({
      msgCount: c.msgCount, images: c.images, lastIsString: c.lastIsString,
    })), null, 1).slice(0, 1600));
    console.error('--- 服务日志尾 ---\n' + log.split('\n').slice(-20).join('\n'));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { server.kill('SIGTERM'); } catch { /* ignore */ }
    await wait(500);
    try { server.kill('SIGKILL'); } catch { /* ignore */ }
    upstream.close();
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

main().catch(e => { console.error('运行失败：' + ((e && e.message) || e)); process.exit(1); });
