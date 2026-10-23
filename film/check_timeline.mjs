// check_timeline.mjs — 独立校验 05-时间线.json（v3）：语法、帧秒自洽、首尾相接、覆盖完整性、跨文件时间码
import { readFileSync } from 'node:fs';

const P = new URL('./05-时间线.json', import.meta.url);
const raw = readFileSync(P, 'utf8');
let pass = 0, fail = 0;
const bad = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; bad.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

// ── 自检 1：JSON.parse ─────────────────────────────────────────────────────
console.log('\n[自检 1] JSON 语法');
let d;
try { d = JSON.parse(raw); ok('JSON.parse 成功', true, `${raw.length} 字符`); }
catch (e) { ok('JSON.parse 成功', false, e.message); process.exit(1); }

// ── 自检 2：镜头首尾相接无空隙无重叠（覆盖 0–6600）─────────────────────────
console.log('\n[自检 2] 镜头首尾相接不变量');
const shots = d.movements.flatMap((m) => m.shots);
const TOTAL = 6600, BODY = 6480;
ok('镜头总数 = 55（54 正片 + 1 尾板）', shots.length === 55, `实测 ${shots.length}`);
ok('正片镜数 = 54', shots.filter((s) => s.kind === 'body').length === 54, `实测 ${shots.filter((s) => s.kind === 'body').length}`);
ok('尾板镜数 = 1', shots.filter((s) => s.kind === 'tail_slate').length === 1);
ok('首镜 start_frame = 0', shots[0].start_frame === 0, `实测 ${shots[0].start_frame}`);
const last = shots[shots.length - 1];
ok('末镜 end_frame = 6600', last.end_frame === TOTAL, `实测 ${last.end_frame}`);
let gap = 0, overlap = 0, mismatch = 0;
for (let i = 0; i < shots.length; i++) {
  if (i > 0) {
    const prev = shots[i - 1];
    if (shots[i].start_frame > prev.end_frame) { gap++; bad.push(`${prev.id}→${shots[i].id} 空隙`); }
    if (shots[i].start_frame < prev.end_frame) { overlap++; bad.push(`${prev.id}→${shots[i].id} 重叠`); }
  }
  const s = shots[i];
  if (s.duration_frames !== s.end_frame - s.start_frame) mismatch++;
  if (Math.round(s.start_sec * 24) !== s.start_frame) mismatch++;
  if (Math.round(s.end_sec * 24) !== s.end_frame) mismatch++;
  if (Math.round(s.duration_sec * 24) !== s.duration_frames) mismatch++;
}
ok('相邻镜无空隙', gap === 0, `空隙 ${gap} 处`);
ok('相邻镜无重叠', overlap === 0, `重叠 ${overlap} 处`);
ok('逐镜 frame = round(sec × 24) 且 duration 自洽', mismatch === 0, `不自洽字段 ${mismatch} 个`);
const covered = shots.reduce((a, s) => a + s.duration_frames, 0);
ok('镜头帧数合计 = 6600', covered === TOTAL, `实测 ${covered}`);
ok('连续覆盖 0–6600 无断点', shots.every((s, i) => (i === 0 ? s.start_frame === 0 : s.start_frame === shots[i - 1].end_frame)), '');
ok('正片与尾板边界在 6480', shots.filter((s) => s.kind === 'body').every((s) => s.end_frame <= BODY) && shots.find((s) => s.kind === 'tail_slate').start_frame === BODY, `尾板 ${shots.find((s) => s.kind === 'tail_slate').id} 起点 ${shots.find((s) => s.kind === 'tail_slate').start_frame}`);

// ── 附加不变量 ─────────────────────────────────────────────────────────────
console.log('\n[附加] 结构 / 乐章 / 声音 / 卡片 / 数学');
ok('顶层字段齐全', ['film', 'motifs', 'math_constraints', 'movements', 'title_cards', 'audio_cues', 'render_priority', 'assets'].every((k) => k in d));
ok('film 时长账（275 / 270 + 5）', d.film.duration_sec === 275 && d.film.body_duration_sec === 270 && d.film.tail_slate_sec === 5 && d.film.total_frames === 6600 && d.film.body_frames === 6480 && d.film.tail_slate_frames === 120);
ok('片名 = 泛音 / Overtones', d.film.title_zh === '泛音' && d.film.title_en === 'Overtones', `${d.film.title_zh} / ${d.film.title_en}`);
ok('分辨率 3840×1608 且高为偶数', d.film.resolution.width === 3840 && d.film.resolution.height === 1608 && d.film.resolution.height % 2 === 0);
ok('宽高比标 2.388:1（非 2.39:1）', d.film.resolution.aspect === '2.388:1', `实测 ${d.film.resolution.aspect}`);
ok('fps = 24', d.film.fps === 24);
ok('音频规格（48000 / 24bit / 5.1）', d.film.audio.sample_rate === 48000 && d.film.audio.bit_depth === 24 && d.film.audio.channels === '5.1' && d.film.audio.target_lufs === -18 && d.film.audio.true_peak_dbtp === -1.0);
ok('48000 / 24 整除（2000 样本/帧）', d.film.audio.sample_rate % d.film.fps === 0 && d.film.audio.sample_rate / d.film.fps === 2000);
ok('主音 A2 = 110Hz，八泛音逐一正确', d.motifs.fundamental.freq_hz === 110 && JSON.stringify(d.motifs.fundamental.partials_hz) === JSON.stringify([110,220,330,440,550,660,770,880]), d.motifs.fundamental.partials_hz.join('/'));
ok('motifs 两方向（加法 / 减法）', d.motifs.build.direction === 'additive' && d.motifs.reduce.direction === 'subtractive');
ok('math_constraints 数学红线', /sin\(nπx\/L\)/.test(d.math_constraints.string_model) && /110/.test(d.math_constraints.partials) && JSON.stringify(d.math_constraints.forbidden) === JSON.stringify(['3x3','volume','dimension_lifting','equal_temperament_routes']) && /max\|f − S_N\|/.test(d.math_constraints.invertibility));
ok('声音与画面同源写进约束', /FFT/.test(d.math_constraints.audio_image_identity) && /1\/220/.test(d.math_constraints.time_scale));
ok('乐章含尾板且首尾相接覆盖 0–275', d.movements.length === 6 && d.movements[0].start_sec === 0 && d.movements[5].end_sec === 275 && d.movements.every((m, i) => i === 0 || m.start_sec === d.movements[i - 1].end_sec));
ok('乐章镜头数与分镜表分节一致', JSON.stringify(d.movements.map((m) => m.shots.length)) === JSON.stringify([15, 9, 10, 12, 8, 1]), d.movements.map((m) => `${m.id}:${m.shots.length}`).join(' '));
ok('乐章名（一个音/删/还原/大陆/回望/尾板）', JSON.stringify(d.movements.map((m) => m.name_zh)) === JSON.stringify(['一个音','删','还原','大陆','回望','尾板']));
ok('每镜必备字段齐全', shots.every((s) => ['id', 'start_sec', 'end_sec', 'duration_sec', 'start_frame', 'end_frame', 'duration_frames', 'description_zh', 'camera', 'technique', 'audio', 'transition_in', 'transition_out'].every((k) => k in s)));
ok('camera 字段与取值合法', shots.every((s) => ['static', 'dolly_in', 'dolly_out', 'crane_up', 'crane_down', 'track', 'orbit', 'penetrate', 'whip'].includes(s.camera.move) && 'lens_mm' in s.camera && 'height' in s.camera && 'notes' in s.camera));
ok('transition 取值合法', shots.every((s) => ['cut', 'fade_from_black', 'dissolve'].includes(s.transition_in)));
ok('technique 为字符串数组且非空', shots.every((s) => Array.isArray(s.technique) && s.technique.length > 0 && s.technique.every((t) => typeof t === 'string')));
ok('audio 字段非空', shots.every((s) => typeof s.audio === 'string' && s.audio.length > 0));

// v3 专属
const m4 = d.movements.find((m) => m.id === 'IV');
const m4ids = m4.shots.map((s) => s.id);
const cardsInM4 = d.title_cards.filter((c) => c.is_title_card && m4ids.includes(c.shot_id));
ok('第四乐章无字幕卡（画面独立叙事）', cardsInM4.length === 0, cardsInM4.length ? cardsInM4.map((c) => c.id).join(',') : '0 张');
ok('第四乐章含金边自亮/Φ 出现/分支停住三个画内事件', m4ids.includes('S42') && m4ids.includes('S44') && m4ids.includes('S45'));
ok('镜 52 末 8 秒为独立静默 cue', d.audio_cues.some((c) => c.type === 'silence' && c.start_sec === 255 && c.end_sec === 263 && c.duration_sec === 8), '');
ok('镜 11 为 static（空槽无运镜）', shots.find((s) => s.id === 'S11').camera.move === 'static', '');
ok('镜 50 为 static（基频拿走时机器不动）', shots.find((s) => s.id === 'S50').camera.move === 'static', '');
ok('穿透仅两次（S34 / S51）', shots.filter((s) => s.camera.move === 'penetrate').map((s) => s.id).join() === 'S34,S51', shots.filter((s) => s.camera.move === 'penetrate').map((s) => s.id).join());
ok('广角首次出现在 S35（第四乐章）', shots.findIndex((s) => s.camera.lens_code === 'W') === 34, `首个 W 在 ${shots[shots.findIndex((s) => s.camera.lens_code === 'W')].id}`);

const cues = d.audio_cues;
ok('audio_cues 从 0 秒起', cues[0].start_sec === 0, `实测 ${cues[0].start_sec}`);
ok('audio_cues 到 275 秒止', cues[cues.length - 1].end_sec === 275, `实测 ${cues[cues.length - 1].end_sec}`);
const cueGap = cues.filter((c, i) => i > 0 && c.start_sec !== cues[i - 1].end_sec);
ok('audio_cues 首尾相接不留空档', cueGap.length === 0, `断点 ${cueGap.length} 处`);
ok('cue 时长自洽', cues.every((c) => Math.abs((c.end_sec - c.start_sec) - c.duration_sec) < 1e-9 && c.end_frame - c.start_frame === Math.round(c.duration_sec * 24)));
ok('cue type 取值合法', cues.every((c) => ['music', 'sfx', 'ambience', 'silence'].includes(c.type)));
ok('cue motif 取值合法（build / reduce / null）', cues.every((c) => ['build', 'reduce', null].includes(c.motif)));
ok('cue 帧覆盖合计 = 6600', cues.reduce((a, c) => a + (c.end_frame - c.start_frame), 0) === TOTAL);
ok('最响 = A37 @175s', d.dynamics.loudest_moment.cue_id === 'A37' && d.dynamics.loudest_moment.start_sec === 175, '');
ok('第一静 = A20 @88s', d.dynamics.quietest_moment.cue_id === 'A20' && d.dynamics.quietest_moment.start_sec === 88, '');
ok('第二静 = A54 @255s（8 秒无字幕静默）', d.dynamics.second_quietest_moment.cue_id === 'A54' && d.dynamics.second_quietest_moment.start_sec === 255 && d.dynamics.second_quietest_moment.end_sec === 263, '');
ok('第二静确实排第二（按 dynamics_db 排序，排除绝对静音段）', (() => { const r = cues.filter((c) => !['A15', 'A57'].includes(c.id)).slice().sort((a, b) => a.dynamics_db - b.dynamics_db); return r[0].id === 'A20' && r[1].id === 'A54'; })(), '');
ok('绝对静音段已单列（A15/A57 不计入最静排名）', Array.isArray(d.dynamics.absolute_silence.cue_ids) && d.dynamics.absolute_silence.cue_ids.join() === 'A15,A57' && d.audio_cues.find((c) => c.id === 'A15').dynamics_db < d.audio_cues.find((c) => c.id === 'A20').dynamics_db, '');

const cards = d.title_cards;
ok('title_cards 数 = 12（11 卡 + 1 画内事件）', cards.length === 12, `实测 ${cards.length}`);
ok('字幕卡 11 张（T01–T11）', cards.filter((c) => c.is_title_card).length === 11 && cards.filter((c) => c.is_title_card).every((c) => /^T\d\d$/.test(c.id)));
ok('画内事件 IN01 单列且标注非字幕卡', cards.some((c) => c.id === 'IN01' && c.is_title_card === false && c.source_check === 'not_a_title_card' && c.mode === 'in_scene'), '');
ok('card mode 取值合法', cards.every((c) => ['in_scene', 'overlay', 'fullscreen'].includes(c.mode)));
ok('card shot_id 均指向真实镜头', cards.every((c) => shots.some((s) => s.id === c.shot_id)));
ok('card 时长自洽', cards.every((c) => Math.abs((c.end_sec - c.start_sec) - c.duration_sec) < 1e-9 && c.end_frame - c.start_frame === Math.round(c.duration_sec * 24)));
ok('card 含 duration_frames 且与边界一致', cards.every((c) => c.duration_frames === c.end_frame - c.start_frame && c.duration_frames === Math.round(c.duration_sec * 24)));
ok('尾板卡 T11 = 4:30–4:35 = 120 帧', (() => { const t = cards.find((c) => c.id === 'T11'); return t.start_frame === 6480 && t.end_frame === 6600 && t.duration_frames === 120 && t.source_check === 'tail_slate'; })(), '');
ok('片头署名只以画内事件出现（无「本片由…制作」卡）', !cards.some((c) => c.is_title_card && c.start_sec < 22 && /制作/.test(c.text_zh)), '');
ok('动态弧线已标注最响/第一静/第二静', !!d.dynamics.loudest_moment && !!d.dynamics.quietest_moment && !!d.dynamics.second_quietest_moment);
ok('唯一全奏段落在 2:45–3:50', d.dynamics.tutti_window_sec[0] === 165 && d.dynamics.tutti_window_sec[1] === 230);
ok('v2 处置清单已保留', Array.isArray(d.source_notes.v2_resolved) && d.source_notes.v2_resolved.length >= 10, `${d.source_notes.v2_resolved.length} 条`);
ok('版本标注为 v3', /v3/.test(d.source_notes.version), d.source_notes.version);
ok('正片内容无「行列式」字样（v3 已换脊椎；仅 source_notes 保留 v2 史料）',
  !/行列式|determinant|det A/.test(JSON.stringify({
    film: d.film, math: d.math_constraints, movements: d.movements.map((m) => ({ name_zh: m.name_zh, emotion: m.emotion, shots: m.shots.map((s) => ({ d: s.description_zh, t: s.technique, a: s.audio })) })), cards: d.title_cards.map((c) => c.text_zh),
  })), '');

console.log('\n[附加] 与 02-分镜表.md（v3）逐镜时间码比对');
const SB = [ // [id, 入秒, 出秒, 分镜表标称时长]
  ['S01',0,2,2.0],['S02',2,6,4.0],['S03',6,8,2.0],['S04',8,14,6.0],['S05',14,19,5.0],['S06',19,22,3.0],['S07',22,28,6.0],['S08',28,36,8.0],['S09',36,44,8.0],['S10',44,50,6.0],['S11',50,52,2.0],['S12',52,56,4.0],['S13',56,60,4.0],['S14',60,63,3.0],['S15',63,65,2.0],
  ['S16',65,70,5.0],['S17',70,78,8.0],['S18',78,84,6.0],['S19',84,88,4.0],['S20',88,91,3.0],['S21',91,96,5.0],['S22',96,100,4.0],['S23',100,104,4.0],['S24',104,105,1.0],
  ['S25',105,112,7.0],['S26',112,118,6.0],['S27',118,125,7.0],['S28',125,132,7.0],['S29',132,138,6.0],['S30',138,144,6.0],['S31',144,148,4.0],['S32',148,156,8.0],['S33',156,160,4.0],['S34',160,165,5.0],
  ['S35',165,168,3.0],['S36',168,175,7.0],['S37',175,178,3.0],['S38',178,185,7.0],['S39',185,192,7.0],['S40',192,198,6.0],['S41',198,206,8.0],['S42',206,213,7.0],['S43',213,218,5.0],['S44',218,224,6.0],['S45',224,229,5.0],['S46',229,230,1.0],
  ['S47',230,234,4.0],['S48',234,241,7.0],['S49',241,245,4.0],['S50',245,250,5.0],['S51',250,253,3.0],['S52',253,263,10.0],['S53',263,267,4.0],['S54',267,270,3.0],
  ['S55',270,275,5.0],
];
let sbMiss = 0;
for (const [id, s, e, dur] of SB) {
  const sh = shots.find((x) => x.id === id);
  if (!sh || sh.start_frame !== Math.round(s * 24) || sh.end_frame !== Math.round(e * 24)) { sbMiss++; bad.push(`${id} 与分镜表时间码不符`); }
  if (Math.abs(sh.storyboard_nominal_duration_sec - dur) > 1e-9) { sbMiss++; bad.push(`${id} 标称时长不符`); }
}
ok('55 镜入出点与标称时长全部对上分镜表 v3', sbMiss === 0, `不符 ${sbMiss} 项`);
const durDrift = shots.filter((s) => Math.abs(s.duration_sec - s.storyboard_nominal_duration_sec) > 0.021);
ok('派生时长与分镜表标称时长偏差 ≤ 1 帧（含尾板）', durDrift.length === 0, durDrift.length ? durDrift.map((s) => `${s.id}:${s.storyboard_nominal_duration_sec}→${s.duration_sec}`).join(' ') : '最大偏差 ≤ 0.021s');
ok('矛盾清单已落盘', d.source_notes.contradictions.length >= 8, `${d.source_notes.contradictions.length} 条`);

console.log(`\n结果：${pass} ✓ / ${fail} ✗`);
if (fail) { console.log('失败项：'); bad.forEach((b) => console.log('  - ' + b)); }
console.log(fail === 0 ? 'ALL CHECKS PASSED' : 'CHECKS FAILED');
process.exit(fail === 0 ? 0 : 1);
