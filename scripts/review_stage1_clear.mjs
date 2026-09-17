import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../src/static/js/', import.meta.url);
const memory = fs.readFileSync(new URL('memory.js', root), 'utf8');
const ui = fs.readFileSync(new URL('ui.js', root), 'utf8');
// Load the actual export function without unrelated UI startup side effects.
const exportSource = ui.slice(ui.indexOf('async function exportData('), ui.indexOf('\nfunction _normalizeBackup('));
for (const outcome of ['success', 'reject', 'http-failure', 'missing-profiles']) {
  let resolveExport, rejectExport;
  const pending = new Promise((resolve, reject) => { resolveExport = resolve; rejectExport = reject; });
  const calls = [], downloads = [], nodes = new Map();
  const profile = { enabled: true, facts: [], pending: [], archive: [] };
  const s = { console: { warn() {} }, setTimeout() {}, getDeviceId: () => 'isolated', escapeHtml: String,
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { checked: true, classList: { add() {}, remove() {} } });
      return nodes.get(id);
    } }, localStorage: { removeItem() {} },
    fetch: async (url, opts = {}) => {
      if (url === '/api/backup/export') { calls.push('export'); return pending; }
      if (opts.method === 'DELETE') calls.push('delete:' + url);
      return { ok: true, json: async () => profile };
    },
    _collectLocalBackup: () => ({ sessions: {}, messages: {}, knowledge: {}, formulas: {}, graphs: {} }),
    _mergeMaps: (a, b) => ({ ...a, ...b }), _pickNewerQuizBank: (a, b) => b || a,
    _downloadBackup: data => { calls.push('download'); downloads.push(JSON.parse(JSON.stringify(data))); },
  };
  s.window = s; vm.createContext(s);
  vm.runInContext(exportSource, s);
  vm.runInContext(memory, s);
  await s.memoryRefreshCache();
  const clearing = s.memoryConfirmClear();
  await Promise.resolve();
  assert.deepEqual(calls, ['export'], 'DELETE must wait for export response');
  if (outcome === 'reject') rejectExport(new Error('offline'));
  else resolveExport({ ok: outcome !== 'http-failure', status: 503,
    json: async () => outcome === 'missing-profiles' ? {} : { profiles: { isolated: { facts: [{ fact: 'keep' }] } }, kv: {} } });
  await clearing;
  if (outcome === 'success') {
    assert.equal(downloads[0].profiles.isolated.facts[0].fact, 'keep');
    assert.deepEqual(calls, ['export', 'download', 'delete:/api/profile?device_id=isolated', 'delete:/api/sessions']);
  } else {
    assert.deepEqual(calls, ['export'], 'failed backup must not download or delete');
    assert.match(nodes.get('modelToast').textContent, /中止清除/);
  }
  console.log('PASS actual export + clear:', outcome);
}
