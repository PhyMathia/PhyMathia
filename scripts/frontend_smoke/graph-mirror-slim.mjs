// 服务端镜像体量治理（T212，2026-10-11）：镜像序列化「只减重、绝不删条目」——
// 最新 60 条全量、更老的原位换 pruned 占位（条数与顺序不动），读回 hydrate
// 丢弃无 state 的占位。回归四面：减重助手口径、窗口内零开销、调度→落 POST
// 全链（沙箱 fetch 捕包）、读回水合丢弃。
import { check, drain, sandbox } from './_runner.mjs';

export async function run() {
  check('T212: _graphHistoryMirrorSlim 最新窗口全量、更老原位占位、条数顺序不变', () => {
    if (typeof sandbox._graphHistoryMirrorSlim !== 'function') throw new Error('减重助手未暴露');
    const big = [];
    for (let i = 0; i < 80; i++) {
      big.push({ sessionId: 's', state: { i: i }, meta: { summary: 'op' + i, ts: i } });
    }
    const out = sandbox._graphHistoryMirrorSlim(big);
    if (!Array.isArray(out) || out.length !== 80) return false;
    for (let i = 0; i < 80; i++) {
      if (i < 20) {
        if (!out[i].pruned || out[i].state !== undefined) return false;
        if (out[i].sessionId !== 's') return false;
        if (!out[i].meta || out[i].meta.summary !== 'op' + i) return false;
      } else if (out[i] !== big[i]) return false; // 窗口内原对象原样（不拷贝）
    }
    // 入参绝不就地改（内存栈共享对象）
    if (big[0].state === undefined || big[0].pruned) return false;
    return true;
  });

  check('T212: 窗口内数组原引用返回（小会话零开销）', () => {
    const arr = [{ sessionId: 's', state: { a: 1 }, meta: null }];
    if (sandbox._graphHistoryMirrorSlim(arr) !== arr) return false;
    if (sandbox._graphHistoryMirrorSlim(null) !== null) return false;
    return true;
  });

  check('T212: 调度→落盘全链 POST 的是减重后的净值', () => {
    const sid = 'sess_mirror_t212';
    const big = [];
    for (let i = 0; i < 80; i++) {
      big.push({ sessionId: sid, state: { i: i }, meta: { summary: 'op' + i, ts: i } });
    }
    const posts = [];
    const realFetch = sandbox.fetch;
    sandbox.fetch = (url, opts) => { posts.push({ url, opts }); return realFetch(url, opts); };
    try {
      sandbox._scheduleGraphHistoryMirror(sid, big);
      sandbox._flushGraphHistoryMirror();
    } finally {
      sandbox.fetch = realFetch;
    }
    if (posts.length !== 1) return false;
    if (posts[0].url !== '/api/kv/graph_history:' + sid) return false;
    const body = JSON.parse(posts[0].opts.body);
    if (body.value.length !== 80) return false;
    if (!body.value[0].pruned || body.value[0].state !== undefined) return false;
    if (body.value[79].state.i !== 79) return false;
    return true;
  });

  check('T212: 读回水合丢弃 pruned 占位（撤销窗口＝全量条数，棘轮泄掉）', () => {
    const slim = sandbox._graphHistoryMirrorSlim(
      Array.from({ length: 80 }, (_, i) => ({ sessionId: 's', state: { i: i }, meta: null })));
    const stack = sandbox._graphHistoryHydrate(JSON.parse(JSON.stringify(slim)));
    if (stack.length !== 60) return false;
    if (stack[0].state.i !== 20) return false;
    return true;
  });

  await drain();
}
