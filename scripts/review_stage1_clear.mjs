import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../src/static/js/', import.meta.url);
const memory = fs.readFileSync(new URL('memory.js', root), 'utf8');
// T261（2026-10-10）起 exportData/_normalizeBackup 住在 ui-backup.js（自 ui.js 纯搬家）
const ui = fs.readFileSync(new URL('ui-backup.js', root), 'utf8');
// Load the actual export function without unrelated UI startup side effects.
const exportSource = ui.slice(ui.indexOf('async function exportData('), ui.indexOf('\nfunction _normalizeBackup('));
for (const outcome of ['success', 'reject', 'http-failure', 'missing-profiles']) {
  let resolveExport, rejectExport;
  const pending = new Promise((resolve, reject) => { resolveExport = resolve; rejectExport = reject; });
  const calls = [], downloads = [], nodes = new Map();
  const profile = { enabled: true, facts: [], pending: [], archive: [] };
  const s = { console: { warn() {} }, setTimeout() {}, getDeviceId: () => 'isolated', escapeHtml: String,
    // 只切 exportData 源码（不含 config.js）：补查阅态判据的缺省实现——
    // exportData 的查阅闸门要问 phyIsReadonly（真实页面由 config.js 提供），
    // 夹具恒 false＝非查阅态，导出/清除链路的断言照常跑
    phyIsReadonly: () => false,
    document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { checked: true, classList: { add() {}, remove() {} } });
      return nodes.get(id);
    } }, localStorage: { removeItem() {} },
    fetch: async (url, opts = {}) => {
      // 前缀匹配（85b709d 起导出 URL 带 ?device_id=…，全等比较自那时起恒不命中——
      // 套件一直红着，2026-10-07 修复）
      if (String(url).indexOf('/api/backup/export') === 0) { calls.push('export'); return pending; }
      if (opts.method === 'DELETE') calls.push('delete:' + url);
      return { ok: true, json: async () => profile };
    },
    _collectLocalBackup: () => ({ sessions: {}, messages: {}, knowledge: {}, formulas: {}, graphs: {} }),
    // 584（2026-11-24）起 exportData 改用「按时间取新」的合并助手，旧的 _mergeMaps
    // 不再被导出链调用——夹具漏补导致 _mergeNewerMap is not defined，异常被
    // exportData 的 catch 吞成降级本机快照，profiles 变空后 :47 才 TypeError（590）。
    // 本脚本只验「先导出成功再清除」的时序，合并语义由 test_backup_safety 覆盖。
    _mergeMaps: (a, b) => ({ ...a, ...b }),
    _mergeNewerMap: (a, b) => ({ ...a, ...b }),
    _mergeMessageMaps: (a, b) => ({ ...a, ...b }),
    _pickNewerQuizBank: (a, b) => b || a,
    // 585（2026-11-24）导出回执要用：缺这两个助手时 exportData 会在下载后抛错，
    // memoryConfirmClear 把它当备份失败而中止清除（同 590 的第二种漂移）。
    _backupCounts: () => ({ sessions: 0, messages: 0 }),
    _formatBackupBytes: n => String(n),
    _showExportResult: () => {},
    _downloadBackup: data => {
      calls.push('download'); downloads.push(JSON.parse(JSON.stringify(data)));
      return { filename: 'backup.json', bytes: 1 };
    },
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
