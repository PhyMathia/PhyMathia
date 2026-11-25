// 性能门禁入口（npm run perf:gate，2026-11-25）。核心全在 scripts/lib/perf_gate.mjs
// （场景、测量、门限表），本文件只是薄壳：跑一轮、按结果定 exit code——
// 失败 exit 1，绿 exit 0（同 frontend_smoke.mjs 薄壳口径）。
// 口径：不并入 verify（要浏览器、近一分钟），改画布 CSS/JS 时按 AGENTS 硬规则 4
// 「性能档」手动跑一次。
import { runPerfGate } from './lib/perf_gate.mjs';

try {
  const { ok } = await runPerfGate({ port: 5091 });
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  console.error('perf:gate 运行失败：' + (err && err.message || err));
  process.exitCode = 1;
}
