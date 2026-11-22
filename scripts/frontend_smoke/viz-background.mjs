// viz 后台通道（2026-11-22，backlog 504 子集）冒烟守卫。
// 全同步用例：①源码级静态契约（开关/上限/快照/独立任务行/取消/总闸/构建顺序）；
// ②沙箱行为（可视节点判定、开关读写、上限、取消幂等、同节点重开先取消旧任务）。
// 端到端（viz 后台时新提问秒开、刷新双线续跑、两条停止互不串台）在真机档
// scripts/review_tasks_e2e.mjs / verify_stream_interrupt_persist.mjs。
import fs from 'node:fs';
import { check, sandbox, vm } from './_runner.mjs';

function _read(path) { return fs.readFileSync('src/static/js/' + path, 'utf8'); }

export async function run() {
  check('viz 后台通道静态契约：接线全在（源码级）', () => {
    const bg = _read('viz-background.js');
    const run = _read('graph-workflow-run.js');
    const gen = _read('graph-workflow-generate.js');
    const stream = _read('graph-workflow-stream.js');
    const entry = _read('graph-workflow-entry.js');
    const interact = _read('graph-interact.js');
    const tasks = _read('tasks.js');
    const build = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');

    if (!/const VIZ_BG_MAX = 2/.test(bg)) throw new Error('viz 后台并发上限不是 2');
    if (!/VIZ_BG_ENABLED_KEY = 'phymathia_viz_background_enabled'/.test(bg)) {
      throw new Error('viz 后台开关键不对');
    }
    // 独立任务行 + 独立 controller：不碰前台 6 开关
    if (!bg.includes("kind: 'viz-bg'") || !bg.includes('title: \'生成交互可视化（后台）\'')) {
      throw new Error('viz-bg 任务行没建或标题不对');
    }
    if (!bg.includes('new AbortController()') || !bg.includes('vizBgCancelAll')) {
      throw new Error('viz 后台没有独立 abort 或总闸');
    }
    // 节点带 nodeId：484 收编靠它认领被中断的 viz-bg 行
    if (!bg.includes('nodes: [{ id: String(node.id), label: \'交互可视化\'')) {
      throw new Error('viz-bg 任务行没带 nodeId，484 刷新后无法认领');
    }
    // 约束①：快照冻结 prompt/context/session/槽位
    for (const frag of ['_buildWorkflowContextForNode(node)', '_workflowPromptForNode(node',
      'getActiveModelForRole(_bg.snapshot.slotRole)', 'snapshot.sid']) {
      if (!gen.includes(frag)) throw new Error('生成链没读 viz 快照：' + frag);
    }
    if (!bg.includes('function _vizBgSnapshot(node)')) throw new Error('没有开跑快照函数');
    // 约束②：进度不串前台胶囊；后台不进节点级排队闸
    if (!stream.includes('if (!_bg) _scheduleWorkflowStreamProgress(content.length)')) {
      throw new Error('viz 后台进度串到了前台胶囊');
    }
    if (!gen.includes('if (!_bg && typeof _nodeGenBegin') || !gen.includes('if (!_bg && typeof _nodeGenEnd')) {
      throw new Error('viz 后台仍进节点级排队闸');
    }
    // 约束③：重开前取消旧 484 任务
    if (!bg.includes('_vizBgCancelOldServerTask(node)')) {
      throw new Error('viz 重开前没取消旧 484 任务');
    }
    // 调度器：叶子 viz 走后台、发射后立即返回；有下游的原地跑
    if (!run.includes('function _vizBgIsLeaf(node, subgraph)')) throw new Error('调度器没有 viz 叶子判定');
    if (!run.includes('const launched = vizBgLaunch(node, { force: !!force })')) {
      throw new Error('调度器没接 vizBgLaunch');
    }
    if (!/subgraph\.edges \|\| \[\]\)\.some\(edge => edge\.from === node\.id\)/.test(run)) {
      throw new Error('有下游的 viz 没排除在后台通道外');
    }
    // 两个入口：单节点按钮 + 总闸
    if (!interact.includes('vizBgLaunchMessage(nodeId, _run')) throw new Error('单节点 viz 按钮没接后台通道');
    if (!entry.includes('vizBgCancelAll()')) throw new Error('总闸没停后台 viz');
    // 任务行跨刷新保留 kind
    if (!tasks.includes("item.kind === 'viz-bg' ? 'viz-bg'")) throw new Error('viz-bg 行跨刷新丢了 kind');
    // 构建顺序：viz-background 必须在 generate 之后、run 之前
    const bgAt = build.indexOf("'viz-background.js'");
    const genAt = build.indexOf("'graph-workflow-generate.js'");
    const runAt = build.indexOf("'graph-workflow-run.js'");
    if (!(bgAt > 0 && genAt > 0 && runAt > 0 && bgAt < runAt)) {
      throw new Error('viz-background.js 没进构建顺序或位置不对');
    }
  });

  check('viz 后台通道：节点判定 / 开关 / 上限 / 取消幂等（沙箱）', () => {
    const code = _read('viz-background.js');
    const cancelCalls = [];
    // 独立 context：viz-background.js 顶层有 const（VIZ_BG_MAX 等），不能塞进共享 sandbox
    // 重复声明；本用例只读纯函数，不碰 window 桩，用完即弃不跨域传染。
    const ctx = vm.createContext({
      localStorage: (() => {
        const m = new Map();
        return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
      })(),
      _cancelServerGeneration: (id) => { cancelCalls.push(id); },
      _taskCreate: () => ({ id: 'task_viz_1' }),
      _taskBindCancel: () => {},
      _taskMarkRunning: () => {},
      _taskFinish: () => {},
      _findGraphNodeTail: () => ({ status: 'done', content: '<html>ok</html>' }),
      AbortController,
      Promise,
      setTimeout,
    });
    vm.runInContext(code, ctx);

    if (!ctx._vizBgIsVizNode({ kind: 'module', moduleKey: 'viz' })) throw new Error('官方 viz 节点没认出');
    if (!ctx._vizBgIsVizNode({ recipeId: 'r', recipe: { content_kind: 'html_iframe' } })) {
      throw new Error('html_iframe 配方 viz 没认出');
    }
    if (ctx._vizBgIsVizNode({ kind: 'module', moduleKey: 'physics' })) throw new Error('非 viz 节点误认');

    if (!ctx.vizBgEnabled()) throw new Error('开关缺省应为开');
    ctx.vizBgSetEnabled(false);
    if (ctx.vizBgEnabled()) throw new Error('开关关掉没生效');
    ctx.vizBgSetEnabled(true);

    // 取消未知节点：无害返回 false（幂等，不抛）
    if (ctx.vizBgCancel('nope') !== false) throw new Error('取消未知节点不该返回 true');
    // 同节点重开前先取消旧 484 任务
    ctx._vizBgCancelOldServerTask({ id: 'n', genTaskId: 'old-gen-id' });
    if (cancelCalls[0] !== 'old-gen-id') throw new Error('重开前没 DEL 旧 484 任务');
  });
}
