// T378 配套：把前端上报的「app.js:行:列」解回「源文件:行:列」。
// 服务端日志里 [client-js] 条目的 src/line/col 是压缩产物坐标；用构建产出的
// app.js.map（含 sourcesContent 与逐文件 banner）离线解码，不用起服务。
// 用法：node scripts/decode_client_error.mjs "app.js:143:56789"
// 冒烟 load-order 域复用 decodePosition() 做往返自检（产物里找字面量→解码回源）。
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const _b64 = new Map([...B64].map((c, i) => [c, i]));

function _decodeVlqSeg(str) {
  const out = [];
  let shift = 0, value = 0;
  for (const ch of str) {
    const d = _b64.get(ch);
    if (d == null) throw new Error('非法 base64 字符: ' + ch);
    value += (d & 31) << shift;
    if (d & 32) {
      shift += 5;
    } else {
      const neg = value & 1;
      value >>= 1;
      out.push(neg ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

// 在 map 里找「生成位置 ≤ (gLine,gCol)」的最近带源码段，返回源文件/源行/源列。
// gLine/gCol 为 1 基（window.onerror 的 lineno/colno 口径），内部转 0 基。
export function decodePosition(map, gLine1, gCol1) {
  const gLine = Math.max(0, (gLine1 || 1) - 1);
  const gCol = Math.max(0, (gCol1 || 1) - 1);
  let srcIdx = 0, srcLine = 0, srcCol = 0;
  let best = null;
  const lines = map.mappings.split(';');
  for (let gl = 0; gl < lines.length; gl++) {
    let gc = 0;
    const segs = lines[gl] ? lines[gl].split(',') : [];
    for (const seg of segs) {
      if (!seg) continue;
      const f = _decodeVlqSeg(seg);
      gc += f[0];
      if (f.length >= 4) {
        srcIdx += f[1];
        srcLine += f[2];
        srcCol += f[3];
        if (gl < gLine || (gl === gLine && gc <= gCol)) best = { srcIdx, srcLine, srcCol };
      }
    }
    if (gl > gLine + 1) break;  // 目标行之后不再有更近的段
  }
  if (!best) return null;
  const content = (map.sourcesContent && map.sourcesContent[best.srcIdx]) || '';
  const contentLines = content.split('\n');
  if (best.srcLine >= contentLines.length) return null;
  // 沿拼接源向上找最近的文件 banner，归出所属源文件与文件内行号（转 1 基）
  let file = '(未知)', fileLine = best.srcLine;
  for (let i = best.srcLine; i >= 0; i--) {
    const m = contentLines[i].match(/^\/\* ===== source: (.+) ===== \*\/$/);
    if (m) {
      file = m[1];
      fileLine = best.srcLine - i;  // banner 行自身占一行，紧随其后的行即文件第 1 行
      break;
    }
  }
  return { file, line: fileLine + 1, col: best.srcCol + 1, text: contentLines[best.srcLine].trim().slice(0, 160) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2] || '';
  const m = arg.match(/app\.js:(\d+)(?::(\d+))?/);
  if (!m) {
    console.error('用法: node scripts/decode_client_error.mjs "app.js:行:列"');
    console.error('（行:列来自服务端日志 [client-js] 条目的 src/line/col 字段）');
    process.exit(1);
  }
  const map = JSON.parse(await readFile(resolve(root, 'src/static/js/app.js.map'), 'utf8'));
  const r = decodePosition(map, parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 1);
  if (!r) {
    console.error('未找到 ≤ 该位置的映射段（可能落在拼接分隔符上，试试列号 ±1）');
    process.exit(1);
  }
  console.log(`产物 ${arg}`);
  console.log(`→ 源文件 src/static/js/${r.file}:${r.line}:${r.col}`);
  console.log('  ' + r.text);
}
