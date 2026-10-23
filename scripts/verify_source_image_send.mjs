#!/usr/bin/env node
// 取材附图通道真机验证（2026-10-23，AGENTS.md 硬规则 6 精神：发送链改动必须真发）。
//
// 链路：素材 ingest 落盘 → GET /api/input/files 取字节 → POST /api/models/chat
// 带 images（新格式）→ 服务端拼成 image_url 部件 → 捕获型假上游收到多模态消息。
// 同时回归「不带图时最后一条 user 消息必须仍是纯字符串」。
//
// 用法：node scripts/verify_source_image_send.mjs
// 自带临时数据目录（复制 src/harness 起服），不碰真实 data/；上游是本脚本内嵌的
// 捕获型假上游（OpenAI 兼容，记录最近一次请求体供断言）。
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 5081;
const UPSTREAM_PORT = 5066;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = ms => new Promise(r => setTimeout(r, ms));

// 1x1 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// 2 页无文字层 PDF（＝扫描版的形状，pypdf 抽不出字）：pypdf 现造，钉成静态串
const SCANNED_PDF_B64 = 'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgKHB5cGRmKQo+PgplbmRvYmoKMiAwIG9iago8PAovVHlwZSAvUGFnZXMKL0NvdW50IDIKL0tpZHMgWyA0IDAgUiA1IDAgUiBdCj4+CmVuZG9iagozIDAgb2JqCjw8Ci9UeXBlIC9DYXRhbG9nCi9QYWdlcyAyIDAgUgo+PgplbmRvYmoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUmVzb3VyY2VzIDw8Cj4+Ci9NZWRpYUJveCBbIDAuMCAwLjAgMjAwIDI2MCBdCi9QYXJlbnQgMiAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1Jlc291cmNlcyA8PAo+PgovTWVkaWFCb3ggWyAwLjAgMC4wIDIwMCAyNjAgXQovUGFyZW50IDIgMCBSCj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1NCAwMDAwMCBuIAowMDAwMDAwMTE5IDAwMDAwIG4gCjAwMDAwMDAxNjggMDAwMDAgbiAKMDAwMDAwMDI2MiAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKPj4Kc3RhcnR4cmVmCjM1NgolJUVPRgo=';

// 起服务的解释器：默认 python3（与 AGENTS 启动口径一致）；页渲染要 pypdfium2，
// 本机系统 python 没装而项目 venv 装了时，用 VERIFY_PYTHON=.venv-linux/bin/python 跑全段
const PYTHON = process.env.VERIFY_PYTHON || 'python3';

// ===== 捕获型假上游：记录最近一次 /chat/completions 请求体 =====
let lastBody = null;
const upstream = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__last') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ body: lastBody }));
    return;
  }
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', () => {
    try { lastBody = JSON.parse(raw); } catch { lastBody = null; }
    const stream = !!(lastBody && lastBody.stream);
    res.writeHead(200, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' });
    if (stream) {
      res.end('data: {"choices":[{"delta":{"content":"mock 收到"}}]}\n\ndata: [DONE]\n\n');
    } else {
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'mock 收到' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    }
  });
});

async function waitHealth(base) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return;
    } catch { /* 未起 */ }
    await wait(500);
  }
  throw new Error('服务 180 秒没起来');
}

async function chat(payload) {
  const r = await fetch(BASE + '/api/models/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error('chat HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}

function lastUser(body) {
  const msgs = (body && Array.isArray(body.messages)) ? body.messages : [];
  return msgs[msgs.length - 1] || {};
}

async function main() {
  await new Promise(done => upstream.listen(UPSTREAM_PORT, '127.0.0.1', done));
  const workDir = mkdtempSync(join(tmpdir(), 'phymathia-verify-imgsend-'));
  cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
  const server = spawn(PYTHON, ['src/main.py', '-p', String(PORT)], {
    cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  try {
    await waitHealth(BASE);

    // ① ingest 落图 → ② 文件路由取回字节
    const ing = await (await fetch(BASE + '/api/input/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 't.png', contentBase64: PNG_B64 }),
    })).json();
    if (!ing.ok || !ing.fileId) throw new Error('ingest 失败：' + JSON.stringify(ing).slice(0, 200));
    console.log('① ingest 落盘 ok，fileId=' + ing.fileId + '（1x1 无字，ocr.status=' + ing.ocr.status + ' 属预期）');
    const fr = await fetch(BASE + '/api/input/files/' + ing.fileId);
    if (!fr.ok) throw new Error('文件路由 HTTP ' + fr.status);
    const bytes = Buffer.from(await fr.arrayBuffer()).toString('base64');
    if (bytes !== PNG_B64) throw new Error('文件路由取回字节与上传不一致');
    if (!String(fr.headers.get('content-type') || '').includes('image/png')) throw new Error('文件路由 mime 不是 image/png');
    console.log('② 文件路由取回字节＋mime ok');

    const dataUrl = 'data:image/png;base64,' + bytes;
    const base = {
      prompt: '看图说说这张图',
      provider: 'opencode-go',
      api_key: 'mock',
      model: 'mock-1',
      base_url: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      session_id: '',
      stream: false,
      workflow_context: { target: { module: 'physics', kind: 'module' } },
    };

    // ③ 带图：上游最后一条 user 消息必须是 [文字, image_url] 多部件
    lastBody = null;
    await chat({ ...base, images: [dataUrl] });
    const u1 = lastUser(lastBody);
    if (!Array.isArray(u1.content)) throw new Error('带图时上游最后一条 user 消息应为多部件数组，实际：' + typeof u1.content);
    if (u1.content[0].type !== 'text' || !String(u1.content[0].text).includes('看图')) {
      throw new Error('文字部件应在首位且含提示词');
    }
    const imgParts = u1.content.filter(p => p.type === 'image_url');
    if (imgParts.length !== 1 || imgParts[0].image_url.url !== dataUrl) {
      throw new Error('image_url 部件应为 1 个且原样透传');
    }
    console.log('③ 带图请求：上游收到 [文字, image_url×1] 多模态消息 ok');

    // ④ 不带图：最后一条 user 消息必须仍是纯字符串（回归锚）
    lastBody = null;
    await chat({ ...base });
    const u2 = lastUser(lastBody);
    if (typeof u2.content !== 'string') throw new Error('不带图时 content 应保持字符串（回归锚破了）');
    console.log('④ 不带图请求：上游收到纯字符串消息 ok');

    // ⑤ 重试链（messages 直传格式，T381）：图挂到最后一条 user 消息，更早的消息不动
    lastBody = null;
    await chat({
      provider: base.provider, api_key: base.api_key, model: base.model, base_url: base.base_url,
      stream: false, images: [dataUrl],
      messages: [{ role: 'system', content: '系统提示' }, { role: 'user', content: '上一轮' },
                 { role: 'user', content: '按这张图重讲一遍' }],
    });
    const mMsgs = (lastBody && lastBody.messages) || [];
    const last = mMsgs[mMsgs.length - 1] || {};
    if (!Array.isArray(last.content)) throw new Error('messages 格式带图：最后一条 user 应转多部件');
    if (last.content[0].type !== 'text' || last.content[0].text !== '按这张图重讲一遍') {
      throw new Error('messages 格式附图：文字部件应在首位且原样');
    }
    if (last.content.filter(p => p.type === 'image_url').length !== 1) throw new Error('messages 格式附图：应有 1 个 image_url');
    if (typeof mMsgs[0].content !== 'string' || typeof mMsgs[1].content !== 'string') {
      throw new Error('messages 格式附图：system/更早的 user 必须一字不动');
    }
    lastBody = null;
    await chat({
      provider: base.provider, api_key: base.api_key, model: base.model, base_url: base.base_url,
      stream: false, messages: [{ role: 'user', content: '纯文字重试' }],
    });
    if (typeof lastBody.messages[0].content !== 'string') throw new Error('messages 格式无图：必须仍是纯字符串（回归锚）');
    console.log('⑤ 重试链（messages 直传）：带图挂最后一条 user、无图纯字符串 ok');

    // ⑥ 扫描版 PDF（T382）：ingest 打标 → 页转图端点现渲染 JPEG
    const pdfIng = await (await fetch(BASE + '/api/input/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: '扫描讲义.pdf', contentBase64: SCANNED_PDF_B64 }),
    })).json();
    if (!pdfIng.ok || !pdfIng.pdf) throw new Error('PDF ingest 失败：' + JSON.stringify(pdfIng).slice(0, 200));
    if (pdfIng.pdf.scanned !== true || pdfIng.pdf.pages !== 2) {
      throw new Error('扫描版判定不符：' + JSON.stringify(pdfIng.pdf));
    }
    if (String(pdfIng.text || '').trim()) throw new Error('扫描版应抽不出字（text 留空）');
    console.log('⑥ ing ok：scanned=' + pdfIng.pdf.scanned + ' pages=' + pdfIng.pdf.pages + ' text 为空');
    const pageResp = await fetch(BASE + '/api/input/pdf_pages?fileId=' + pdfIng.fileId + '&page=1');
    if (pageResp.status === 422) {
      console.warn('⚠ 页渲染不可用（该解释器缺 pypdfium2；用 VERIFY_PYTHON=.venv-linux/bin/python 可跑全段）——本段跳过');
    } else {
      if (pageResp.status !== 200) throw new Error('页转图 HTTP ' + pageResp.status);
      const jpg = Buffer.from(await pageResp.arrayBuffer());
      if (jpg[0] !== 0xff || jpg[1] !== 0xd8) throw new Error('页转图返回的不是 JPEG');
      if (jpg.length < 500) throw new Error('页转图太小，疑似空壳：' + jpg.length);
      if (!String(pageResp.headers.get('content-type') || '').includes('image/jpeg')) throw new Error('页转图 mime 不对');
      const over = await fetch(BASE + '/api/input/pdf_pages?fileId=' + pdfIng.fileId + '&page=99');
      if (over.status !== 400) throw new Error('超上限页号应 400，实际 ' + over.status);
      const nonPdf = await fetch(BASE + '/api/input/pdf_pages?fileId=' + ing.fileId + '&page=1');
      if (nonPdf.status !== 400) throw new Error('非 PDF 应 400，实际 ' + nonPdf.status);
      console.log('⑥ 页转图 ok：JPEG ' + jpg.length + ' 字节；越界/非 PDF 均 400');
    }

    console.log('\n发图链真机验证全部通过（6 段）');
  } catch (e) {
    console.error('❌ ' + (e && e.message || e));
    console.error('--- 服务日志尾 ---\n' + log.slice(-1500));
    process.exitCode = 1;
  } finally {
    server.kill();
    upstream.close();
    await wait(200);
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

main();
