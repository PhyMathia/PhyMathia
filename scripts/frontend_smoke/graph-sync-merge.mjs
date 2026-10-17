// 画布图状态跨设备合并（T360，2026-10-17）：旧口径是整图 updatedAt 定胜负 + 任意保存
// 全量覆写，旧设备平移一下就把另一台设备刚生成的节点内容整图抹掉。新口径＝保存随包带
// base 版本与各节点内容签名，服务端按节点三方合并（规则见 tests/test_graph_merge.py）。
// 本域回归前端这一半：签名口径（视图字段不参与）、随包载荷（base/墓碑/回收）、
// 保存响应回传的 updatedAt 成为下一次的 base。
import { check, drain, sandbox } from './_runner.mjs';

export async function run() {
  check('T360: 节点签名只认内容字段——挪坐标/折叠/最小化不算改动', () => {
    const base = { id: 'n1', kind: 'module', content: '正文', status: 'done', x: 10, y: 20, w: 100, h: 40 };
    const moved = { ...base, x: 999, y: -5, w: 320, h: 200, minimized: true };
    if (sandbox._graphNodeSig(base) !== sandbox._graphNodeSig(moved)) return false;
    // 键序不影响签名（同一颗节点跨设备写入顺序可能不同）
    const reordered = { h: 40, w: 100, y: 20, x: 10, status: 'done', content: '正文', kind: 'module', id: 'n1' };
    if (sandbox._graphNodeSig(base) !== sandbox._graphNodeSig(reordered)) return false;
    // 内容/状态/账本变了必须变
    if (sandbox._graphNodeSig(base) === sandbox._graphNodeSig({ ...base, content: '正文二' })) return false;
    if (sandbox._graphNodeSig(base) === sandbox._graphNodeSig({ ...base, status: 'running' })) return false;
    if (sandbox._graphNodeSig(null) !== '' || sandbox._graphNodeSig('x') !== '') return false;
    return true;
  });

  check('T360: 随包载荷——本次签名、base 签名、删除墓碑、过期回收', () => {
    const now = Date.now();
    const state = {
      customNodes: [{ id: 'a', kind: 'module', content: 'A' }, { id: 'c', kind: 'module', content: 'C' }],
      nodeSigs: {
        a: sandbox._graphNodeSig({ id: 'a', kind: 'module', content: 'A' }),
        b: 'sig-b-旧签名',                       // 上次同步时还在、现在没了＝本设备删了它
        old: { d: now - 40 * 24 * 3600 * 1000 },  // 过期墓碑（>30 天）
        fresh: { d: now - 1000 },                 // 未过期墓碑
      },
    };
    const prevSigs = state.nodeSigs;
    const merge = sandbox._graphSyncMergePayload('sess_t360_sig', state);
    if (!merge || typeof merge !== 'object') throw new Error('没返回合并信息');
    // base 就是上一份签名表（服务端据此判断「本端改没改」）
    if (merge.base_node_sigs !== prevSigs) throw new Error('base_node_sigs 不是上一份签名表');
    if (!merge.base_node_sigs || typeof merge.base_node_sigs !== 'object') {
      throw new Error('base_node_sigs 必须是签名表（服务端只按它判「谁改过」）');
    }
    const sigs = state.nodeSigs;   // 就地改写
    if (Object.keys(sigs).length !== 4) throw new Error('签名表条目数不对：' + Object.keys(sigs).join(','));
    if (!sigs.a || typeof sigs.a !== 'string') return false;
    if (!sigs.c || typeof sigs.c !== 'string') return false;
    if (!sigs.b || Number(sigs.b.d) <= 0) return false;         // 删除墓碑（带时间戳）
    if (sigs.old !== undefined) return false;                   // 过期墓碑回收
    if (!sigs.fresh || sigs.fresh.d !== now - 1000) return false; // 未过期墓碑继续带着
    return true;
  });

  check('T360: 保存随包带 graph_merge，第二次的 base 就是第一次那份签名表', async () => {
    const realAbortSignal = sandbox.AbortSignal;
    const realFetch = sandbox.fetch;
    const sid = 'sess_t360_flush';
    const url = '/api/kv/' + encodeURIComponent('graph:' + sid);
    const posts = [];
    sandbox.AbortSignal = { timeout: () => undefined };   // 沙箱无 AbortSignal（真实浏览器有）
    sandbox.fetch = async (u, opts) => {
      posts.push({ url: u, opts });
      return { ok: true, status: 200, json: async () => ({ ok: true, merged: true, updatedAt: 424242 }) };
    };
    try {
      const value = {
        customNodes: [{ id: 'x1', kind: 'module', content: '内容' }],
        nodeSigs: {},
        updatedAt: 111,
      };
      await sandbox.window.postGraphStateMerged(sid, value);
      const mine = posts.filter(p => p.url === url);
      if (mine.length !== 1) throw new Error('期望一次保存，实到 ' + mine.length);
      const body = JSON.parse(mine[0].opts.body);
      if (!body.graph_merge) throw new Error('保存没带合并信息（服务端只能整图覆盖）');
      if (!body.value.nodeSigs || typeof body.value.nodeSigs.x1 !== 'string') return false;
      if (!body.graph_merge.base_node_sigs || typeof body.graph_merge.base_node_sigs !== 'object') return false;
      // 第二次保存：base 就是第一次那份签名表（服务端据此判「这次到底谁改过」）
      await sandbox.window.postGraphStateMerged(sid, value);
      const second = JSON.parse(posts.filter(p => p.url === url)[1].opts.body);
      if (!second.graph_merge.base_node_sigs
        || second.graph_merge.base_node_sigs.x1 !== body.value.nodeSigs.x1) return false;
    } finally {
      sandbox.AbortSignal = realAbortSignal;
      sandbox.fetch = realFetch;
    }
    return true;
  });

  await drain();
}
