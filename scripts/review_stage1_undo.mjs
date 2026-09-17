import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = new URL('../', import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phymathia-undo-'));
try {
  const fixturePath = path.join(dir, 'undo.json');
  const python = spawnSync('python3', ['-m', 'pytest', 'tests/test_review_harness_f5.py', '-q'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, F5_REPLAY_FIXTURE: fixturePath }
  });
  assert.equal(python.status, 0, python.stdout + python.stderr);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
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
  console.log('PASS actual HTTP undo → frontend restore_node: complete node fields, ai_eval, formulas, positions, edges');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
