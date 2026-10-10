// 本地多账号＋只读查阅＋悬空自愈（T185–T187）＋回收站防误删面板（尾部含收口线；回收站用例复用账号夹具 _accountPanelContext，故同文件）
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 8336–8971 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export async function run() {
// ===== 本地多账号（P2 2026-10-07）：键前缀纯函数 / 垫片 / fetch 包装 / 面板渲染 =====
// 全程不改主沙箱共享键、不 await——不需要进串行边界段。

check('多账号：accountLsPrefix 纯函数（default 空=零迁移契约，非 default u前8位_）', () => {
  if (typeof sandbox.accountLsPrefix !== 'function') throw new Error('accountLsPrefix 未定义');
  if (sandbox.accountLsPrefix('default') !== '') throw new Error('default 前缀必须为空（零迁移）');
  if (sandbox.accountLsPrefix('abcd1234efgh') !== 'uabcd1234_') throw new Error('非 default 前缀应为 u<id前8位>_');
  // 非法 id（穿越串/空）一律空前缀，与内联主题脚本、服务端白名单同口径
  for (const bad of ['', '../evil', 'a b', 'x'.repeat(65)]) {
    if (sandbox.accountLsPrefix(bad) !== '') throw new Error('非法 id 应回落空前缀：' + bad);
  }
  if (vm.runInContext('ACCOUNT_LS_PREFIX', sandbox) !== '' || vm.runInContext('ACCOUNT_ID', sandbox) !== 'default') throw new Error('主沙箱无账号指针应为 default/空前缀');
  if (typeof sandbox.lsKeys !== 'function') throw new Error('lsKeys 未定义');
  return true;
});

// 独立上下文：真枚举语义的 FakeStorage（key/length），跑 config.js 源码装垫片
function _accountVmContext(pointer, seed = {}) {
  const store = new Map(Object.entries(seed));
  class FakeStorage {
    get length() { return store.size; }
    key(i) { return Array.from(store.keys())[i] ?? null; }
    getItem(k) { return store.has(k) ? store.get(k) : null; }
    setItem(k, v) { store.set(String(k), String(v)); }
    removeItem(k) { store.delete(k); }
  }
  const s = { console, URLSearchParams: URL, TextEncoder, TextDecoder };
  s.localStorage = new FakeStorage();
  if (pointer) s.localStorage.setItem('phymathia_account', pointer);
  s.window = s;
  s.innerWidth = 1200;
  s.document = { documentElement: { setAttribute() {} }, getElementById: () => null };
  vm.createContext(s);
  vm.runInContext(fs.readFileSync('src/static/js/config.js', 'utf8'), s, { filename: 'config.js' });
  return { s, store };
}

// accounts.js 在独立上下文里跑（行渲染纯函数用真字符串 escapeHtml 验证转义）
function _accountPanelContext() {
  const { s } = _accountVmContext(null);
  vm.runInContext(
    'function escapeHtml(t){return String(t==null?"":t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}'
    + 'function toastMsg(){}', s);
  s.location = { reload() {} };
  vm.runInContext(fs.readFileSync('src/static/js/accounts.js', 'utf8'), s, { filename: 'accounts.js' });
  return s;
}

check('多账号：垫片把逻辑键透明映射到 u<前8位>_ 物理键，账号外键不可见', () => {
  const { s, store } = _accountVmContext('abcd1234efgh', {
    // 物理层：default 的旧键 + 本账号前缀键并存（模拟同浏览器多账号）
    'uabcd1234_phymathia_theme': 'light',
    'phymathia_theme': 'dark',
    'uabcd1234_phymathia_msgs_s1': '[1]',
  });
  if (vm.runInContext('ACCOUNT_ID', s) !== 'abcd1234efgh' || vm.runInContext('ACCOUNT_LS_PREFIX', s) !== 'uabcd1234_') throw new Error('指针/前缀解析错误');
  if (s.localStorage.getItem('phymathia_theme') !== 'light') throw new Error('逻辑键应命中本账号前缀键');
  if (s.localStorage.getItem('phymathia_msgs_s1') !== '[1]') throw new Error('会话键应走前缀');
  if (!s.localStorage.getItem('phymathia_unknown')) { /* null 正常 */ } else throw new Error('未知键应 null');
  s.localStorage.setItem('phymathia_x', '1');
  if (!store.has('uabcd1234_phymathia_x') || store.has('phymathia_x')) throw new Error('写入必须落前缀物理键');
  s.localStorage.removeItem('phymathia_x');
  if (store.has('uabcd1234_phymathia_x')) throw new Error('removeItem 应删前缀键');
  const keys = s.lsKeys();
  if (!keys.includes('phymathia_theme') || keys.includes('msgs_x')) throw new Error('lsKeys 应返回剥前缀逻辑键');
  if (keys.includes('phymathia_theme') && store.has('phymathia_theme') && keys.filter(k => k === 'phymathia_theme').length !== 1) throw new Error('lsKeys 不应混入 default 的同名物理键');
  // default 的键不在本账号命名空间里
  if (s.localStorage.getItem('phymathia_sessions') !== null) throw new Error('账号外键不可见（隔离）');
  return true;
});

check('多账号：default 无垫片直通（现有键原样读写，零迁移）', () => {
  const { s, store } = _accountVmContext(null, { 'phymathia_theme': 'dark' });
  if (vm.runInContext('ACCOUNT_LS_PREFIX', s) !== '') throw new Error('default 前缀应为空');
  if (s.localStorage.getItem('phymathia_theme') !== 'dark') throw new Error('default 应直通原键');
  s.localStorage.setItem('phymathia_new_key', 'v');
  if (!store.has('phymathia_new_key')) throw new Error('default 写入不带前缀');
  return true;
});

check('多账号：fetch 包装给 /api/ 请求恒带 account_id，非 API 与已带的不动', () => {
  const seen = [];
  const s0 = { console, URLSearchParams: URL };
  s0.fetch = (input, init) => { seen.push(input); return Promise.resolve({ ok: true }); };
  s0.window = s0;
  s0.innerWidth = 1200;
  s0.localStorage = { getItem: () => 'abcd1234efgh', setItem() {}, removeItem() {} };
  s0.document = { documentElement: { setAttribute() {} } };
  vm.createContext(s0);
  vm.runInContext(fs.readFileSync('src/static/js/config.js', 'utf8'), s0, { filename: 'config.js' });
  s0.fetch('/api/sessions');
  s0.fetch('/api/kv/phymathia_quiz_stats?x=1');
  s0.fetch('/health');
  s0.fetch('/api/sessions?account_id=other');
  if (seen[0] !== '/api/sessions?account_id=abcd1234efgh') throw new Error('应补 account_id：' + seen[0]);
  if (seen[1] !== '/api/kv/phymathia_quiz_stats?x=1&account_id=abcd1234efgh') throw new Error('已有 query 应接 &：' + seen[1]);
  if (seen[2] !== '/health') throw new Error('非 /api/ 不动：' + seen[2]);
  if (seen[3] !== '/api/sessions?account_id=other') throw new Error('已带 account_id 不重复补：' + seen[3]);
  return true;
});

check('多账号：面板行渲染（当前徽标/default 拒删/当前可自删回 default/昵称转义）', () => {
  const row = sandbox.window._accountRowHtml;
  if (typeof row !== 'function') throw new Error('_accountRowHtml 未导出');
  const other = row({ id: 'default', name: '我的', allowBrowse: false, createdAt: 0 }, false);
  if (!other.includes('切换') || !other.includes('改名')) throw new Error('非当前行应有切换/改名');
  if (other.includes('删除')) throw new Error('default 行不得有删除按钮');
  // 昵称转义在真字符串上下文验证（主沙箱 DOM 代理的 innerHTML 不是真值）
  const s2 = _accountPanelContext();
  const esc = s2._accountRowHtml({ id: 'default', name: '我<b>的</b>', allowBrowse: false, createdAt: 0 }, false);
  if (esc.includes('<b>') || !esc.includes('我&lt;b&gt;的&lt;/b&gt;')) throw new Error('昵称必须转义：' + esc.slice(0, 80));
  const cur = row({ id: 'abcd1234efgh', name: '妹妹', allowBrowse: true, createdAt: 0 }, true);
  if (!cur.includes('当前') || cur.includes('切换')) throw new Error('当前行应有徽标且无切换钮');
  if (!cur.includes('删除')) throw new Error('当前账号（非 default）也应有删除钮（删除后自动回 default）');
  if (!cur.includes('checked')) throw new Error('allowBrowse=true 应勾选');
  const otherNonDefault = row({ id: 'eeee11112222', name: '二号', allowBrowse: false, createdAt: 0 }, false);
  if (!otherNonDefault.includes('删除')) throw new Error('非 default 的非当前行应有删除钮');
  return true;
});

check('多账号：静态契约（第 7 磁贴/弹窗骨架/构建注册/枚举收编/内联脚本前缀）', () => {
  const idx = fs.readFileSync('src/static/index.html', 'utf8');
  if (!idx.includes('id="accountTile"') || !idx.includes('openAccountsPanel')) throw new Error('侧栏缺账号磁贴');
  if (!idx.includes('id="accountsDialog"') || !idx.includes('id="accountsList"')) throw new Error('缺账号弹窗骨架');
  const newNameAt = idx.indexOf('id="accountNewName"');
  if (newNameAt < 0 || idx.slice(newNameAt, newNameAt + 300).indexOf('createAccount()') < 0) throw new Error('新建输入缺回车确认（onkeydown→createAccount）');
  if (!idx.includes("localStorage.getItem('phymathia_account')")) throw new Error('内联主题脚本未感知账号指针');
  const cfg = fs.readFileSync('src/static/js/config.js', 'utf8');
  if (!cfg.includes('installAccountLsShim') || !cfg.includes('function lsKeys') || !cfg.includes('installAccountFetch')) throw new Error('config.js 缺垫片/枚举/包装实现');
  const build = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');
  if (!build.includes("'accounts.js'")) throw new Error('构建未注册 accounts.js');
  if (!fs.readFileSync('src/static/js/accounts.js', 'utf8').includes('_RAW_LS.setItem(STORAGE_KEY_ACCOUNT')) throw new Error('账号指针必须写元键（_RAW_LS），防垫片加前缀');
  const sess = fs.readFileSync('src/static/js/session.js', 'utf8');
  if (sess.includes('Object.keys(localStorage')) throw new Error('session.js 枚举未收编到 lsKeys()');
  // T261 拆分后 ui 家族三件都要守 lsKeys 纪律（备份段是枚举大户）
  for (const f of ['ui.js', 'ui-backup.js', 'ui-onboarding.js']) {
    if (fs.readFileSync('src/static/js/' + f, 'utf8').includes('Object.keys(localStorage')) throw new Error(f + ' 枚举未收编到 lsKeys()');
  }
  return true;
});

// ===== 只读查阅（P3 2026-10-07）：查阅元键/只读旗标/fetch 闸门/行按钮/悬浮条 =====
// 全程用独立 vm 上下文或源码断言，不改主沙箱共享键——不需要进串行边界段。

check('只读查阅：config.js 源契约（元键常量/旗标初始化/残缺自清/只读头/本地 403）', () => {
  const cfg = fs.readFileSync('src/static/js/config.js', 'utf8');
  if (!cfg.includes("const STORAGE_KEY_BROWSE_ACTIVE = 'phymathia_browse_active'")
    || !cfg.includes("const STORAGE_KEY_BROWSE_RETURN = 'phymathia_browse_return'")) throw new Error('缺查阅态两元键常量');
  if (!cfg.includes('window.PHYMATHIA_READONLY = ok')) throw new Error('缺只读旗标初始化');
  if (!cfg.includes('_rawLsDel(STORAGE_KEY_BROWSE_ACTIVE)')) throw new Error('残缺状态必须清标记（防带病只读）');
  if (!cfg.includes("h.set('X-Phymathia-Readonly', '1')")) throw new Error('放行请求必须带只读头');
  if (!cfg.includes('status: 403')) throw new Error('客户端漏网写点必须本地 403 兜底');
  // 只查代码用法（点号），注释里的「为何不用 sessionStorage」论证不算
  if (cfg.includes('sessionStorage.')) throw new Error('浏览标记不许落 sessionStorage（关页即失旗标）');
  return true;
});

check('只读查阅：元键齐备→只读旗标；残缺状态→自清且不进只读', () => {
  const { s, store } = _accountVmContext(null, {
    'phymathia_account': 'abcd1234efgh',
    'phymathia_browse_active': 'abcd1234efgh',
    'phymathia_browse_return': 'default',
  });
  if (vm.runInContext('window.PHYMATHIA_READONLY', s) !== true) throw new Error('元键齐备应进只读旗标');
  if (vm.runInContext('window.PHY_BROWSE_RETURN', s) !== 'default') throw new Error('还原账号应记为 default');
  // 指针与浏览目标不一致（被显式切换走）：清两枚标记，绝不带病只读
  const s2ctx = _accountVmContext(null, {
    'phymathia_account': 'default',
    'phymathia_browse_active': 'abcd1234efgh',
    'phymathia_browse_return': 'default',
  });
  if (vm.runInContext('window.PHYMATHIA_READONLY', s2ctx.s) !== false) throw new Error('残缺状态不得进只读');
  if (s2ctx.store.has('phymathia_browse_active') || s2ctx.store.has('phymathia_browse_return')) throw new Error('残缺标记必须自清');
  return true;
});

check('只读查阅：fetch 闸门（拦 POST 本地 403 不发包、白名单放行、GET 带只读头）', async () => {
  const seen = [];
  const heads = [];
  const s0 = { console, URLSearchParams: URL, Headers, Response };
  s0.fetch = (input, init) => {
    seen.push(String(input));
    heads.push(!!(init && init.headers && init.headers.get && init.headers.get('X-Phymathia-Readonly')));
    return Promise.resolve({ ok: true });
  };
  s0.window = s0;
  s0.innerWidth = 1200;
  s0.localStorage = {
    getItem: (k) => ({ 'phymathia_account': 'abcd1234efgh', 'phymathia_browse_active': 'abcd1234efgh', 'phymathia_browse_return': 'default' })[k] || null,
    setItem() {}, removeItem() {},
  };
  s0.document = { documentElement: { setAttribute() {} } };
  vm.createContext(s0);
  vm.runInContext(fs.readFileSync('src/static/js/config.js', 'utf8'), s0, { filename: 'config.js' });
  if (s0.PHYMATHIA_READONLY !== true) throw new Error('应进只读旗标');
  const blocked = await s0.fetch('/api/kv/x', { method: 'POST', body: '{}' });
  s0.fetch('/api/models/list', { method: 'POST', body: '{}' }); // 白名单：读语义 POST
  s0.fetch('/api/sessions'); // GET：读
  if (blocked.status !== 403 || blocked.ok !== false) throw new Error('被拦写点应回 403 Response');
  const body = await blocked.json();
  if (!body.detail || body.detail.indexOf('只读') < 0) throw new Error('403 应带明白话 detail');
  if (seen.length !== 2) throw new Error('被拦 POST 不得发网络请求：' + JSON.stringify(seen));
  if (!(heads[0] && heads[1])) throw new Error('放行请求必须带 X-Phymathia-Readonly 头');
  if (!seen.includes('/api/models/list?account_id=abcd1234efgh')) throw new Error('白名单 POST 应放行并补 account_id：' + JSON.stringify(seen));
  if (!seen.includes('/api/sessions?account_id=abcd1234efgh')) throw new Error('GET 应放行并补 account_id');
  return true;
});
await drain(); // 本段异步用例收口，否则断言赶不上退出判定

check('只读查阅：面板行渲染（查阅钮矩阵/查阅态只展示不操作/查阅中徽标）', () => {
  const s2 = _accountPanelContext();
  const row = s2._accountRowHtml;
  const on = row({ id: 'eeee11112222', name: '妹妹', allowBrowse: true, createdAt: 0 }, false);
  if (!on.includes('enterBrowse')) throw new Error('allowBrowse=true 的非当前行应有查阅钮');
  const off = row({ id: 'eeee11112222', name: '二号', allowBrowse: false, createdAt: 0 }, false);
  if (off.includes('enterBrowse')) throw new Error('未开放查阅不得出查阅钮');
  if (!off.includes('切换') || !off.includes('改名') || !off.includes('删除')) throw new Error('普通行按钮矩阵不变');
  s2.window.PHYMATHIA_READONLY = true;
  const ro = s2._accountRowHtml({ id: 'eeee11112222', name: '妹妹', allowBrowse: true, createdAt: 0 }, false);
  if (ro.includes('enterBrowse') || ro.includes('switchAccount') || ro.includes('deleteAccountPrompt')) throw new Error('查阅态行不得有操作钮');
  if (!ro.includes('允许查阅：开')) throw new Error('查阅态开关应降级为只读展示');
  const roCur = s2._accountRowHtml({ id: 'abcd1234efgh', name: '妹妹', allowBrowse: true, createdAt: 0 }, true);
  if (!roCur.includes('查阅中')) throw new Error('查阅态当前行应标「查阅中」');
  return true;
});

check('只读查阅：静态契约（悬浮条/进入退出/逐模块写点闸门/引导跳过/样式）', () => {
  const idx = fs.readFileSync('src/static/index.html', 'utf8');
  if (!idx.includes('id="browseBar"') || !idx.includes('id="browseBarText"') || !idx.includes('exitBrowse()')) throw new Error('缺查阅悬浮条骨架');
  const acc = fs.readFileSync('src/static/js/accounts.js', 'utf8');
  if (!acc.includes('async function enterBrowse') || !acc.includes('function exitBrowse')) throw new Error('accounts.js 缺进入/退出查阅');
  if (!acc.includes('STORAGE_KEY_BROWSE_RETURN')) throw new Error('进入查阅必须写浏览元键（_RAW_LS）');
  if (!acc.includes('STORAGE_KEY_BROWSE_RETURN_NAME')) throw new Error('退出查阅必须还原归还账号昵称');
  if (!acc.includes('_accountsReadonlyGuard()')) throw new Error('账号管理操作缺查阅守卫');
  if (!acc.includes('removeItem(STORAGE_KEY_BROWSE_ACTIVE)')) throw new Error('显式切换账号必须清浏览标记');
  const gates = [
    ['src/static/js/chat.js', "phyReadonlyBlock('发送消息')"],
    ['src/static/js/graph-workflow-template.js', "phyReadonlyBlock('发起提问')"],
    ['src/static/js/harness-run.js', "phyReadonlyBlock('发送 Φ 消息')"],
    ['src/static/js/quiz-ui.js', "phyReadonlyBlock('进行知识检测')"],
    ['src/static/js/session.js', "phyReadonlyBlock('新建会话')"],
    ['src/static/js/session.js', "phyReadonlyBlock('删除会话')"],
    ['src/static/js/session.js', "phyReadonlyBlock('清空会话')"],
    ['src/static/js/graph-interact.js', "phyReadonlyBlock('创建分支')"],
    ['src/static/js/graph-interact.js', "phyReadonlyBlock('作答追问')"],
    ['src/static/js/ui-backup.js', "phyReadonlyBlock('导入备份')"],
  ];
  for (const [f, g] of gates) {
    if (!fs.readFileSync(f, 'utf8').includes(g)) throw new Error(f + ' 缺写点闸门：' + g);
  }
  if (!fs.readFileSync('src/static/js/ui.js', 'utf8').includes('if (!phyIsReadonly()) startOnboarding()')) throw new Error('查阅态应跳过首次引导');
  if (!fs.readFileSync('src/static/css/styles.css', 'utf8').includes('.browse-bar')) throw new Error('缺悬浮条样式');
  // 卸载冲刷走 sendBeacon（不经 fetch 包装，fetch 闸门与服务端兜底都拦不到）——
  // 必须在 handler 里自带只读跳过，且信封自带 account_id（否则按缺省落 default）
  const sessrc = fs.readFileSync('src/static/js/session.js', 'utf8');
  if (!sessrc.includes("'?account_id=' + encodeURIComponent")) throw new Error('卸载冲刷信封缺 account_id');
  if (!sessrc.includes('if (phyIsReadonly()) return;')) throw new Error('查阅态卸载冲刷必须整体跳过');
  if (!sessrc.includes('if (!phyIsReadonly() && currentSessionId && chatHistory.length > 0)')) throw new Error('查阅态周期同步只应拉取不应推送');
  return true;
});

// ===== 账号悬空自愈与只读副作用（T185/T186/T187 2026-10-07）=====
// 独立 vm 上下文或源码断言，不改主沙箱共享键。

// accounts.js 悬空自愈的独立上下文：指针指向 dead1234beef（列表里不存在时触发回落）
function _accountRecoverContext(pointer, opts = {}) {
  const { s } = _accountVmContext(pointer, opts.seed || {});
  vm.runInContext('function escapeHtml(t){return String(t==null?"":t);} function toastMsg(){}', s);
  s.location = { reload() { (s.__reloads = s.__reloads || []).push(1); } };
  s.setTimeout = (fn) => { (s.__timers = s.__timers || []).push(fn); };
  s.AbortSignal = AbortSignal;
  s.fetch = opts.fetch;
  vm.runInContext(fs.readFileSync('src/static/js/accounts.js', 'utf8'), s, { filename: 'accounts.js' });
  return s;
}

check('账号悬空自愈：指针指向已删账号 → 回落「我的」并重载（T185）', async () => {
  const s = _accountRecoverContext('dead1234beef', {
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ accounts: [{ id: 'default', name: '我的' }] }) }),
  });
  const out = await vm.runInContext('_accountsRecoverIfMissing()', s);
  if (out !== true) throw new Error('账号不在列表里应触发回落');
  if (vm.runInContext('_RAW_LS.getItem("phymathia_account")', s) !== 'default') throw new Error('指针应回落 default');
  if (vm.runInContext('_RAW_LS.getItem("phymathia_account_name")', s) !== '我的') throw new Error('昵称缓存应同步');
  if ((s.__timers || []).length !== 1) throw new Error('应安排一次重载');
  s.__timers.forEach(fn => fn());
  if (!(s.__reloads || []).length) throw new Error('重载应真正执行');
  return true;
});

check('账号悬空自愈：查阅态被查阅账号被删 → 回落归还账号并清查阅标记（T185）', async () => {
  const s = _accountRecoverContext('dead1234beef', {
    seed: { 'phymathia_browse_active': 'dead1234beef', 'phymathia_browse_return': 'keep1234cafe',
            'phymathia_browse_return_name': '妹妹' },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ accounts: [
      { id: 'default', name: '我的' }, { id: 'keep1234cafe', name: '妹妹' }] }) }),
  });
  if (vm.runInContext('window.PHYMATHIA_READONLY', s) !== true) throw new Error('前置：元键齐备应进只读旗标');
  const out = await vm.runInContext('_accountsRecoverIfMissing()', s);
  if (out !== true) throw new Error('被查阅账号缺失应触发回落');
  if (vm.runInContext('_RAW_LS.getItem("phymathia_account")', s) !== 'keep1234cafe') throw new Error('应回落归还账号而非 default');
  if (vm.runInContext('_RAW_LS.getItem("phymathia_account_name")', s) !== '妹妹') throw new Error('昵称应取列表条目');
  if (vm.runInContext('_RAW_LS.getItem("phymathia_browse_active")', s) !== null
    || vm.runInContext('_RAW_LS.getItem("phymathia_browse_return")', s) !== null) throw new Error('被查阅账号已删，查阅标记应清');
  return true;
});

check('账号悬空自愈：列表拿不到/账号还在 → 不动指针（服务端不可达不得误判为已删）', async () => {
  const s = _accountRecoverContext('dead1234beef', { fetch: () => Promise.reject(new Error('offline')) });
  if (await vm.runInContext('_accountsRecoverIfMissing()', s) !== false) throw new Error('拿不到列表应放弃回落');
  if (vm.runInContext('_RAW_LS.getItem("phymathia_account")', s) !== 'dead1234beef') throw new Error('指针不得被改动');
  if ((s.__timers || []).length) throw new Error('不得安排重载');
  const s2 = _accountRecoverContext('dead1234beef', { fetch: () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }) });
  if (await vm.runInContext('_accountsRecoverIfMissing()', s2) !== false) throw new Error('非 2xx 应放弃回落');
  const s3 = _accountRecoverContext('dead1234beef', { fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ accounts: [{ id: 'dead1234beef', name: '还在' }] }) }) });
  if (await vm.runInContext('_accountsRecoverIfMissing()', s3) !== false) throw new Error('账号还在列表里不得回落');
  const s4 = _accountRecoverContext(null, { fetch: () => { throw new Error('default 不该发请求'); } });
  if (await vm.runInContext('_accountsRecoverIfMissing()', s4) !== false) throw new Error('default 无悬空可能，直接放行');
  return true;
});

check('账号悬空自愈：fetch 包装识别 404 标记头 → 提示并安排重载（一次性）（T185）', async () => {
  const toasts = [];
  const timers = [];
  let calls = 0;
  const s0 = { console, URLSearchParams: URL, Headers, Response, setTimeout: (fn) => timers.push(fn) };
  s0.fetch = () => {
    calls++;
    return Promise.resolve(new Response('{"detail":"该账号不存在（已被彻底删除）"}',
      { status: 404, headers: { 'X-Phymathia-Account-Gone': '1', 'Content-Type': 'application/json' } }));
  };
  s0.window = s0;
  s0.innerWidth = 1200;
  s0.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, length: 0, key: () => null };
  s0.document = { documentElement: { setAttribute() {} }, getElementById: () => null };
  s0.toastMsg = (m) => toasts.push(m);
  vm.createContext(s0);
  vm.runInContext(fs.readFileSync('src/static/js/config.js', 'utf8'), s0, { filename: 'config.js' });
  const resp = await s0.fetch('/api/sessions');
  await new Promise(r => setImmediate(r));
  if (calls !== 1 || resp.status !== 404) throw new Error('请求应照常发出且调用方拿到原响应');
  if (!toasts.length || toasts[0].indexOf('已被删除') < 0) throw new Error('应提示当前账号已删');
  if (timers.length !== 1) throw new Error('应安排一次重载');
  await s0.fetch('/api/kv/x');
  await new Promise(r => setImmediate(r));
  if (toasts.length !== 1 || timers.length !== 1) throw new Error('重复 404 应被一次性标志拦住');
  // 无标记头的普通 404（如未知路由）不得触发
  const s1 = { console, URLSearchParams: URL, Headers, Response, setTimeout: (fn) => timers.push(fn) };
  s1.fetch = () => Promise.resolve(new Response('{"detail":"Not found"}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
  s1.window = s1;
  s1.innerWidth = 1200;
  s1.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, length: 0, key: () => null };
  s1.document = { documentElement: { setAttribute() {} }, getElementById: () => null };
  s1.toastMsg = (m) => toasts.push(m);
  vm.createContext(s1);
  vm.runInContext(fs.readFileSync('src/static/js/config.js', 'utf8'), s1, { filename: 'config.js' });
  await s1.fetch('/api/nope');
  await new Promise(r => setImmediate(r));
  if (toasts.length !== 1 || timers.length !== 1) throw new Error('无标记头的 404 不得触发回落');
  return true;
});

check('账号悬空自愈/只读副作用：静态契约（启动链/标记头/两处导出闸/服务端 403）', () => {
  const acc = fs.readFileSync('src/static/js/accounts.js', 'utf8');
  if (!acc.includes('async function _accountsRecoverIfMissing')) throw new Error('accounts.js 缺启动期账号校验');
  if (!acc.includes('function _accountsRecoverIfMissing')) throw new Error('缺回落实现');
  const uijs = fs.readFileSync('src/static/js/ui.js', 'utf8');
  if (!uijs.includes('await _accountsRecoverIfMissing()')) throw new Error('ui.js 启动链未挂账号校验');
  const cfg = fs.readFileSync('src/static/js/config.js', 'utf8');
  if (!cfg.includes("resp.headers.get('X-Phymathia-Account-Gone')")) throw new Error('fetch 包装未识别账号悬空标记头');
  if (!cfg.includes('__phyAccountJustDeleted')) throw new Error('自删流程应跳过自动回落（与删除流程自带的重载不打架）');
  if (!fs.readFileSync('src/static/js/ui-backup.js', 'utf8').includes("phyReadonlyBlock('导出数据')")) throw new Error('ui-backup.js exportData 缺查阅态闸门');
  if (!fs.readFileSync('src/static/js/memory.js', 'utf8').includes("phyReadonlyBlock('清除记忆')")) throw new Error('memory.js 清除记忆缺查阅态闸门');
  // T163 后接入点按属主模块镜像：悬空标记头在 request_ctx.py，画像/查阅态在 profile_routes.py
  const ctxpy = fs.readFileSync('src/server/request_ctx.py', 'utf8');
  if (!ctxpy.includes('"X-Phymathia-Account-Gone": "1"')) throw new Error('服务端 404 缺账号悬空标记头');
  const profroutespy = fs.readFileSync('src/server/profile_routes.py', 'utf8');
  if (!profroutespy.includes('不能导出对方数据')) throw new Error('服务端缺查阅态整包导出 403');
  if (!profroutespy.includes('if not _readonly_request(request):')) throw new Error('服务端画像面板缺查阅态绑定跳过');
  const accpy = fs.readFileSync('src/server/accounts.py', 'utf8');
  if (!accpy.includes('def is_registered')) throw new Error('accounts.py 缺 is_registered（幽灵闸门判据）');
  if (!accpy.includes('account != DEFAULT_ACCOUNT and account not in load_registry()')) throw new Error('ensure_account 缺未登记闸门（T186）');
  return true;
});

await drain(); // 本段异步用例收口（T185 悬空自愈，否则断言赶不上退出判定）

// 大陆六文件写点闸（P3 续 2026-10-07）：查阅他人账号时打开大陆，浏览痕迹不得写进
// 对方账号——localStorage 写跳过（试玩型走内存影子）、边/海域提交跳 fetch 走本地
// 镜像、管理动作（归类/采纳/族表/起名/清空/问 Φ）入口拦。静态契约走
// readContinentSrc() 六件拼接（切片锚按六件拼接顺序，锚缺失即红）。
check('只读查阅：大陆六文件写点闸（localStorage 写跳过/提交跳 fetch 内存镜像/管理动作入口拦）', () => {
  const src = readContinentSrc();
  const between = (a, b) => {
    const i = src.indexOf(a);
    if (i < 0) throw new Error('切片锚缺失：' + a);
    const j = b ? src.indexOf(b, i + 1) : src.length;
    if (b && j < 0) throw new Error('切片锚缺失：' + b);
    return src.slice(i, j);
  };
  if (!src.includes('function _continentReadonlyNudge')) throw new Error('缺大陆查阅温和提示 helper');
  // ① localStorage 浏览痕迹：跳过落盘（读对方、写跳过）
  for (const [a, b, what] of [
    ['function _continentSaveCollapsed', 'function _continentToggleCollapse', '折叠清单'],
    ['function _continentPersistView', 'function _continentToggleFullscreen', '视口保存'],
  ]) {
    if (!between(a, b).includes('phyIsReadonly()')) throw new Error(what + '缺查阅态写跳过');
  }
  // ② 试玩型显示偏好：切换内存影子生效、落盘跳过（影子读侧保证重渲不弹回）
  for (const [a, b, what] of [
    ['let _continentStyleMem', 'function _continentSyncStyleBtn', '画风开关'],
    ['let _continentRoutePrefsMem', 'const _continentRouteColorCache', '航线偏好'],
    ['let _continentLegendMem', 'function _continentToggleLegendFocus', '图例折叠'],
  ]) {
    if (!between(a, b).includes('phyIsReadonly()')) throw new Error(what + '缺查阅态内存影子');
  }
  // ③ 数据提交漏斗：查阅态跳过 fetch（省一次必败 403），继续本地镜像让撤销栈照常
  for (const [a, b, what] of [
    ['async function _continentCommit', 'async function _continentAddUserEdge', '边提交'],
    ['async function _continentCommitRegionOverrides', 'async function _continentUndoRegionOp', '海域覆盖提交'],
  ]) {
    const blk = between(a, b);
    if (!blk.includes('if (!phyIsReadonly())') || !blk.includes('_continentReadonlyNudge')) {
      throw new Error(what + '缺查阅态跳 fetch 走内存镜像');
    }
  }
  // ④ 管理动作入口拦（写对方数据/烧模型调用，不静默试玩）
  for (const [a, b, what] of [
    ['async function _continentGateClassify', '// 采纳归并建议', 'Φ 归类'],
    ['async function _continentAdoptGateMerge', 'function _continentFamilySourceLabel', '采纳归并'],
    ['async function _continentRecordCorrection', '// 保存 KV 后刷新投影', '纠正信号'],
    ['const persist = async next =>', '// v10 补词建议', '族表持久化'],
    ['const saveSuggestState = async state =>', '// 族表 KV 的当下快照', '候选状态落 KV'],
    ['const rejectSuggestion = async s =>', '// ---------- v10 第二期：新族候选', '拒绝记录'],
    ['if (nameBtn) nameBtn.addEventListener', 'if (createBtn) createBtn.addEventListener', 'Φ 起名'],
  ]) {
    if (!between(a, b).includes('phyIsReadonly()')) throw new Error(what + '缺查阅态入口拦');
  }
  if (!src.slice(src.indexOf('if (clearBtn) clearBtn.addEventListener')).includes('phyIsReadonly()')) {
    throw new Error('纠正记录清空缺查阅态入口拦');
  }
  const askBlk = between('async function _continentAskPhi', '// 折叠清单的行是纯字符串拼装');
  if (!askBlk.includes('phyIsReadonly()')) throw new Error('问 Φ 缺查阅态入口拦（只读态不放开模型通道）');
  // ⑤ 白名单红线：SAFE_POST 不得加入模型对话通道（＝查阅态能借对方配置发对话）
  const cfg = fs.readFileSync('src/static/js/config.js', 'utf8');
  if (!cfg.includes("const PHY_READONLY_SAFE_POST = ['/api/models/list', '/api/models/probe']")) {
    throw new Error('只读白名单被改动——模型对话通道不得放进 SAFE_POST');
  }
  return true;
});

// ===== 回收站（2026-10-07）：防误删面板 =====

// trash.js 在独立上下文里跑（依赖 config.js 的 STORAGE_KEY_TRASH_RETENTION、
// accounts.js 的 _accountsDateStr、注入的真 escapeHtml）
function _trashPanelContext() {
  const s = _accountPanelContext();
  vm.runInContext(fs.readFileSync('src/static/js/trash.js', 'utf8'), s, { filename: 'trash.js' });
  return s;
}

check('回收站：行渲染纯函数（标题转义/id 消毒/按钮矩阵/剩余天数/查阅态只展示）', () => {
  const s2 = _trashPanelContext();
  if (typeof s2._trashRowHtml !== 'function') throw new Error('trash.js 未装载');
  const day = 86400000;
  const row = s2._trashRowHtml({
    id: 'sess_abc123', title: '<b>物理</b>画布', deletedAt: Date.now() - day,
    purgeAt: Date.now() + 3 * day, counts: { messages: 5, knowledge: 2, formulas: 1 },
  });
  if (!row.includes('&lt;b&gt;物理&lt;/b&gt;画布')) throw new Error('标题必须转义');
  if (row.includes('<b>物理')) throw new Error('标题未转义（XSS）');
  if (!row.includes('data-trash-item="sess_abc123"')) throw new Error('缺条目标识');
  if (!row.includes('恢复') || !row.includes('彻底删除')) throw new Error('行按钮矩阵应为 恢复+彻底删除');
  if (!row.includes('剩 3 天')) throw new Error('剩余天数换算不对：' + row);
  if (!row.includes('5 条消息') || !row.includes('2 个知识点') || !row.includes('1 条公式')) throw new Error('counts 摘要缺失');
  // id 注入消毒：尖括号/引号/等号全部剥掉，只剩白名单字符进 onclick/属性
  const evil = s2._trashRowHtml({ id: 'sess_<img src=x onerror=1>"', title: 't', purgeAt: 0 });
  if (!evil.includes('data-trash-item="sess_imgsrcxonerror1"')) throw new Error('id 应剥成纯白名单字符');
  if (evil.includes('<img') || evil.includes('onerror=1')) throw new Error('注入片段未剥净');
  // purgeAt=0（不自动清除）不出「剩/已到期」字样
  const noPurge = s2._trashRowHtml({ id: 'sess_a', title: 't', purgeAt: 0 });
  if (noPurge.includes('剩 ') || noPurge.includes('已到期')) throw new Error('purgeAt=0 不应显示天数');
  // 查阅态：整行只展示不操作
  s2.window.PHYMATHIA_READONLY = true;
  const ro = s2._trashRowHtml({ id: 'sess_a', title: 't', purgeAt: Date.now() + day });
  if (ro.includes('restoreTrashItem') || ro.includes('purgeTrashItem')) throw new Error('查阅态行不得有操作钮');
  if (!ro.includes('data-trash-item')) throw new Error('查阅态行仍应展示条目');
  // 保留天数文案纯函数
  if (s2._trashRetentionLabel(0) !== '不保留') throw new Error('0 天应显示 不保留');
  if (s2._trashRetentionLabel(7) !== '留7天') throw new Error('7 天应显示 留7天');
  if (s2._trashRetentionLabel('abc') !== '不保留') throw new Error('脏值应回落 不保留');
  return true;
});

check('回收站：清空消息条目（T182）——key 寻址/kind 徽标/clearChat 服务端先行/确认文案/捕获点镜像', () => {
  const s2 = _trashPanelContext();
  // 清空消息条目：恢复/彻底删除必须按 key（目录名）寻址，行上带种类徽标
  const row = s2._trashRowHtml({
    id: 'sess_aaa', key: 'sess_aaa__m1730000000000', kind: 'messages',
    title: '物理画布', purgeAt: Date.now() + 86400000,
  });
  if (!row.includes('data-trash-item="sess_aaa__m1730000000000"')) throw new Error('清空消息条目应按 key（目录名）寻址');
  if (row.includes("restoreTrashItem('sess_aaa')")) throw new Error('不得用画布 id 寻址（目录名≠id）');
  if (!row.includes('trash-kind-tag') || !row.includes('清空的消息')) throw new Error('缺清空消息徽标');
  // 整画布条目（无 kind）无徽标；key 缺失回落 id（兼容旧口径）
  const plain = s2._trashRowHtml({ id: 'sess_b', title: 't', purgeAt: 0 });
  if (plain.includes('trash-kind-tag')) throw new Error('整画布条目不应有徽标');
  if (!plain.includes('data-trash-item="sess_b"')) throw new Error('key 缺失应回落 id');
  // 空态文案覆盖两类条目
  const trashSrc = fs.readFileSync('src/static/js/trash.js', 'utf8');
  if (!trashSrc.includes('删除的画布与清空的消息')) throw new Error('空态文案未覆盖清空消息');
  // clearChat：服务端清空先行——回收站捕获点在 DELETE /messages 内，必须早于
  // 前端探索网快照/quiz 清理，否则捕到的已是残骸（T182 顺序纪律）
  const sessrc = fs.readFileSync('src/static/js/session.js', 'utf8');
  const seg = sessrc.slice(sessrc.indexOf('async function clearChat'), sessrc.indexOf('async function clearAllSessions'));
  const delMsgs = seg.indexOf('`/api/sessions/${currentSessionId}/messages`');
  const delGraph = seg.indexOf('await _deleteGraphStateOnServer(currentSessionId)');
  if (delMsgs < 0 || delGraph < 0) throw new Error('clearChat 缺服务端清空调用');
  if (delMsgs > delGraph) throw new Error('服务端清空必须先行——捕获点早于前端 graph 清理（T182）');
  if (!seg.includes('本画布的消息会先进入回收站暂存')) throw new Error('清空确认文案未指向回收站');
  if (!seg.includes('_trashRetentionLocal() === 0')) throw new Error('回收站关闭时清空确认文案必须如实警告');
  // 服务端契约镜像（T163 后清空路由住 session_routes.py）：清空路由接捕获、trash.py 有 messages 条目的捕获/恢复函数
  const sessionpy = fs.readFileSync('src/server/session_routes.py', 'utf8');
  if (!sessionpy.includes('trash.capture_cleared_messages(paths, session_id, messages_path=msgs_path)')) throw new Error('api_clear_messages 未接回收站捕获');
  const pysrc = fs.readFileSync('src/server/trash.py', 'utf8');
  if (!pysrc.includes('def capture_cleared_messages') || !pysrc.includes('def _restore_cleared_messages')) throw new Error('trash.py 缺清空消息条目函数');
  return true;
});

check('回收站：静态契约（磁贴/弹窗骨架/保留天数下拉默认7/构建注册/确认文案指向回收站/只读守卫）', () => {
  const idx = fs.readFileSync('src/static/index.html', 'utf8');
  for (const frag of ['id="trashTile"', 'id="trashTileSub"', 'openTrashPanel()', 'id="trashDialog"',
    'id="trashList"', 'id="trashRetentionSelect"', 'onclick="emptyTrash()"']) {
    if (!idx.includes(frag)) throw new Error('index.html 缺回收站骨架：' + frag);
  }
  if (!idx.includes('value="7" selected')) throw new Error('保留天数下拉默认必须 7 天');
  if (!fs.readFileSync('scripts/build_frontend.mjs', 'utf8').includes("'trash.js',")) throw new Error('trash.js 未注册进构建清单');
  if (!fs.readFileSync('src/static/css/styles.css', 'utf8').includes('.trash-toolbar')) throw new Error('缺回收站工具行样式');
  if (!fs.readFileSync('src/static/js/config.js', 'utf8').includes("STORAGE_KEY_TRASH_RETENTION = 'phymathia_trash_retention'")) throw new Error('config.js 缺保留天数缓存键');
  const trashSrc = fs.readFileSync('src/static/js/trash.js', 'utf8');
  if (!trashSrc.includes('_trashReadonlyGuard()')) throw new Error('回收站写操作缺查阅守卫');
  if (!trashSrc.includes("encodeURIComponent(id) + '/restore'")) throw new Error('恢复端点必须 encodeURIComponent');
  if (!trashSrc.includes('location.reload()')) throw new Error('恢复后必须整页刷新（会话名单双源合并）');
  // 删除/清空确认文案指向回收站（回收站关闭时如实警告不可恢复）
  const sessrc = fs.readFileSync('src/static/js/session.js', 'utf8');
  if (!sessrc.includes('删除后进入回收站暂存')) throw new Error('单删确认文案未指向回收站');
  if (!sessrc.includes('先进入回收站暂存')) throw new Error('批量删除确认文案未指向回收站');
  if (!sessrc.includes('可在侧栏「回收站」恢复')) throw new Error('清空全部确认文案未指向回收站');
  if (!sessrc.includes('_trashRetentionLocal() === 0')) throw new Error('回收站关闭时确认文案必须如实警告');
  // 服务端契约镜像（trash.py 捕获点在删除路由内、路由五条都在）
  const pysrc = fs.readFileSync('src/server/trash.py', 'utf8');
  if (!pysrc.includes('meta.json 最后落盘') || !pysrc.includes('def capture_session') || !pysrc.includes('def restore_item')) throw new Error('trash.py 缺核心函数');
  // T163 后回收站路由住 session_routes.py；purge_expired_all 是启动期清理、合法留在 main.py
  const sessionpy2 = fs.readFileSync('src/server/session_routes.py', 'utf8');
  for (const frag of ['trash.capture_session(paths, session_id, messages_path=msgs_path)',
    'trash.capture_all(paths)', '"/api/trash"', '"/api/trash/settings"',
    '"/api/trash/{item_id}/restore"']) {
    if (!sessionpy2.includes(frag)) throw new Error('session_routes.py 缺回收站接入点：' + frag);
  }
  const mainpy = fs.readFileSync('src/main.py', 'utf8');
  if (!mainpy.includes('trash.purge_expired_all()')) throw new Error('main.py 缺启动期回收站清理');
  // 主沙箱（构建产物）里 trash.js 已随包装载
  if (typeof sandbox._trashRowHtml !== 'function') throw new Error('trash.js 未进 app.js 构建产物');
  return true;
});

check('回收站：已删账号小节（行渲染/stone 消毒/查阅态只展示/确认文案/静态契约/服务端接入点镜像）', () => {
  const s2 = _trashPanelContext();
  if (typeof s2._trashAccountRowHtml !== 'function') throw new Error('trash.js 缺已删账号行渲染');
  const day = 86400000;
  const row = s2._trashAccountRowHtml({
    stone: 'abcd1234efgh_1791360000000', id: 'abcd1234efgh', name: '<b>妹妹</b>',
    deletedAt: Date.now() - day, purgeAt: Date.now() + 5 * day,
  });
  if (!row.includes('&lt;b&gt;妹妹&lt;/b&gt;')) throw new Error('账号昵称必须转义');
  if (row.includes('<b>妹妹')) throw new Error('昵称未转义（XSS）');
  if (!row.includes('data-trash-account="abcd1234efgh_1791360000000"')) throw new Error('缺墓碑标识 stone');
  if (!row.includes('restoreDeletedAccount') || !row.includes('purgeDeletedAccount')) throw new Error('行按钮矩阵应为 恢复+彻底删除');
  if (!row.includes('剩 5 天')) throw new Error('剩余天数换算不对：' + row);
  // stone 注入消毒：墓碑目录名拼 onclick/属性，同画布行白名单口径
  const evil = s2._trashAccountRowHtml({ stone: 'x_<img src=x onerror=1>"', id: 'x', name: 'n', purgeAt: 0 });
  if (evil.includes('<img') || evil.includes('onerror=1')) throw new Error('stone 注入片段未剥净');
  // 查阅态：整行只展示不操作
  s2.window.PHYMATHIA_READONLY = true;
  const ro = s2._trashAccountRowHtml({ stone: 'a_1', id: 'a', name: 'n', purgeAt: Date.now() + day });
  if (ro.includes('restoreDeletedAccount') || ro.includes('purgeDeletedAccount')) throw new Error('查阅态行不得有操作钮');
  if (!ro.includes('data-trash-account')) throw new Error('查阅态行仍应展示条目');
  s2.window.PHYMATHIA_READONLY = false;
  // 删账号确认文案如实指向回收站；回收站关闭（保留 0 天）如实警告不可恢复
  const acc = fs.readFileSync('src/static/js/accounts.js', 'utf8');
  if (!acc.includes('期间可在侧栏「回收站」恢复')) throw new Error('删账号确认文案未指向回收站');
  if (!acc.includes('立即彻底删除，不可恢复')) throw new Error('回收站关闭时删账号文案必须如实警告');
  if (!acc.includes('_trashRetentionLocal()')) throw new Error('删账号文案天数应取回收站保留天数缓存');
  const trashSrc = fs.readFileSync('src/static/js/trash.js', 'utf8');
  if (!trashSrc.includes("'/api/trash/accounts/' + encodeURIComponent(stone) + '/restore'")) throw new Error('恢复端点必须 encodeURIComponent');
  if (!trashSrc.includes('trash-section-title')) throw new Error('缺已删账号小节标题渲染');
  if (!fs.readFileSync('src/static/css/styles.css', 'utf8').includes('.trash-section-title')) throw new Error('缺小节标题样式');
  // 自删账号的卸载冲刷跳过（真机抓出：reload 的 sendBeacon 信封还带已删账号 id，
  // 会把账号在空目录上复活）——前端主动掐断 + 服务端 ensure 墓碑闸门双保险
  if (!acc.includes('__phyAccountJustDeleted = true')) throw new Error('删当前账号必须先立卸载冲刷跳过标志');
  const sessrc2 = fs.readFileSync('src/static/js/session.js', 'utf8');
  if (!sessrc2.includes('window.__phyAccountJustDeleted')) throw new Error('卸载冲刷缺自删账号跳过');
  const accpy = fs.readFileSync('src/server/accounts.py', 'utf8');
  if (!accpy.includes('def has_account_tombstone') || !accpy.includes('if has_account_tombstone(account):')) throw new Error('ensure 缺已删账号复活闸门');
  // 服务端契约镜像（账号墓碑机制在 trash.py，接入点自 T163 起在 server/session_routes.py）
  const pysrc = fs.readFileSync('src/server/trash.py', 'utf8');
  for (const frag of ['def capture_account', 'def restore_account_tombstone', 'def purge_expired_tombstones',
    'meta.json 最后落盘＝完整性标志', 'total += purge_expired_tombstones()']) {
    if (!pysrc.includes(frag)) throw new Error('trash.py 缺账号墓碑机制：' + frag);
  }
  const sessionpy = fs.readFileSync('src/server/session_routes.py', 'utf8');
  for (const frag of ['"/api/trash/accounts/{stone_id}/restore"', 'trash.capture_account(account, entry, days)',
    'accounts.forget_ensured(account)', 'accounts.restore_entry(entry)']) {
    if (!sessionpy.includes(frag)) throw new Error('session_routes.py 缺删账号回收站化接入点：' + frag);
  }
  // 主沙箱（构建产物）里新函数已随包装载
  if (typeof sandbox._trashAccountRowHtml !== 'function') throw new Error('trash.js 新函数未进 app.js 构建产物');
  return true;
});

check('学习画像按账号隔离（2026-10-07）：备份两路由恒带 device_id 圈定键', () => {
  const uisrc = fs.readFileSync('src/static/js/ui-backup.js', 'utf8');
  if (!uisrc.includes("'/api/backup/export?device_id=' + encodeURIComponent(getDeviceId())")) {
    throw new Error('备份导出缺 device_id（服务端按账号圈定画像的提示键）');
  }
  if (!uisrc.includes('device_id: getDeviceId(), backup: data')) throw new Error('备份导入缺 device_id');
  const pysrc = fs.readFileSync('src/server/backup.py', 'utf8');
  for (const frag of ['_account_profile_keys', 'device_key as _device_key']) {
    if (!pysrc.includes(frag)) throw new Error('backup.py 缺账号画像圈定：' + frag);
  }
  const accpy = fs.readFileSync('src/server/accounts.py', 'utf8');
  if (!accpy.includes('def account_devices') || !accpy.includes('def add_account_devices')) {
    throw new Error('accounts.py 缺账号↔设备绑定（entry.devices 归属快照）');
  }
  const profpy = fs.readFileSync('src/server/profile.py', 'utf8');
  if (!profpy.includes('def note_device_binding')) throw new Error('profile.py 缺绑定登记入口');
  const profileRoutespy = fs.readFileSync('src/server/profile_routes.py', 'utf8');
  if (!profileRoutespy.includes('profile.note_device_binding')) throw new Error('profile_routes.py 备份路由缺绑定登记');
  const trashpy = fs.readFileSync('src/server/trash.py', 'utf8');
  if (!trashpy.includes('def purge_bound_profiles')) throw new Error('trash.py 缺彻底清除连画像');
  return true;
});

check('删除链超时兜底全覆盖（T83）：三个删除/保存链 fetch 均带 AbortSignal.timeout', () => {
  const src = fs.readFileSync('src/static/js/session.js', 'utf8');
  for (const fn of ['_deleteOnServer', '_deleteGraphStateOnServer', '_postGraphState']) {
    const m = src.match(new RegExp('async function ' + fn + '\\([\\s\\S]*?\\n    \\}'));
    if (!m) throw new Error('session.js 缺 ' + fn);
    if (!m[0].includes('AbortSignal.timeout(')) throw new Error(fn + ' 仍无超时 signal（删除链会静默挂死）');
  }
  return true;
});

check('删除链超时兜底全覆盖（T194）：clearChat 与 _deleteKnowledgeOnServer 均带超时 signal、失败非静默', () => {
  const ssrc = fs.readFileSync('src/static/js/session.js', 'utf8');
  const cm = ssrc.match(/async function clearChat\([\s\S]*?\n    \}/);
  if (!cm) throw new Error('session.js 缺 clearChat');
  if (!cm[0].includes('AbortSignal.timeout(10000)')) throw new Error('clearChat 的 messages DELETE 仍无超时 signal（清空链首环挂死会静默停半路）');
  const ksrc = fs.readFileSync('src/static/js/knowledge.js', 'utf8');
  const km = ksrc.match(/async function _deleteKnowledgeOnServer\([\s\S]*?\n\}/);
  if (!km) throw new Error('knowledge.js 缺 _deleteKnowledgeOnServer');
  if (!km[0].includes('AbortSignal.timeout(10000)')) throw new Error('_deleteKnowledgeOnServer 仍无超时 signal（挂死一条卡整条删除链）');
  if (!km[0].includes('resp.ok')) throw new Error('_deleteKnowledgeOnServer 非 ok 状态静默（须补 warn）');
  return true;
});

check('删除链超时兜底全覆盖（T195）：公式两处 DELETE 与 quiz bank 全局 DELETE 均带超时 signal', () => {
  const ksrc = fs.readFileSync('src/static/js/knowledge.js', 'utf8');
  const bs = ksrc.match(/async function deleteFormulasBySession\([\s\S]*?\n\}/);
  if (!bs) throw new Error('knowledge.js 缺 deleteFormulasBySession');
  if (!bs[0].includes('AbortSignal.timeout(10000)')) throw new Error('deleteFormulasBySession 整段 DELETE 仍无超时 signal（挂死卡住清空/删会话链收尾）');
  if (!bs[0].includes('!resp.ok')) throw new Error('deleteFormulasBySession 非 ok 状态静默（须补 warn）');
  const df = ksrc.match(/async function confirmDeleteFormula\([\s\S]*?\n\}/);
  if (!df) throw new Error('knowledge.js 缺 confirmDeleteFormula');
  if (!df[0].includes('AbortSignal.timeout(10000)')) throw new Error('confirmDeleteFormula 单条 DELETE 仍无超时 signal');
  if (!df[0].includes('!resp.ok')) throw new Error('confirmDeleteFormula 非 ok 状态静默（须补 warn）');
  const ssrc = fs.readFileSync('src/static/js/session.js', 'utf8');
  if (!ssrc.includes("fetch('/api/kv/phymathia_quiz_bank', { method: 'DELETE', signal: AbortSignal.timeout(10000) })")) throw new Error('clearAllSessions 的 quiz bank 全局 DELETE 仍无超时 signal');
  return true;
});
}
