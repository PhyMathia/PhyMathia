// 本机环境退化兜底（2026-11-08 实踩）：Node 22 的 global fetch（undici）在
// lazyllhttp WASM 初始化时抛 RangeError: Out of memory，连一个连不上的地址都
// 发不出去；scripts/lib/test_server.mjs 内部探 /health 用的正是 fetch，直接
// import 会整个脚本崩掉。更隐蔽的是：即便覆盖 globalThis.fetch 为 Node 内置
// http 版，Node 进程仍会在运行期加载 undici 并 OOM（实测 diag 两次探活后崩）。
//
// 应对：把 globalThis.fetch 换成一个基于 curl 子进程的**异步**实现——主进程完全
// 不碰 Node 的 fetch / http 客户端，也就不加载 undici。
//
// 补充（同日实测）：本机 node:http 的 createServer+listen 同样会拉起 undici
// WASM 并 OOM，最简脚本即崩，与 fetch 覆盖、NODE_OPTIONS、Node 版本都无关。
// 因此金样集的 mock 上游改由 Python stdlib 承载（mock.py），隔离实例本来就是
// Python；本文件只负责主进程「发请求」这一侧。
//
// 为什么必须异步 spawn 而非 spawnSync（同日实踩）：spawnSync 会阻塞 Node 事件
// 循环，期间隔离实例与 mock 的 stdout 管道无人排空，服务端日志攒满 64KB 管道
// 缓冲区后 Python 进程会卡在写日志上，表现为「第 30 条请求 90s 超时」。
//
// 只实现本项目用到的能力：method / headers / body(string) / 响应的 ok、status、
// json()、text()。curl 的 --max-time 等效兜住 AbortSignal；init.timeoutSec
// 可单独放宽单次请求上限（长评审计调用要盖住后端 60s 客户端 / 90s 上游与
// 重试退避，否则会被误报成「发送失败」）。

import { spawn } from 'node:child_process';

const MARK = '\n__GG_HTTP_STATUS__';

export function installHttpFetch() {
  if (globalThis.__graphGoldHttpFetchInstalled) return;
  globalThis.__graphGoldHttpFetchInstalled = true;

  globalThis.fetch = function curlFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : String((input && input.url) || input);
    const method = String(init.method || 'GET').toUpperCase();
    const MAX_TIME = Number(init.timeoutSec || 15);
    const args = ['-sS', '-X', method, '--connect-timeout', '3', '--max-time', String(MAX_TIME),
      '-w', MARK + '%{http_code}'];
    for (const [k, v] of Object.entries(init.headers || {})) args.push('-H', `${k}: ${v}`);
    if (init.body != null) args.push('--data-binary', '@-');
    args.push(url);
    if (process.env.GOLD_DEBUG_FETCH) console.error('[curlFetch] ->', method, url);

    return new Promise((resolve, reject) => {
      const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const guard = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 已退 */ }
        reject(new Error('curl 超时守护触发（' + (MAX_TIME + 10) + 's）'));
      }, (MAX_TIME + 10) * 1000);
      child.on('error', (e) => {
        clearTimeout(guard);
        reject(new Error('curl 启动失败：' + e.message));
      });
      child.on('close', (code) => {
        clearTimeout(guard);
        if (code !== 0) {
          return reject(new Error('curl 失败：' + (err.trim() || ('exit ' + code))));
        }
        const at = out.lastIndexOf(MARK);
        const raw = at >= 0 ? out.slice(0, at) : out;
        const status = at >= 0 ? Number(out.slice(at + MARK.length).trim()) : 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: {},
          text: () => Promise.resolve(raw),
          json: () => {
            try { return Promise.resolve(JSON.parse(raw)); }
            catch (e) { return Promise.reject(new Error('响应不是 JSON：' + raw.slice(0, 200))); }
          },
        });
      });
      if (init.body != null) child.stdin.end(String(init.body));
      else child.stdin.end();
    });
  };
}
