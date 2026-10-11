// 串行边界：模型配置服务端同步（T284，2026-10-11 拆出）
// model-update 用例体自 models-viz.mjs 挪来：T284 起 fetchModels 真异步（含
// await syncModelsConfigFromServer()），用例共享 phymathia_user_models 键且会
// await——按串行边界契约（见 AGENTS.md / 各分域文件头注）放 serial-*.mjs，
// 段尾 drain() 收口后才放行下一段，杜绝 await 窗口里后续用例插改共享沙箱状态。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export async function run() {
check('model-update：_applyModelListDiff（新增入库 + 移除条目 + 悬空槽位清理 + 幂等）', async () => {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.localStorage.removeItem('phymathia_active_models');
  sandbox.localStorage.removeItem('phymathia_models_synced_at');
  sandbox.loadUserModels();
  const goPreset = sandbox.window.MODEL_PRESETS['opencode-go'];
  const seeded = sandbox.addModelsForProvider('opencode-go', 'sk-upd', goPreset.baseUrl, [
    { model: 'm-keep', label: '保留模型' }, { model: 'm-stale', label: '已下线模型' },
  ]);
  if (seeded !== 2) throw new Error('播种 2 条应全部入库，实际 ' + seeded);
  const stale = sandbox.getAllModels().find(m => m.provider === 'opencode-go' && m.name.includes('已下线模型'));
  if (!stale) throw new Error('播种条目未找到');
  // 主模型槽位指向将被移除的条目，应用后必须被清空（deleteUserModel 的悬空引用清理）
  sandbox.localStorage.setItem('phymathia_active_models', JSON.stringify({ agent_model: stale.id, html_model: '', descriptor_model: '', quiz_model: '', graph_model: '', branch_model: '' }));
  await sandbox.fetchModels(); // T284 起含 await syncModelsConfigFromServer()，必须 await 到位再断言
  const res = sandbox._applyModelListDiff('opencode-go', goPreset.baseUrl, [{ model: 'm-new', label: '上游新增' }], ['m-stale']);
  if (res.added !== 1 || res.removed !== 1) throw new Error('应用结果不符: ' + JSON.stringify(res));
  const names = sandbox.getAllModels().filter(m => m.provider === 'opencode-go').map(m => m.name);
  if (names.length !== 2) throw new Error('应用后应剩 2 条: ' + names.join(','));
  if (!names.some(s => s.includes('保留模型')) || !names.some(s => s.includes('上游新增'))) throw new Error('保留/新增条目缺失: ' + names.join(','));
  if (JSON.parse(sandbox.localStorage.getItem('phymathia_active_models')).agent_model !== '') throw new Error('指向已移除条目的槽位未清空');
  const again = sandbox._applyModelListDiff('opencode-go', goPreset.baseUrl, [{ model: 'm-new', label: '上游新增' }], ['m-stale']);
  if (again.added !== 0 || again.removed !== 0) throw new Error('重复应用应零变更: ' + JSON.stringify(again));
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.localStorage.removeItem('phymathia_active_models');
  sandbox.localStorage.removeItem('phymathia_models_synced_at');
  return true;
});
await drain(); // 串行边界收口：本段全部用例结算完才放行下一段
}
