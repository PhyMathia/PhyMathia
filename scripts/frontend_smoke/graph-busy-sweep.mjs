// 生成中断电清扫（T275，2026-10-11）：生成入口「先存 busy='running' 再发请求」，
// 页面中途被关后持久层残留「生成中」无人复位，重启后节点永久转圈且点不动。
// 回归三面：清洗助手口径、启动清扫（本地＋服务端镜像覆写＋历史键跳过）、
// 历史版本回放入口接清洗（静态契约）。
import { check, drain, sandbox, localStorage, storageData, fs } from './_runner.mjs';

export async function run() {
  check('T275: _sanitizeStaleBusyCustomNodes 剥 busy/running、其余原样、不改入参', () => {
    if (typeof sandbox._sanitizeStaleBusyCustomNodes !== 'function') throw new Error('清洗助手未暴露');
    const list = [
      { id: 'a', kind: 'human_note', busy: true, status: 'running' },
      { id: 'b', kind: 'human_note', busy: false, status: 'running' },
      { id: 'c', kind: 'human_note', busy: true, status: 'done' },
      { id: 'd', kind: 'human_note', busy: false, status: 'error' },
      { id: 'e', kind: 'junction', status: 'waiting' },
    ];
    const out = sandbox._sanitizeStaleBusyCustomNodes(list);
    if (out[0].busy !== false || out[0].status !== '') return false;
    if (out[1].busy !== false || out[1].status !== '') return false;
    if (out[2].busy !== false || out[2].status !== 'done') return false;
    if (out[3].status !== 'error') return false;
    if (out[4].status !== 'waiting') return false;
    // 历史快照是共享对象：必须返回新数组，入参原样保留
    if (list[0].busy !== true || list[0].status !== 'running') return false;
    if (sandbox._sanitizeStaleBusyCustomNodes(undefined) !== undefined) return false;
    // 无脏数据的列表原引用返回（不空拷贝）
    const untouched = [{ id: 'x', kind: 'junction', status: 'done' }];
    if (sandbox._sanitizeStaleBusyCustomNodes(untouched) !== untouched) return false;
    return true;
  });

  check('T275: 启动清扫洗活图键＋覆写服务端镜像＋跳过历史键', () => {
    if (typeof sandbox._sweepStaleBusyGraphKeys !== 'function') throw new Error('启动清扫未暴露');
    const sid = 'sess_sweep_t274';
    const graphKey = 'phymathia_graph_' + sid;
    const histKey = 'phymathia_graph_history_' + sid;
    storageData[graphKey] = JSON.stringify({
      customNodes: [
        { id: 'k1', kind: 'human_note', busy: true, status: 'running' },
        { id: 'k2', kind: 'blank', busy: false, status: 'done' },
      ],
      updatedAt: 123,
    });
    storageData[histKey] = JSON.stringify([{ state: { customNodes: [{ id: 'h1', busy: true, status: 'running' }] } }]);
    const posts = [];
    const realFetch = sandbox.fetch;
    // T360 起镜像回写走合并通道（_postGraphState），沙箱要补 AbortSignal 才走得过去
    const realAbortSignal = sandbox.AbortSignal;
    sandbox.AbortSignal = { timeout: () => undefined };
    sandbox.fetch = (url, opts) => { posts.push({ url, opts }); return realFetch(url, opts); };
    try {
      sandbox._sweepStaleBusyGraphKeys();
    } finally {
      sandbox.fetch = realFetch;
      sandbox.AbortSignal = realAbortSignal;
    }
    const swept = JSON.parse(localStorage.getItem(graphKey));
    if (swept.customNodes[0].busy !== false || swept.customNodes[0].status !== '') return false;
    if (swept.customNodes[1].busy !== false || swept.customNodes[1].status !== 'done') return false;
    if (swept.updatedAt !== 123) return false;
    // 服务端镜像被覆写成净值（否则切会话「服务端较新」分支把脏数据盖回来）
    if (posts.length !== 1) return false;
    if (posts[0].url !== '/api/kv/' + encodeURIComponent('graph:' + sid)) return false;
    const body = JSON.parse(posts[0].opts.body);
    if (body.value.customNodes[0].busy !== false || body.value.customNodes[0].status !== '') return false;
    // T360：这条回写必须走合并通道（带 graph_merge）——直连整份 POST 正是「旧设备开机
    // 触发清扫、一次回写抹掉另一台设备内容」的那条路
    if (!body.graph_merge || typeof body.graph_merge.base_node_sigs !== 'object') {
      throw new Error('启动清扫的镜像回写没走合并通道');
    }
    // 历史快照键必须原样（回放时有 _restoreGraphVersion 兜底，启动不重写大数组）
    const hist = JSON.parse(localStorage.getItem(histKey));
    if (hist[0].state.customNodes[0].busy !== true) return false;
    delete storageData[graphKey];
    delete storageData[histKey];
    return true;
  });

  check('T275: _restoreGraphVersion 回放落盘前必须过清洗（静态契约）', () => {
    const src = fs.readFileSync('src/static/js/graph.js', 'utf8');
    const start = src.indexOf('async function _restoreGraphVersion');
    const end = src.indexOf('async function _undoGraphAction');
    if (start === -1 || end === -1 || end <= start) throw new Error('找不到 _restoreGraphVersion 段');
    const seg = src.slice(start, end);
    if (!seg.includes('_sanitizeStaleBusyCustomNodes')) throw new Error('回放未接清洗助手');
    return true;
  });

  await drain();
}
