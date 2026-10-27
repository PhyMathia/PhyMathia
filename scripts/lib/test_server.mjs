// 测试专用隔离实例（T415，2026-10-27）。
//
// 为什么必须隔离：应用前端加载时会做「模型配置双向同步」——localStorage 里有模型
// 就整包推上服务端账号真源 data/users/<账号>/models.json。任何「开真浏览器页面的
// 测试」只要打在真机上，本地种过的（或未来哪天误种的）模型就会覆盖日常账号配置
// （2026-10-26 实踩：default 账号 8 台设备的模型名单被 mock 整包顶掉，见
// docs/日志/2026-10-26.md）。所以凡开页面的脚本一律自带第二实例，绝不默认连 5050。
//
// 做法：把 src/＋harness/ 拷进系统临时目录、在那里起 python3 src/main.py——
// config.py 的 DATA_DIR 按代码副本位置解析，data/ 自然落在临时区，真实 data/ 零写入。
// 与 review_tasks_e2e.mjs / verify_stream_interrupt_persist.mjs 等早已在用的内联写法
// 同一套，收敛到这里免得五份拷贝各自漂移。
//
// 用法：
//   import { startIsolatedServer } from './lib/test_server.mjs';
//   const srv = await startIsolatedServer({ port: 5086, label: 'phymathia-xxx' });
//   process.on('exit', () => srv.stop());   // 兜底（process.exit 也会触发 exit 钩子）
//   ... 用 srv.base 发请求/导航 ...
//   srv.stop();                             // SIGKILL＋删临时目录（幂等）
//
// 端口先探后占：目标口已有服务应答 /health（多半是你自己的真机实例）就直接报错
// 拒跑——测试打到已有实例上等于白隔离。自选端口避开 5050/5051/5060/5061（undici
// 坏端口）与其他脚本已占用的常量口（5073/5077–5079/5081/5082/5084/5085/5098/5099）。
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startIsolatedServer({ port, label = 'phymathia-test', copyDataDirs = [] }) {
  if (!port) throw new Error('startIsolatedServer：必须显式给 port');
  const base = `http://127.0.0.1:${port}`;
  let occupied = false;
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
    occupied = r.ok;
  } catch { /* 连不上＝空口，可用 */ }
  if (occupied) {
    throw new Error('端口 ' + port + ' 已有服务在跑（可能是你自己的实例）——给本脚本换个端口，别让测试打到已有实例上');
  }

  const workDir = mkdtempSync(join(tmpdir(), label + '-'));
  cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
  // 需要真实数据文件陪跑的场景（如 css_coverage 的 viewer pmu）按目录挑着拷，
  // 只进临时副本、仍然不写真实 data/
  for (const d of copyDataDirs) {
    const from = join(ROOT, 'data', d);
    if (existsSync(from)) cpSync(from, join(workDir, 'data', d), { recursive: true });
  }

  const proc = spawn('python3', ['src/main.py', '-p', String(port)], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { proc.kill('SIGKILL'); } catch { /* 已退 */ }
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* 下次系统清 */ }
  };

  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(900) })).ok) up = true; } catch { /* 等启动 */ }
    if (!up) await wait(500);
  }
  if (!up) {
    stop();
    throw new Error('隔离实例 60s 未就绪。服务端日志尾：\n' + log.slice(-1500));
  }
  return { base, port, workDir, proc, stop, logTail: (n = 1500) => log.slice(-n) };
}
