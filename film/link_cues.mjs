#!/usr/bin/env node
/**
 * link_cues.mjs — 给 05-时间线.json 的每条 audio_cue 注入 shot_id / movement_id
 *
 * 为什么需要：`03-音乐音效设计.md` 以**分镜号 S##** 为主键（镜的身份由入出点定义，
 * 比 cue 编号稳定），而 `05-时间线.json` 的 audio_cues 用 A## 编号且原本不带镜头关联。
 * 两套编号无法 join，写合成代码的人得手工对表。本脚本补上连接键。
 *
 * 用法：node link_cues.mjs          （原地更新 05-时间线.json，幂等）
 *      node link_cues.mjs --check  （只报告，不写入）
 *
 * 注意：build_timeline.mjs 重新生成 JSON 后，本脚本需要重跑一次。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('./05-时间线.json', import.meta.url);
const checkOnly = process.argv.includes('--check');

const film = JSON.parse(readFileSync(FILE, 'utf8'));

// 展平镜头表，附带所属乐章
const shots = [];
for (const mv of film.movements) {
  for (const s of mv.shots) shots.push({ ...s, movement_id: mv.id, movement_name: mv.name_zh });
}
shots.sort((a, b) => a.start_frame - b.start_frame);

// 首尾相接不变量：本脚本依赖它才能做「按起始帧归属」
for (let i = 1; i < shots.length; i++) {
  if (shots[i].start_frame !== shots[i - 1].end_frame) {
    throw new Error(`镜头不相接：${shots[i - 1].id} 止于 ${shots[i - 1].end_frame}，` +
                    `${shots[i].id} 起于 ${shots[i].start_frame}`);
  }
}

/** 按起始帧归属：cue 起点落在哪个镜头的 [start, end) 区间内 */
function shotAt(frame) {
  let lo = 0, hi = shots.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frame < shots[mid].start_frame) hi = mid - 1;
    else if (frame >= shots[mid].end_frame) lo = mid + 1;
    else return shots[mid];
  }
  return null; // 落在片尾之外
}

let linked = 0, orphan = [], spanning = 0;
for (const cue of film.audio_cues) {
  const s = shotAt(cue.start_frame);
  if (!s) { orphan.push(cue.id); delete cue.shot_id; delete cue.movement_id; continue; }
  cue.shot_id = s.id;
  cue.movement_id = s.movement_id;
  linked++;
  // 跨镜 cue 是合法的（音乐本来就会跨镜），但值得计数以便人工复核
  if (cue.end_frame > s.end_frame) spanning++;
}

console.log(`audio_cues ${film.audio_cues.length} 条：已关联 ${linked}，无法归属 ${orphan.length}，跨镜 ${spanning}`);
if (orphan.length) console.log('  未归属：', orphan.join(', '));

// 反向核对：有没有镜头一条 cue 都没有
const covered = new Set(film.audio_cues.map(c => c.shot_id).filter(Boolean));
const uncovered = shots.filter(s => !covered.has(s.id)).map(s => s.id);
console.log(uncovered.length ? `  ⚠ 无 cue 的镜头：${uncovered.join(', ')}` : '  ✓ 每个镜头都有 cue 覆盖');

if (checkOnly) { console.log('(--check：未写入)'); process.exit(0); }

film.audio_cues_link_note =
  'shot_id / movement_id 由 link_cues.mjs 注入，用于与 03-音乐音效设计.md 的 S## 主键 join；' +
  'build_timeline.mjs 重新生成后需重跑该脚本。';
writeFileSync(FILE, JSON.stringify(film, null, 2) + '\n');
console.log('✓ 已写入 05-时间线.json');
