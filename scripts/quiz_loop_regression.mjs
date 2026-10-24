#!/usr/bin/env node
// 真机回归（playwright + 隔离数据目录）：多选画布出题的三件用户实踩
// ①勾选一行列表瞬间翻动 ②不显示本画布题库已有题数 ③出了 105 题只有 30 题进题库
// （三件已于 2026-10-13 修复销账，本支转为改出题链/题库容量后的按需回归档）
// 用法：node scripts/quiz_loop_regression.mjs   （自带临时数据目录＋21 画布种子，不碰 data/；
//   需 playwright chromium；断言口径与坑见 docs/dev/canvas-modules.md「多选画布出题」节）
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = '/media/sample/3T硬盘/PhyMathia1.4.1/PhyMathia';
const PORT = 5079;
const BASE = `http://127.0.0.1:${PORT}`;
const NCANVAS = 21;

const results = [];
const ok = n => { results.push(true); console.log('✓ ' + n); };
const fail = (n, e) => { results.push(false); console.log('❌ ' + n + ' -> ' + ((e && e.message) || e)); };
const wait = ms => new Promise(r => setTimeout(r, ms));

async function waitHealth(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (e) {}
    await wait(300);
  }
  throw new Error('服务 40s 内未就绪');
}

const sessions = () => {
  const now = Date.now();
  return Array.from({ length: NCANVAS }, (_, i) => ({
    id: 'sess_q' + String(i).padStart(2, '0'), title: '画布' + String(i + 1).padStart(2, '0'),
    sessionId: 'sess_q' + String(i).padStart(2, '0'), icon: '', createdAt: now - i * 1000, updatedAt: now - i * 1000,
  }));
};
const knowledge = () => {
  const map = {};
  sessions().forEach((s, i) => {
    for (let k = 0; k < 3; k++) {
      const id = `ki_q${i}_${k}`;
      map[id] = {
        id, title: `画布${i + 1}知识点${k + 1}`, sessionId: s.id, createdAt: Date.now() - i * 1000,
        category: '概念', source: 'manual', summarySource: 'model',
        summary: `这是第 ${i + 1} 张画布的第 ${k + 1} 个知识点的摘要，描述该概念的定义、判据与适用边界。`,
        formulas: [`x_{${i}${k}} = A \\cos(\\omega t + \\varphi)`],
      };
    }
  });
  return map;
};

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'phymathia-quizreg-'));
  cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
  const server = spawn('python3', ['src/main.py', '-p', String(PORT)], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', d => { log += String(d); });
  server.stderr.on('data', d => { log += String(d); });
  let browser = null;
  try {
    await waitHealth();
    for (const [path, body] of [['/api/sessions', sessions()], ['/api/knowledge', knowledge()]]) {
      const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('种数据失败 ' + path + ' HTTP ' + r.status);
    }
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => console.log('  [页面异常]', e.message));
    // 引导浮层会拦住点击（本轮实踩）：先按它的完成标记关掉，避免用例随机红
    await page.addInitScript(() => { try { localStorage.setItem('phymathia_onboarding_done', '1'); } catch (e) {} });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.openQuiz === 'function' && typeof window.getAllSessions === 'function');
    await page.waitForFunction(n => window.getAllSessions().length >= n, NCANVAS);
    // 出题链打桩：本回归只验面板/入库，不调真模型
    await page.evaluate(() => {
      window.__aiCalls = [];
      window._aiGenerateQuizQuestions = async (pool) => {
        const sid = (pool.knowledge[0] || pool.formulas[0]).sessionId;
        window.__aiCalls.push(sid);
        return Array.from({ length: 5 }, (_, i) => ({
          id: 'ai_' + sid + '_' + i + '_' + Date.now(), type: 'concept', title: '题' + i,
          prompt: '第 ' + sid + ' 张画布的第 ' + i + ' 题：' + 'x'.repeat(20),
          options: [{ key: 'A', text: '选项甲' }, { key: 'B', text: '选项乙' }, { key: 'C', text: '选项丙' }, { key: 'D', text: '选项丁' }],
          correctIndex: 0, difficulty: 'medium', explanation: '解析文字', sessionId: sid,
        }));
      };
      window._pickQuizModel = () => ({ id: 'mock', label: 'mock' });
      localStorage.setItem('phymathia_quiz_source', 'ai');
      localStorage.removeItem('phymathia_quiz_bank');
    });
    await page.evaluate(() => { quizBank = null; quizSourcePreference = 'ai'; });

    // ===== ① 勾选一行：列表不得重画/跳位 =====
    await page.evaluate(() => openQuiz('global'));
    await page.waitForSelector('.quiz-loop-list .quiz-loop-row');
    const rows = await page.locator('.quiz-loop-list .quiz-loop-row').count();
    const before = await page.evaluate(() => {
      const list = document.querySelector('.quiz-loop-list');
      list.scrollTop = 60;                       // 往下滚：整份重画会把 scrollTop 清零
      list.dataset.keepMarker = 'alive';         // 重画会换掉 DOM 节点，标记随之消失
      window.__listMutations = 0;                // 子节点新增＝列表被重画（就地同步只改 checked/文案）
      window.__listObserver = new MutationObserver(ms => {
        window.__listMutations += ms.filter(m => m.type === 'childList' && m.addedNodes.length).length;
      });
      window.__listObserver.observe(list, { childList: true, subtree: true });
      return { scrollTop: list.scrollTop };
    });
    // 用页面内 click() 而不是 playwright click：后者会把目标行滚进视野（假阳性，本轮实踩）
    await page.evaluate(() => document.querySelector('.quiz-loop-list .quiz-loop-row:nth-child(4) input').click());
    await wait(150);
    const after = await page.evaluate(() => {
      const list = document.querySelector('.quiz-loop-list');
      window.__listObserver.disconnect();
      return {
        scrollTop: list.scrollTop, marker: list.dataset.keepMarker || '', mutations: window.__listMutations,
        checked: document.querySelectorAll('.quiz-loop-list input:checked').length,
        foot: (document.getElementById('quizLoopFoot') || {}).textContent || '',
        startDisabled: (document.getElementById('quizLoopStart') || {}).disabled,
      };
    });
    if (rows !== NCANVAS) fail('① 面板应列出 21 张画布', new Error('实际 ' + rows));
    else if (before.scrollTop !== 60) fail('① 滚动位置未能设置（面板不可滚？）', new Error('scrollTop=' + before.scrollTop));
    else if (after.mutations) fail('① 勾选触发了列表重画', new Error('子节点新增 ' + after.mutations + ' 次'));
    else if (after.marker !== 'alive') fail('① 勾选触发了整份重画（DOM 被替换）', new Error('标记丢失'));
    else if (after.scrollTop !== before.scrollTop) fail('① 勾选后列表被翻动', new Error(before.scrollTop + ' → ' + after.scrollTop));
    else if (after.checked !== 1) fail('① 勾选态未落到 checkbox', new Error('checked=' + after.checked));
    else if (!/已选 1 张/.test(after.foot)) fail('① 页脚选中数未就地更新', new Error(after.foot));
    else if (after.startDisabled) fail('① 勾选后「开始出题」应可用', new Error('仍禁用'));
    else ok('① 勾选一张画布：列表零重画、滚动位置不动、页脚/按钮就地更新');

    // ===== ② 全选 → 面板每行显示题库题数（首轮为 0）=====
    await page.evaluate(() => toggleQuizLoopSelectAll());
    await wait(100);
    const meta = await page.evaluate(() => {
      const first = document.querySelector('.quiz-loop-list .quiz-loop-row');
      return { text: first ? first.textContent : '', foot: (document.getElementById('quizLoopFoot') || {}).textContent || '' };
    });
    if (!/题库 0 题/.test(meta.text)) fail('② 行内应显示本画布题库题数', new Error(meta.text.trim()));
    else if (!/选中画布题库共 0 题/.test(meta.foot)) fail('② 页脚应显示选中画布题库合计', new Error(meta.foot));
    else ok('② 面板每行显示「题库 N 题」＋页脚合计');

    // 可选：存面板截图（人眼验收行内排版：标题省略号 + 素材量 + 题库题数胶囊）
    if (process.env.QUIZ_REG_SHOT) await page.screenshot({ path: process.env.QUIZ_REG_SHOT });
    // ===== ③ 全选 21 张画布出题：105 题应全部进题库（旧版只剩 30 题）=====
    await page.click('#quizLoopStart');
    await page.waitForFunction(() => !(quizState && quizState.aiPending) && quizState && quizState.questions && quizState.questions.length > 0, null, { timeout: 60000 });
    await wait(600);
    const paper = await page.evaluate(() => quizState.questions.length);
    const aiCalls = await page.evaluate(() => window.__aiCalls.length);
    const bankLocal = await page.evaluate(() => {
      const b = JSON.parse(localStorage.getItem('phymathia_quiz_bank') || 'null');
      const per = {};
      for (const q of (b && b.questions) || []) per[q.sessionId] = (per[q.sessionId] || 0) + 1;
      return { total: (b && b.questions || []).length, canvases: Object.keys(per).length, min: Math.min(...Object.values(per)), html: (b.questions[0].options[0] || {}).html };
    });
    const bankServer = await (await fetch(BASE + '/api/kv/phymathia_quiz_bank')).json();
    const srvCount = ((bankServer.value || {}).questions || []).length;
    if (aiCalls !== NCANVAS) fail('③ 应逐画布各调一次出题', new Error('实际 ' + aiCalls));
    else if (paper !== NCANVAS * 5) fail('③ 卷面应为 105 题', new Error('实际 ' + paper));
    else if (bankLocal.total !== NCANVAS * 5) fail('③ 题库应留 105 题（旧版被 30 题上限挤到只剩 30）', new Error('实际 ' + bankLocal.total));
    else if (bankLocal.canvases !== NCANVAS) fail('③ 题库应覆盖全部 21 张画布', new Error('实际 ' + bankLocal.canvases + ' 张'));
    else if (bankLocal.min !== 5) fail('③ 每张画布都该留住 5 题', new Error('最少 ' + bankLocal.min));
    else if (bankLocal.html) fail('③ 落盘未瘦身', new Error('option.html 仍在'))
    else if (srvCount !== NCANVAS * 5) fail('③ 服务端 kv 应同步 105 题', new Error('实际 ' + srvCount))
    else ok('③ 全选 21 张画布出题：105 题全部入库（21 张画布各 5 题）＋服务端同步＋落盘瘦身');

    // ===== ④ 出完题再看面板：每行题库题数应为 5 =====
    await page.evaluate(() => { quizLoopPanelOpen = true; renderQuiz(); });
    await page.waitForSelector('.quiz-loop-list .quiz-loop-row');
    const meta2 = await page.evaluate(() => {
      const texts = [...document.querySelectorAll('.quiz-loop-list .quiz-loop-row')].map(r => r.textContent);
      return { total5: texts.filter(t => /题库 5 题/.test(t)).length, sample: texts[0] };
    });
    if (process.env.QUIZ_REG_SHOT_AFTER) await page.screenshot({ path: process.env.QUIZ_REG_SHOT_AFTER });
    if (meta2.total5 !== NCANVAS) fail('④ 出题后每行应显示「题库 5 题」', new Error('命中 ' + meta2.total5 + '/21：' + meta2.sample.trim()));
    else ok('④ 出题后回看面板：21 行全部显示「题库 5 题」');
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
    await wait(500);
    try { rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }
  const failed = results.filter(r => !r).length;
  console.log(failed ? `\n真机回归失败：${results.length - failed}/${results.length} 通过` : `\n真机回归全部通过（${results.length} 项）`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('回归脚本异常：', e); process.exit(1); });
