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

    check('token-usage：_tokenFormatMs 耗时口径（ms/s 分界与空值/非法值）', () => {
      const f = sandbox._tokenFormatMs;
      if (f(0) !== '0ms') throw new Error('0 应为 0ms：' + f(0));
      if (f(850) !== '850ms') throw new Error('毫秒段应原样：' + f(850));
      if (f(999) !== '999ms') throw new Error('1s 以下应为 ms：' + f(999));
      if (f(1000) !== '1s') throw new Error('1000 应为 1s：' + f(1000));
      if (f(1234) !== '1.2s') throw new Error('1234 应为 1.2s：' + f(1234));
      if (f(95600) !== '95.6s') throw new Error('95600 应为 95.6s：' + f(95600));
      for (const bad of [null, undefined, '', -5, 'abc']) {
        if (f(bad) !== '—') throw new Error('空值/非法值应为 —：' + f(bad));
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

    check('token-usage：过渡动画纯函数——ease 端点/重采样同族平滑不落弦/morph 两端形态/圆环边界', () => {
      const ease = sandbox._tokenUsageEase;
      if (ease(0) !== 0 || ease(1) !== 1 || ease(0.5) !== 0.5) {
        throw new Error('ease 端点不符：' + [ease(0), ease(0.5), ease(1)].join(','));
      }
      if (!(ease(0.25) > 0 && ease(0.25) < 0.25) || !(ease(0.75) > 0.75 && ease(0.75) < 1)) {
        throw new Error('ease 应缓入缓出单调：' + ease(0.25) + ',' + ease(0.75));
      }
      const rs = sandbox._tokenUsageResample;
      const mid = rs([0, 10], 3);
      if (mid.length !== 3 || mid[0] !== 0 || mid[1] !== 5 || mid[2] !== 10) {
        throw new Error('两点序列应退化为直线中点：' + mid.join(','));
      }
      if (rs([7], 4).some(v => v !== 7)) throw new Error('单点重采样应恒值');
      const ends = rs([1, 2, 3, 9], 8);
      if (ends[0] !== 1 || ends[ends.length - 1] !== 9) throw new Error('重采样应保端点');
      // 闪帧回归（2026-10-08）：采样口径必须与显示同族（Fritsch–Carlson 单调三次），
      // 线性插值会把 7↔30/90 天 morph 的中间帧整段拉直成折线——非线性序列的
      // 采样点不得落在数据点直连弦上
      const curve = rs([0, 100, 40], 7);
      if (curve[3] !== 100) throw new Error('对齐数据点的采样位应取原值：' + curve[3]);
      if (Math.abs(curve[1] - 1100 / 27) > 1e-6) {
        throw new Error('1/3 位应取平滑曲线值 40.74 而非弦上 33.33：' + curve[1]);
      }
      if (!rs([0, 100, 0], 25).every(v => v >= 0 && v <= 100)) {
        throw new Error('V 形序列采样不得越出数据值范围（过冲）');
      }
      // 采样点＝显示曲线上的点：像素空间画 _tokenUsageSmoothPath（y=100-v 仿射
      // 映射），首段贝塞尔在 t=1/3 的 y 应等于数值采样点的同位映射（亚像素容差）
      const dMorph = sandbox._tokenUsageSmoothPath([[0, 100], [60, 0], [120, 60]]);
      const seg = dMorph.match(/M([\d.-]+) ([\d.-]+)C([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/);
      if (!seg) throw new Error('平滑 path 结构不符：' + dMorph.slice(0, 50));
      const [, , y0, , c1y, , c2y, , y1] = seg.map(Number);
      const bez = (8 / 27) * y0 + (4 / 9) * c1y + (2 / 9) * c2y + (1 / 27) * y1;
      if (Math.abs(bez - (100 - curve[1])) > 0.2) {
        throw new Error('重采样点应落在显示曲线上：' + bez.toFixed(2) + ' vs ' + (100 - curve[1]).toFixed(2));
      }
      // 几何常量：padT=12、plotH=174 → 顶 12 / 基线 186；morph 两端必须各等于旧/新形态
      const mp = sandbox._tokenUsageMorphPoints;
      const g0 = mp(null, 100, [0, 50, 100], 100, 0, 5);
      if (g0.some(p => p[1] !== 186)) throw new Error('t=0 无旧系列应全在基线：' + g0.map(p => p[1]).join(','));
      const g1 = mp(null, 100, [0, 50, 100], 100, 1, 3);
      if (Math.abs(g1[2][1] - 12) > 0.01) throw new Error('t=1 峰值应到顶：' + g1[2][1]);
      const x0 = mp([0, 100], 100, [100, 0], 100, 0, 2).map(p => p[1]);
      const x1 = mp([0, 100], 100, [100, 0], 100, 1, 2).map(p => p[1]);
      if (x0.join(',') !== '186,12' || x1.join(',') !== '12,186') {
        throw new Error('morph 两端应各等于旧/新形态：' + x0.join(',') + ' / ' + x1.join(','));
      }
      const db = sandbox._tokenUsageDonutBounds;
      const b2 = db([{ value: 75 }, { value: 25 }]);
      if (b2.length !== 3 || b2[0] !== 0 || Math.abs(b2[1] - 75) > 1e-9 || b2[2] !== 100) {
        throw new Error('两段边界不符：' + b2.join(','));
      }
      if (db([]).join(',') !== '0,100') throw new Error('空分段应得 0→100：' + db([]).join(','));
      const defTotal = sandbox._tokenUsageLineDefs({}, sandbox._tokenUsageDateList(7), false);
      if (defTotal.length !== 1 || defTotal[0].label !== '总 token' || defTotal[0].values.some(v => v !== 0)) {
        throw new Error('总量单线定义不符');
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
      // path 计数不锚定属性顺序（2026-10-08 五轮起 path 带 data-label）
      const totalPaths = [...totalHtml.matchAll(/<path [^>]*d="/g)].length;
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
      const splitLines = [...splitHtml.matchAll(/<path [^>]*d="/g)].length;
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

    check('token-usage：汇总卡与明细表（命中率空值 —、按总量降序、失败/耗时提示与列）', () => {
      const cards = sandbox._tokenUsageSummaryHtml({
        requests: 42, promptTokens: 1500000, completionTokens: 1234,
        cachedTokens: 0, hitKnownRequests: 0, hitRate: null,
      });
      if (!cards.includes('>42<') || !cards.includes('150万') || !cards.includes('1234')) throw new Error('数字卡数值不符');
      if (!cards.includes('缓存命中') || !cards.includes('—') || !cards.includes('无命中字段')) throw new Error('命中率空值口径不符');
      // 旧数据（无 errorRequests/avgDurationMs）：提示只回「次」，不出现失败/平均
      if (cards.includes('失败') || cards.includes('平均')) throw new Error('旧数据不应出现失败/平均提示');
      const cards2 = sandbox._tokenUsageSummaryHtml({
        requests: 7, promptTokens: 100, completionTokens: 10, cachedTokens: 0, hitKnownRequests: 0, hitRate: null,
        errorRequests: 2, avgDurationMs: 1234,
      });
      if (!cards2.includes('失败 2 次')) throw new Error('失败次数应进提示：' + cards2);
      if (!cards2.includes('平均 1.2s')) throw new Error('平均耗时应进提示：' + cards2);
      const table = sandbox._tokenUsageTableHtml({
        models: {
          a: { requests: 2, promptTokens: 100, completionTokens: 10, totalTokens: 110, hitRate: 0.5, avgDurationMs: 850 },
          b: { requests: 1, promptTokens: 5, completionTokens: null, totalTokens: 5, hitRate: null },
        },
      });
      if (table.indexOf('>a<') > table.indexOf('>b<')) throw new Error('应按总 token 降序');
      if (!table.includes('50%')) throw new Error('命中率应展示百分比');
      if (!table.includes('—')) throw new Error('无命中字段模型应显示 —');
      if (!table.includes('平均耗时')) throw new Error('明细表应有平均耗时列');
      if (!table.includes('850ms')) throw new Error('平均耗时应按 ms/s 口径展示');
      return true;
    });

    check('token-usage：调用明细表＋圆环图例可点标记＋折线 data-label（五轮 T196/T199）', () => {
      const t = sandbox._tokenRecordTime;
      if (t('2026-10-08T21:33:45') !== '10-08 21:33') throw new Error('时间口径不符：' + t('2026-10-08T21:33:45'));
      if (t('') !== '—' || t(null) !== '—') throw new Error('空时间应为 —');
      const html = sandbox._tokenUsageRecordsHtml({
        records: [
          { ts: '2026-10-08T21:33:45', kind: 'chat', model: 'glm-4.7', status: 'ok', durationMs: 950, promptTokens: 9000, completionTokens: 800, totalTokens: 9800 },
          { ts: '2026-10-08T21:30:01', kind: 'harness', model: 'deepseek-chat', status: 'error', durationMs: 120, error: 'HTTP 502 bad gateway', promptTokens: null, completionTokens: null, totalTokens: 0 },
        ],
      });
      if (!html.includes('10-08 21:33') || !html.includes('950ms')) throw new Error('成功行时间/耗时应展示');
      if (!html.includes('9800')) throw new Error('token 合计应展示');
      if (!html.includes('聊天问答') || !html.includes('Φ 智能体')) throw new Error('用途应中文映射');
      if (!html.includes('token-record-failed')) throw new Error('失败行应有标红类');
      if (!html.includes('title="HTTP 502 bad gateway"')) throw new Error('失败原因应进行 title 悬停可读');
      if (!html.includes('token-record-err">失败') || !html.includes('token-record-ok">成功')) {
        throw new Error('状态列应区分成功/失败徽标');
      }
      // 空态与无 records 键
      if (!sandbox._tokenUsageRecordsHtml({}).includes('暂无调用明细')) throw new Error('无 records 应给空态');
      // 圆环 pickable（分线模式）：图例带 data-model＋pick 类；非分线不带
      const pickHtml = sandbox._tokenUsagePieHtml([
        { label: 'm1', value: 60, color: 'c1' }, { label: 'm2', value: 40, color: 'c2' },
      ], true);
      if (!pickHtml.includes('token-donut-legend-pick') || !pickHtml.includes('data-model="m1"')) {
        throw new Error('pickable 图例应带 data-model');
      }
      if (sandbox._tokenUsagePieHtml([{ label: 'm1', value: 60, color: 'c1' }]).includes('token-donut-legend-pick')) {
        throw new Error('非分线模式图例不应可点');
      }
      // 折线 path 带 data-label（联动聚焦的匹配键）
      const lineHtml = sandbox._tokenUsageLineHtml({
        days: {}, models: { m: { totalTokens: 5 } }, series: {},
      }, 7, true);
      if (!/path data-label="/.test(lineHtml)) throw new Error('折线 path 应带 data-label');
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
      if (cards !== 5) throw new Error('应拼五张卡（趋势/圆环/用途/模型明细/最近调用）：' + cards);
      if (!full.includes('<svg') || !full.includes('conic-gradient') || !full.includes('token-kind-row') || !full.includes('token-usage-table')) {
        throw new Error('四图应齐全（折线/扇形/条形/明细表）');
      }
      if (!full.includes('最近调用明细')) throw new Error('第五卡应为最近调用明细');
      return true;
    });

    check('token-usage：开合＋拉取渲染＋失败兜底两档（空画布占位/旧图保留）＋切范围／分线＋自绘下拉闭环', async () => {
      // 定向 document 垫片：只认本面板的工具栏 id，其余落空（还原时不污染全局）。
      // 注意本域只允许这一个 async 用例——check() 注册即执行、多个 async 用例会在
      // await 点交错，而 fetch 序号/范围/live 快照都是模块级状态，交错即串场。
      const dlgCalls = { add: [], remove: [] };
      const bodyCalls = { add: [], remove: [] };
      const btnCalls = { add: [], remove: [] };
      const wrapCalls = { add: [], remove: [] };
      const dlg = { classList: { add: (c) => dlgCalls.add.push(c), remove: (c) => dlgCalls.remove.push(c) } };
      const body = { innerHTML: '', classList: { add: (c) => bodyCalls.add.push(c), remove: (c) => bodyCalls.remove.push(c) } };
      const refreshBtn = { classList: { add: (c) => btnCalls.add.push(c), remove: (c) => btnCalls.remove.push(c) } };
      const chk = { checked: true };
      const rangeBtn = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
      const rangeLabel = { textContent: '近 30 天' };
      const rangeInput = { value: '' };
      const mkItem = (days) => {
        const it = { dataset: { days }, active: days === '30' };
        it.classList = { toggle: (n, f) => { it.active = f; } };
        return it;
      };
      const rangeItems = [mkItem('7'), mkItem('30'), mkItem('90')];
      const rangeMenu = { hidden: true, querySelectorAll: (sel) => (sel === '.token-range-item' ? rangeItems : []) };
      const rangeWrap = { classList: { add: (c) => wrapCalls.add.push(c), remove: (c) => wrapCalls.remove.push(c) } };
      const prevDoc = sandbox.document;
      sandbox.document = {
        getElementById: (id) => (id === 'tokenDialog' ? dlg : id === 'tokenUsageBody' ? body
          : id === 'tokenUsageSplitChk' ? chk : id === 'tokenRefreshBtn' ? refreshBtn
          : id === 'tokenUsageRange' ? rangeWrap : id === 'tokenRangeMenu' ? rangeMenu
          : id === 'tokenRangeBtn' ? rangeBtn : id === 'tokenRangeLabel' ? rangeLabel
          : id === 'tokenRangeInput' ? rangeInput : null),
      };
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
      const okFetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true, status: 200, json: async () => fixture }; };
      const badFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
      const prevFetch = sandbox.fetch;
      const prevSignal = sandbox.AbortSignal;
      const prevToast = sandbox.toastMsg;
      const prevRender = sandbox.renderTokenUsage;
      sandbox.AbortSignal = { timeout: (ms) => ({ __timeoutMs: ms }) };
      sandbox.toastMsg = (msg) => toasts.push(msg);
      try {
        // 失败先行（空画布档）：占位文案＋toast，旧图不存在
        sandbox.fetch = badFetch;
        await sandbox.renderTokenUsage();
        if (!body.innerHTML.includes('读取失败')) throw new Error('空画布失败应落失败占位');
        if (!toasts.some(t => String(t).includes('用量统计读取失败'))) throw new Error('失败应 toast 提示');
        // 成功：恰好一次拉取、参数齐全、落终态
        sandbox.fetch = okFetch;
        await sandbox.renderTokenUsage();
        if (fetchCalls.length !== 1) throw new Error('应恰好拉取一次：' + fetchCalls.length);
        if (fetchCalls[0].url !== '/api/usage/stats?days=30&records=100') {
          throw new Error('默认范围应为 30 天＋明细 100 条：' + fetchCalls[0].url);
        }
        if (!fetchCalls[0].opts || fetchCalls[0].opts.cache !== 'no-cache' || !fetchCalls[0].opts.signal) {
          throw new Error('fetch 应带 cache:no-cache＋AbortSignal 超时');
        }
        if (fetchCalls[0].opts.signal.__timeoutMs !== 10000) throw new Error('超时应为 10000ms');
        if (!body.innerHTML.includes('token-summary-row') || !body.innerHTML.includes('每日 token 趋势')) {
          throw new Error('渲染产物缺汇总卡或折线卡');
        }
        if (btnCalls.add.includes('spinning') && !btnCalls.remove.includes('spinning')) {
          throw new Error('拉完应停转刷新图标');
        }
        sandbox.openTokenUsagePanel();
        if (!dlgCalls.add.includes('show')) throw new Error('开面板应加 .show');
        // 失败但有旧图档：旧图保留（不白屏）＋toast
        sandbox.fetch = badFetch;
        await sandbox.renderTokenUsage();
        if (!body.innerHTML.includes('token-summary-row')) throw new Error('已有旧图时失败不应清画布');
        if (!toasts.some(t => String(t).includes('用量统计读取失败'))) throw new Error('旧图档失败同样应 toast');
        // 切范围：90 天拉取（内部＋显式两连发，序号护栏只让最后一次落画）
        sandbox.fetch = okFetch;
        sandbox.setTokenUsageDays('90');
        await sandbox.renderTokenUsage();
        const last = fetchCalls[fetchCalls.length - 1];
        if (last.url !== '/api/usage/stats?days=90&records=100') throw new Error('切范围后应按 90 天拉取：' + last.url);
        const countAfterRange = fetchCalls.length;
        sandbox.toggleTokenUsageSplit();
        if (fetchCalls.length !== countAfterRange) throw new Error('切分线只应用缓存重画，不应重拉');
        if (!body.innerHTML.includes('token-summary-row')) throw new Error('切分线后应重渲染出内容');
        sandbox.closeTokenUsagePanel();
        if (!dlgCalls.remove.includes('show')) throw new Error('关面板应移除 .show');
        // 自绘下拉闭环：开合/aria/选中同步标签与 active/点选按新范围拉取/同值不重拉。
        // 与上面的拉取共用 fetchCalls：此刻处于 90 天，点 7 天应恰好新增一次 days=7。
        sandbox.toggleTokenRangeMenu();
        if (rangeMenu.hidden !== false) throw new Error('开菜单应去掉 hidden');
        if (!wrapCalls.add.includes('open')) throw new Error('wrap 应加 .open（箭头翻转钩子）');
        if (rangeBtn.attrs['aria-expanded'] !== 'true') throw new Error('aria-expanded 应为 true');
        sandbox.pickTokenRangeDays(7);
        if (rangeMenu.hidden !== true) throw new Error('选中后应收菜单');
        if (rangeLabel.textContent !== '近 7 天') throw new Error('触发钮标签应同步：' + rangeLabel.textContent);
        if (!rangeItems[0].active || rangeItems[1].active || rangeItems[2].active) throw new Error('active 应挪到 7 天项');
        const pickCalls = fetchCalls.slice(countAfterRange);
        if (pickCalls.length !== 1 || !String(pickCalls[0].url).includes('days=7')) {
          throw new Error('点选应按 7 天恰好再拉一次：' + pickCalls.map(c => c.url).join(','));
        }
        sandbox.pickTokenRangeDays(7);
        if (fetchCalls.length !== countAfterRange + 1) throw new Error('同值再点不应重拉');
        sandbox.toggleTokenRangeMenu();
        sandbox.toggleTokenRangeMenu();
        if (rangeMenu.hidden !== true) throw new Error('二次 toggle 应回到收起');
        // 自定义天数闭环（T198）：setTokenUsageDays 越界拒绝；输入行越界 toast＋
        // 不收菜单不拉取；45 天经输入行应用后按新范围拉取、标签同步、预设全不选中
        const beforeCustom = fetchCalls.length;
        const toastsBefore = toasts.length;
        sandbox.setTokenUsageDays('400');
        sandbox.setTokenUsageDays('0');
        if (fetchCalls.length !== beforeCustom) throw new Error('越界天数应被拒绝不拉取');
        rangeMenu.hidden = false; // 模拟菜单开着填输入
        rangeInput.value = '999';
        sandbox.applyTokenRangeCustom();
        if (rangeMenu.hidden !== false) throw new Error('越界输入不应收菜单');
        if (toasts.length !== toastsBefore + 1) throw new Error('越界输入应 toast 一次');
        if (!toasts[toasts.length - 1].includes('1–365')) throw new Error('toast 应说明范围');
        if (fetchCalls.length !== beforeCustom) throw new Error('越界输入不应拉取');
        rangeInput.value = '45';
        sandbox.applyTokenRangeCustom();
        if (rangeMenu.hidden !== true) throw new Error('合法输入应用后应收菜单');
        if (rangeLabel.textContent !== '近 45 天') throw new Error('标签应同步自定义天数：' + rangeLabel.textContent);
        if (rangeItems.some(it => it.active)) throw new Error('自定义天数下预设项应全不选中');
        const customCalls = fetchCalls.slice(beforeCustom);
        if (customCalls.length !== 1 || customCalls[0].url !== '/api/usage/stats?days=45&records=100') {
          throw new Error('45 天应恰好拉一次：' + customCalls.map(c => c.url).join(','));
        }
        return true;
      } finally {
        sandbox.document = prevDoc;
        sandbox.fetch = prevFetch;
        sandbox.AbortSignal = prevSignal;
        sandbox.toastMsg = prevToast;
        sandbox.renderTokenUsage = prevRender;
      }
    });

    check('token-usage：源码契约（fetch 必带 signal＋no-cache；自绘下拉/图标钮/动画注册在位；降亮延迟；圆环顶对齐）', () => {
      const src = fs.readFileSync('src/static/js/token-usage.js', 'utf8');
      const fetchSites = [...src.matchAll(/fetch\('\/api\/usage\/stats[^']*'/g)];
      if (fetchSites.length !== 1) throw new Error('应有且只有一处用量拉取：' + fetchSites.length);
      if (!src.includes("cache: 'no-cache'")) throw new Error('拉取应带 cache:no-cache');
      if (!src.includes('signal: AbortSignal.timeout(10000)')) throw new Error('拉取应带 10s AbortSignal');
      // 降亮必须延迟（用户反馈「切范围闪一下」的根因）：本地毫秒级返回时立即降亮
      // 刚上就摘，150ms opacity 过渡折返＝整板闪。add('token-refreshing') 只许在
      // setTimeout 回调里出现（源码里 add 位必须在 dimTimer 赋值位之后）。
      const dimAddAt = src.indexOf("add('token-refreshing')");
      const dimTimerAt = src.indexOf('dimTimer = setTimeout');
      if (dimAddAt < 0 || dimTimerAt < 0 || dimTimerAt > dimAddAt) {
        throw new Error('旧图降亮必须由 setTimeout 延迟触发（立即降亮＝切范围闪一下）');
      }
      if (!src.includes('TOKEN_REFRESH_DIM_DELAY')) throw new Error('降亮延迟阈值常量缺失');
      // 圆环顶对齐（用户反馈 7 天与 30/90 天「不同心」的根因）：图例行数随范围变，
      // 垂直居中会让圆环跟着图例高度上下挪位；必须 flex-start 锚在卡片顶。
      const panels = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
      const pieRow = panels.match(/\.token-usage-pie-row \{[^}]*\}/);
      if (!pieRow || !pieRow[0].includes('align-items: flex-start')) {
        throw new Error('圆环行必须顶对齐（align-items: flex-start），居中会随图例高度挪位');
      }
      if (!src.includes("window.openTokenUsagePanel = openTokenUsagePanel")) throw new Error('冒烟导出块缺失');
      if (!src.includes('window._tokenFormatMs')) throw new Error('耗时格式化未导出冒烟');
      if (!src.includes('window._tokenUsageSmoothPath')) throw new Error('平滑曲线函数未导出冒烟');
      if (!src.includes('window.pickTokenRangeDays')) throw new Error('自绘下拉未导出冒烟');
      if (!src.includes('prefers-reduced-motion')) throw new Error('过渡动画应尊重减少动态偏好');
      if (!src.includes('_tokenUsageFetchSeq')) throw new Error('快速连点范围应有拉取序号护栏');
      // 五轮契约（T196/T198/T199）：明细渲染/条数常量、折线 data-label、联动绑定、
      // 自定义天数 1-365、明细表与图例可点样式
      if (!src.includes('window._tokenUsageRecordsHtml')) throw new Error('调用明细渲染未导出冒烟');
      if (!src.includes('window.applyTokenRangeCustom')) throw new Error('自定义天数未导出冒烟');
      if (!src.includes('TOKEN_USAGE_RECORDS_LIMIT')) throw new Error('明细条数常量缺失');
      if (!src.includes('_bindTokenLegendPick')) throw new Error('圆环折线联动未实现');
      if (!src.includes('data-label="')) throw new Error('折线 path 缺 data-label（联动匹配键）');
      const fnDays = src.match(/function setTokenUsageDays[\s\S]{0,220}/) || [''];
      if (!/n >= 1 && n <= 365/.test(fnDays[0])) throw new Error('统计范围应放开到 1-365 天（T198）');
      if (!panels.includes('.token-records-row')) throw new Error('调用明细表样式缺失');
      if (!panels.includes('.token-donut-legend-pick')) throw new Error('图例可点样式缺失');
      if (!panels.includes('.token-range-custom')) throw new Error('自定义天数输入行样式缺失');
      // 失败/耗时记账链（2026-10-08）：后端有 record_failure 与新聚合键，四个调用
      // 文件都接线；前端明细表有耗时列
      const usageStatsSrc = fs.readFileSync('src/server/usage_stats.py', 'utf8');
      if (!usageStatsSrc.includes('def record_failure')) throw new Error('后端缺 record_failure');
      if (!usageStatsSrc.includes('errorRequests') || !usageStatsSrc.includes('avgDurationMs')) {
        throw new Error('聚合缺失败数/平均耗时');
      }
      if (!usageStatsSrc.includes('record_limit')) throw new Error('summarize 缺 records 明细支持（T196）');
      for (const py of ['src/server/models_routes.py', 'src/server/knowledge.py',
        'src/server/documents.py', 'harness/review.py']) {
        if (!fs.readFileSync(py, 'utf8').includes('record_failure')) throw new Error(py + ' 未接失败记账');
      }
      const html = fs.readFileSync('src/static/index.html', 'utf8');
      for (const needle of ['id="tokenDialog"', 'id="tokenUsageBody"', 'id="tokenUsageRange"', 'id="tokenRangeMenu"',
        'id="tokenRangeBtn"', 'id="tokenRefreshBtn"', 'data-days="7"', 'data-days="30"', 'data-days="90"',
        'pickTokenRangeDays(7)', 'toggleTokenRangeMenu()', 'toggleTokenUsageSplit()', 'aria-label="刷新"',
        'id="tokenRangeInput"', 'applyTokenRangeCustom()', 'min="1" max="365"']) {
        if (!html.includes(needle)) throw new Error('index.html 缺 ' + needle);
      }
      if (/<select[^>]*id="tokenUsage/.test(html)) throw new Error('统计范围不应退回原生 select');
      const buildSrc = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');
      if (!buildSrc.includes("'token-usage.js'")) throw new Error('构建 entries 未注册 token-usage.js');
      return true;
    });

    await drain();
  } finally {
    sandbox.escapeHtml = prevEscape;
  }
}
