import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
const root = new URL('../', import.meta.url);

// T181 重写（2026-10-08）：/graph/undo 端点已随 b7a7fcf 退役，原「pytest 经
// F5_REPLAY_FIXTURE 落回放夹具」机制随之消失（pytest 绿但不写文件，脚本
// ENOENT）。改按同提交的「直连 core 恢复链」口径：pytest 把关后，直接
// import 测试模块自身的 undo_fixture() 出数据、harness.core 现算 inverse ops，
// 再交前端 harness-apply.js 的 _applyOneHarnessOp 回放，逐字段断言无损恢复。
const gate = spawnSync('python3', ['-m', 'pytest', 'tests/test_review_harness_f5.py', '-q'],
  { cwd: root, encoding: 'utf8' });
assert.equal(gate.status, 0, gate.stdout + gate.stderr);

const dump = spawnSync('python3', ['-c', [
  'import json, sys',
  "sys.path.insert(0, 'src')  # 裸 python3 -c 不跑 conftest，与 tests/conftest.py 同款补 src",
  'from tests.test_review_harness_f5 import undo_fixture',
  'from harness.core import build_inverse_ops, build_next_snapshot, normalize_snapshot',
  'before, operations, after = undo_fixture()',
  'current = normalize_snapshot(after)',
  'inverse = build_inverse_ops(before, operations, current)',
  'result = build_next_snapshot(current, inverse)',
  'print(json.dumps({"before": before, "operations": operations, "after": after, "result": result}))',
].join('\n')], { cwd: root, encoding: 'utf8' });
assert.equal(dump.status, 0, dump.stdout + dump.stderr);
const fixture = JSON.parse(dump.stdout);
assert.ok(fixture.result.operations.some(op => op.op === 'restore_node'),
  JSON.stringify(fixture.result));

const s = { console, window: {}, _edgeParts: () => null,
  _edgeKey: e => `${e.from}:${e.fromPort || 'out-0'}->${e.to}:${e.toPort || 'in-0'}` };
vm.createContext(s);
const applySource = fs.readFileSync(new URL('src/static/js/harness-apply.js', root), 'utf8');
vm.runInContext(applySource.slice(0, applySource.indexOf('  async function _generateHarnessCreatedContent')), s);
const state = { customNodes: structuredClone(fixture.after.nodes), connections: structuredClone(fixture.after.edges),
  harnessDeleted: { eval: true }, harnessNodeOverrides: {}, positions: {}, sizes: {}, pinned: {}, inputPortCounts: {}, removedEdges: [] };
for (const op of fixture.result.operations) s._applyOneHarnessOp(op, state, new Map());
for (const original of fixture.before.nodes) {
  assert.deepEqual(JSON.parse(JSON.stringify(state.customNodes.find(n => n.id === original.id))), original);
}
assert.equal(state.harnessDeleted.eval, undefined);
assert.equal(state.connections.length, fixture.before.edges.length);
console.log('PASS core undo chain → frontend restore_node replay: complete node fields, ai_eval, formulas, positions, edges');
