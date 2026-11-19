// 无头浏览器定位：统一走 node_modules 里 playwright 的浏览器缓存（~/.cache/ms-playwright）。
// 2026-11-19 起不再用 .tools/pw-browsers——那是 08-29 搬家留下的私有副本，拷到 NTFS 上
// 符号链接已损坏（libasound.so.2 变成 0 字节），且与 playwright 缓存重复约 655M。
// 临时换浏览器：PHYMATHIA_CHROME=/path/to/chrome（系统 Chrome/Edge 均可）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

export function resolveChromiumExecutable() {
  const override = process.env.PHYMATHIA_CHROME;
  if (override) return override;

  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    // 优先无头壳：更轻，且历史基线截图就是它拍的（换完整 chromium 会有像素级差异）
    for (const d of fs.readdirSync(cache)) {
      if (!d.startsWith('chromium_headless_shell-')) continue;
      for (const sub of fs.readdirSync(path.join(cache, d))) {
        for (const name of ['chrome-headless-shell', 'chrome-headless-shell.exe']) {
          const p = path.join(cache, d, sub, name);
          if (fs.existsSync(p)) return p;
        }
      }
    }
  } catch { /* 缓存目录不存在时交给 playwright 报安装提示 */ }

  return chromium.executablePath();
}
