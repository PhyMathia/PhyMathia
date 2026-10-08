// Token 用量统计（2026-10-08）：记账只读可视化面板的冒烟域。
// 纯函数用例全程同步；行为用例临时装 document/fetch/AbortSignal/escapeHtml 垫片
// （测完在 finally 恢复，不依赖也不改变全局环境——notes-export 的 escapeHtml
// 同款手法，utils 的 escapeHtml 走 DOM 在 loose 沙箱下产物会退化为代理）。
// 本域不碰共享 localStorage 键；注册在薄壳尾部（accounts-trash 之后、finish 前）。
import { check, drain, sandbox, fs } from './_runner.mjs';

export async function run() {
  // utils 的 escapeHtml 走 DOM（loose 沙箱下退化为代理），整域换装等价转义
  const prevEscape = sandbox.escapeHtml;
  sandbox.escapeHtml = (t) => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  try {
    check('token-usage：_tokenFormatNum 万/亿口径与空值', () => {
      const f = sandbox._tokenFormatNum;
      if (f(0) !== '0') throw new Error('0 应原样：' + f(0));
      if (f(999) !== '999') throw new Error('千以下应原样：' + f(999));
      if (f(9999) !== '9999') throw new Error('万以下应原样：' + f(9999));
      if (f(10000) !== '1万') throw new Error('10000 应为 1万：' + f(10000));
      if (f(1234567) !== '123.5万') throw new Error('1234567 应为 123.5万：' + f(1234567));
      if (f(999999) !== '100万') throw new Error('999999 应进位为 100万：' + f(999999));
      if (f(820000000) !== '8.2亿') throw new Error('820000000 应为 8.2亿：' + f(820000000));
      for (const bad of [null, undefined, '']) {
        if (f(bad) !== '—') throw new Error('空值应为 —：' + f(bad));
      }
      return true;
    });

    check('token-usage：_tokenUsageDateList 整天序列与 _tokenUsageNiceMax 取整', () => {
      const list = sandbox._tokenUsageDateList(7);
      if (list.length !== 7) throw new Error('应返回 7 天：' + list.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(list[0])) throw new Error('格式应为 YYYY-MM-DD：' + list[0]);
      const today = (() => {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      })();
      if (list[list.length - 1] !== today) throw new Error('末日应为今天：' + list[list.length - 1] + ' vs ' + today);
      for (let i = 1; i < list.length; i++) {
        if (list[i] <= list[i - 1]) throw new Error('应严格递增：' + list[i - 1] + ' -> ' + list[i]);
      }
      const nice = sandbox._tokenUsageNiceMax;
      if (nice(5) !== 5 || nice(7) !== 10 || nice(120) !== 200 || nice(0) !== 1 || nice(-5) !== 1) {
        throw new Error('niceMax 取整口径不对：' + [nice(5), nice(7), nice(120), nice(0)].join(','));
      }
      return true;
    });

    check('token-usage：_tokenUsageSmoothPath 单调三次——过点/控制点不过冲/退化形态', () => {
      const sp = sandbox._tokenUsageSmoothPath;
      if (sp([]) !== '') throw new Error('空入参应给空串');
      if (!/^M[\d.]+ [\d.]+$/.test(sp([[5, 5]]))) throw new Error('单点应只剩 M：' + sp([[5, 5]]));
      if (!sp([[0, 100], [100, 50]]).includes('L100.0 50.0')) throw new Error('两点应退化为直线段');
      // 尖峰数据集（V 形＋平台＋陡降）：普通 Catmull-Rom 在这里会过冲越界
      const pts = [[0, 200], [60, 120], [120, 180], [180, 40], [240, 40], [300, 160]];
      const d = sp(pts);
      const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      if (/NaN|Infinity/.test(d) || nums.length !== 2 + (pts.length - 1) * 6) {
        throw new Error('d 串结构应为 M＋(n-1) 个 C 六元组：' + nums.length);
      }
      if (nums[0] !== pts[0][0] || nums[1] !== pts[0][1]) throw new Error('起点应即首个数据点');
      for (let k = 0; k < pts.length - 1; k++) {
        const base = 2 + k * 6;
        const c1y = nums[base + 1], c2y = nums[base + 3], endX = nums[base + 4], endY = nums[base + 5];
        if (c1y < 39.9 || c1y > 200.1 || c2y < 39.9 || c2y > 200.1) {
          throw new Error('控制点 y 越出数据范围（过冲）：' + c1y + ',' + c2y);
        }
        if (Math.abs(endX - pts[k + 1][0]) > 0.1 || Math.abs(endY - pts[k + 1][1]) > 0.1) {
          throw new Error('曲线未过数据点：段 ' + k + ' 末点 ' + endX + ',' + endY);
        }
      }
      return true;
    });

    check('token-usage：_tokenUsageTopModels 排序取前 N＋其余并入其他，分片值总和守恒', () => {
      const models = {};
      for (let i = 1; i <= 10; i++) models['m' + i] = { totalTokens: i * 100 };
      const all = sandbox._tokenUsageTopModels(models, 100);
      if (all.length !== 10) throw new Error('不超上限不应出现其他：' + all.length);
      if (all[0].label !== 'm10') throw new Error('应按 token 降序：' + all[0].label);
      const top = sandbox._tokenUsageTopModels(models, 7);
      if (top.length !== 8) throw new Error('前 7 名＋其他应为 8 片：' + top.length);
      if (top[top.length - 1].label !== '其他') throw new Error('末位应为其他');
      const sum = top.reduce((s, x) => s + x.value, 0);
      const expect = Object.values(models).reduce((s, b) => s + b.totalTokens, 0);
      if (sum !== expect) throw new Error('分片值总和不守恒：' + sum + ' vs ' + expect);
      if (!top[0].color) throw new Error('分片应带配色');
      return true;
    });

    check('token-usage：趋势平滑曲线（总量单线＝M＋6C/逐日标轴/悬停点）/分线/空态', () => {
      const dates = sandbox._tokenUsageDateList(7);
      const day = (i) => dates[dates.length - 1 - i]; // 倒数第 i+1 天
      const data = {
        days: {
          [day(0)]: { totalTokens: 300 }, [day(1)]: { totalTokens: 120 }, [day(2)]: { totalTokens: 0 },
        },
        models: { 'deepseek-chat': { totalTokens: 400 }, 'primary': { totalTokens: 20 } },
        series: {
          [day(0)]: { 'deepseek-chat': { totalTokens: 280 }, 'primary': { totalTokens: 20 } },
          [day(1)]: { 'deepseek-chat': { totalTokens: 120 } },
        },
      };
      const totalHtml = sandbox._tokenUsageLineHtml(data, 7, false);
      const totalPaths = [...totalHtml.matchAll(/<path d="/g)].length;
      if (totalPaths !== 1) throw new Error('总量模式应只有 1 条曲线：' + totalPaths);
      const dAttr = (totalHtml.match(/ d="([^"]+)"/) || [])[1] || '';
      if (!dAttr.startsWith('M') || (dAttr.match(/C/g) || []).length !== 6) {
        throw new Error('7 天曲线应为 M＋6 段 C：' + dAttr.slice(0, 60));
      }
      if (/NaN|Infinity/.test(totalHtml)) throw new Error('坐标不应出现 NaN/Infinity');
      if ((totalHtml.match(/<title>/g) || []).length !== 7) throw new Error('应有 7 个数据点悬停提示');
      if (!totalHtml.includes('总 token')) throw new Error('图例应含「总 token」');
      if (!totalHtml.includes(dates[6].slice(5))) throw new Error('横轴应含末日 MM-DD');
      const textCount = (totalHtml.match(/<text /g) || []).length;
      if (textCount !== 10) throw new Error('7 天应逐日标轴（7 轴标＋3 网格标）：' + textCount);
      const splitHtml = sandbox._tokenUsageLineHtml(data, 7, true);
      const splitLines = [...splitHtml.matchAll(/<path d="/g)].length;
      if (splitLines !== 2) throw new Error('分线模式应为 2 条（两模型）：' + splitLines);
      if (!splitHtml.includes('deepseek-chat') || !splitHtml.includes('primary')) throw new Error('图例应含两模型名');
      if (!sandbox._tokenUsageLineHtml({ models: {} }, 7, true).includes('范围内没有 AI 调用记录')) {
        throw new Error('空数据应给空态');
      }
      return true;
    });

    check('token-usage：圆环 conic 分段/中心总量/行式图例（百分比整位与小数位）', () => {
      const html = sandbox._tokenUsagePieHtml([
        { label: 'a', value: 75, color: 'c1' },
        { label: 'b', value: 25, color: 'c2' },
      ]);
      if (!html.includes('conic-gradient(c1 0% 75%, c2 75% 100%)')) {
        throw new Error('分段 stop 不符：' + (html.match(/conic-gradient\([^)]*\)/) || [''])[0]);
      }
      if (!html.includes('token-usage-donut-center') || !html.includes('>100</b>')) {
        throw new Error('中心应展示范围内总量（_tokenFormatNum）');
      }
      if (!html.includes('>75%<') || !html.includes('>25%<')) throw new Error('图例百分比不符');
      if (!html.includes('75 tok') || !html.includes('25 tok')) throw new Error('图例数值不符');
      const mix = sandbox._tokenUsagePieHtml([
        { label: 'a', value: 919, color: 'c1' },
        { label: 'b', value: 81, color: 'c2' },
      ]);
      if (!mix.includes('>92%<') || !mix.includes('>8.1%<')) {
        throw new Error('不足 10% 应保留一位小数：' + mix);
      }
      if (!sandbox._tokenUsagePieHtml([]).includes('暂无用量记录')) throw new Error('空分片应给空态');
      if (!sandbox._tokenUsagePieHtml([{ label: 'x', value: 0, color: 'c' }]).includes('暂无用量记录')) {
        throw new Error('全零分片应给空态');
      }
      return true;
    });

    check('token-usage：用途条形中文映射／降序／归一宽度／零值过滤', () => {
      const html = sandbox._tokenUsageKindBarsHtml({
        kinds: {
          chat: { totalTokens: 100, requests: 2 },
          harness: { totalTokens: 300, requests: 1 },
          docs: { totalTokens: 0, requests: 5 },
        },
      });
      const hPos = html.indexOf('Φ 智能体');
      const cPos = html.indexOf('聊天问答');
      if (hPos < 0 || cPos < 0) throw new Error('用途中文名映射缺失');
      if (hPos > cPos) throw new Error('应按 token 降序排列');
      if (html.includes('文档解析')) throw new Error('零值用途应被过滤');
      if (!html.includes('width:100%') || !html.includes('width:33%')) throw new Error('条宽应按最大值归一');
      if (!html.includes('300 tok · 1 次')) throw new Error('行尾数值文案不符');
      return true;
    });

    check('token-usage：汇总卡与明细表（命中率空值 —、按总量降序）', () => {
      const cards = sandbox._tokenUsageSummaryHtml({
        requests: 42, promptTokens: 1500000, completionTokens: 1234,
        cachedTokens: 0, hitKnownRequests: 0, hitRate: null,
      });
      if (!cards.includes('>42<') || !cards.includes('150万') || !cards.includes('1234')) throw new Error('数字卡数值不符');
      if (!cards.includes('缓存命中') || !cards.includes('—') || !cards.includes('无命中字段')) throw new Error('命中率空值口径不符');
      const table = sandbox._tokenUsageTableHtml({
        models: {
          a: { requests: 2, promptTokens: 100, completionTokens: 10, totalTokens: 110, hitRate: 0.5 },
          b: { requests: 1, promptTokens: 5, completionTokens: null, totalTokens: 5, hitRate: null },
        },
      });
      if (table.indexOf('>a<') > table.indexOf('>b<')) throw new Error('应按总 token 降序');
      if (!table.includes('50%')) throw new Error('命中率应展示百分比');
      if (!table.includes('—')) throw new Error('无命中字段模型应显示 —');
      return true;
    });

    check('token-usage：dashboard 空态两档与整体拼装', () => {
      if (!sandbox._tokenUsageDashboardHtml(null, 30, false).includes('暂无用量数据')) throw new Error('null 应给空态');
      if (!sandbox._tokenUsageDashboardHtml({ total: { requests: 0 } }, 30, false).includes('没有 AI 调用记录')) {
        throw new Error('零调用应给空态');
      }
      const dates = sandbox._tokenUsageDateList(7);
      const full = sandbox._tokenUsageDashboardHtml({
        total: { requests: 3, promptTokens: 240, completionTokens: 25, totalTokens: 265, cachedTokens: 150, hitKnownRequests: 2, hitRate: 0.625 },
        days: { [dates[6]]: { totalTokens: 265 } },
        models: { 'deepseek-chat': { totalTokens: 265, requests: 3, hitRate: 0.625 } },
        series: { [dates[6]]: { 'deepseek-chat': { totalTokens: 265 } } },
        kinds: { chat: { totalTokens: 265, requests: 3 } },
      }, 7, false);
      if (!full.includes('token-summary-row')) throw new Error('应含汇总卡行');
      const cards = [...full.matchAll(/token-chart-card/g)].length;
      if (cards !== 4) throw new Error('应拼四张图表卡：' + cards);
      if (!full.includes('<svg') || !full.includes('conic-gradient') || !full.includes('token-kind-row') || !full.includes('token-usage-table')) {
        throw new Error('四图应齐全（折线/扇形/条形/明细表）');
      }
      return true;
    });

    check('token-usage：开合＋拉取渲染＋切范围／分线（不重拉）＋失败兜底', async () => {
      // 定向 document 垫片：只认本面板三个 id，其余落空（还原时不污染全局）
      const calls = { add: [], remove: [] };
      const dlg = { classList: { add: (c) => calls.add.push(c), remove: (c) => calls.remove.push(c) } };
      const body = { innerHTML: '' };
      const chk = { checked: true };
      const prevDoc = sandbox.document;
      sandbox.document = { getElementById: (id) => (id === 'tokenDialog' ? dlg : id === 'tokenUsageBody' ? body : id === 'tokenUsageSplitChk' ? chk : null) };
      const dates = sandbox._tokenUsageDateList(30);
      const fixture = {
        total: { requests: 5, promptTokens: 500, completionTokens: 50, totalTokens: 550, cachedTokens: 100, hitKnownRequests: 2, hitRate: 0.2 },
        days: { [dates[29]]: { totalTokens: 550 } },
        models: { 'deepseek-chat': { totalTokens: 550, requests: 5, hitRate: 0.2 } },
        series: { [dates[29]]: { 'deepseek-chat': { totalTokens: 550 } } },
        kinds: { chat: { totalTokens: 550, requests: 5 } },
      };
      const fetchCalls = [];
      const toasts = [];
      const prevFetch = sandbox.fetch;
      const prevSignal = sandbox.AbortSignal;
      const prevToast = sandbox.toastMsg;
      const prevRender = sandbox.renderTokenUsage;
      sandbox.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true, status: 200, json: async () => fixture }; };
      sandbox.AbortSignal = { timeout: (ms) => ({ __timeoutMs: ms }) };
      sandbox.toastMsg = (msg) => toasts.push(msg);
      try {
        await sandbox.renderTokenUsage();
        if (fetchCalls.length !== 1) throw new Error('应恰好拉取一次：' + fetchCalls.length);
        if (fetchCalls[0].url !== '/api/usage/stats?days=30') throw new Error('默认范围应为 30 天：' + fetchCalls[0].url);
        if (!fetchCalls[0].opts || fetchCalls[0].opts.cache !== 'no-cache' || !fetchCalls[0].opts.signal) {
          throw new Error('fetch 应带 cache:no-cache＋AbortSignal 超时');
        }
        if (fetchCalls[0].opts.signal.__timeoutMs !== 10000) throw new Error('超时应为 10000ms');
        if (!body.innerHTML.includes('token-summary-row') || !body.innerHTML.includes('每日 token 趋势')) {
          throw new Error('渲染产物缺汇总卡或折线卡');
        }
        sandbox.openTokenUsagePanel();
        if (!calls.add.includes('show')) throw new Error('开面板应加 .show');
        sandbox.setTokenUsageDays('90');
        await sandbox.renderTokenUsage();
        const last = fetchCalls[fetchCalls.length - 1];
        if (last.url !== '/api/usage/stats?days=90') throw new Error('切范围后应按 90 天拉取：' + last.url);
        const countAfterRange = fetchCalls.length;
        sandbox.toggleTokenUsageSplit();
        if (fetchCalls.length !== countAfterRange) throw new Error('切分线只应用缓存重画，不应重拉');
        if (!body.innerHTML.includes('token-summary-row')) throw new Error('切分线后应重渲染出内容');
        sandbox.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
        await sandbox.renderTokenUsage();
        if (!body.innerHTML.includes('读取失败')) throw new Error('非 2xx 应走失败兜底文案');
        if (!toasts.some(t => String(t).includes('用量统计读取失败'))) throw new Error('失败应 toast 提示');
        sandbox.closeTokenUsagePanel();
        if (!calls.remove.includes('show')) throw new Error('关面板应移除 .show');
        return true;
      } finally {
        sandbox.document = prevDoc;
        sandbox.fetch = prevFetch;
        sandbox.AbortSignal = prevSignal;
        sandbox.toastMsg = prevToast;
        sandbox.renderTokenUsage = prevRender;
      }
    });

    check('token-usage：源码契约（fetch 必带 signal＋no-cache；HTML 容器与构建注册在位）', () => {
      const src = fs.readFileSync('src/static/js/token-usage.js', 'utf8');
      const fetchSites = [...src.matchAll(/fetch\('\/api\/usage\/stats[^']*'/g)];
      if (fetchSites.length !== 1) throw new Error('应有且只有一处用量拉取：' + fetchSites.length);
      if (!src.includes("cache: 'no-cache'")) throw new Error('拉取应带 cache:no-cache');
      if (!src.includes('signal: AbortSignal.timeout(10000)')) throw new Error('拉取应带 10s AbortSignal');
      if (!src.includes("window.openTokenUsagePanel = openTokenUsagePanel")) throw new Error('冒烟导出块缺失');
      if (!src.includes('window._tokenUsageSmoothPath')) throw new Error('平滑曲线函数未导出冒烟');
      const html = fs.readFileSync('src/static/index.html', 'utf8');
      for (const needle of ['id="tokenDialog"', 'id="tokenUsageBody"', 'id="tokenUsageRange"',
        'id="tokenUsageSplitChk"', 'openTokenUsagePanel()', 'setTokenUsageDays(this.value)', 'toggleTokenUsageSplit()']) {
        if (!html.includes(needle)) throw new Error('index.html 缺 ' + needle);
      }
      const buildSrc = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');
      if (!buildSrc.includes("'token-usage.js'")) throw new Error('构建 entries 未注册 token-usage.js');
      return true;
    });

    await drain();
  } finally {
    sandbox.escapeHtml = prevEscape;
  }
}
