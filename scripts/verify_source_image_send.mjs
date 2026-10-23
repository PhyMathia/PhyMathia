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
  const server = spawn('python3', ['src/main.py', '-p', String(PORT)], {
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

    console.log('\n发图链真机验证全部通过（5 断言）');
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
