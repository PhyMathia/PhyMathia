// ====== 应用版本 ======
const APP_VERSION = '1.5.1';

// ====== 本地多账号（P2 2026-10-07）：账号域 ======
// 账号指针与昵称缓存是「元键」，永远不加前缀；default 账号前缀为空——现有键
// 原样读写、零迁移。非 default 账号的所有 localStorage 键在物理层带
// `u<id前8位>_` 前缀，业务代码继续用逻辑键（'phymathia_*'），由下面的垫片
// 透明换算；服务端分域靠 fetch 包装给所有 /api/ 请求补 account_id
// （main.py _account_id 只认它、刻意不回退 device_id，论证见 accounts.py）。
const STORAGE_KEY_ACCOUNT = 'phymathia_account';
const STORAGE_KEY_ACCOUNT_NAME = 'phymathia_account_name';
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// 前缀纯函数：default / 非法指针 → ''（与旧版逐字节一致）；否则 `u<id前8位>_`
function accountLsPrefix(accountId) {
  return (accountId && accountId !== 'default' && ACCOUNT_ID_RE.test(accountId))
    ? 'u' + accountId.slice(0, 8) + '_' : '';
}
function _readAccountPointer() {
  try {
    const v = (localStorage.getItem(STORAGE_KEY_ACCOUNT) || '').trim();
    return (v && ACCOUNT_ID_RE.test(v)) ? v : 'default';
  } catch (e) { return 'default'; }
}
const ACCOUNT_ID = _readAccountPointer();
const ACCOUNT_LS_PREFIX = accountLsPrefix(ACCOUNT_ID);
// 原生存储引用：垫片装上后闭包留存，供 lsKeys() 枚举物理键用
const _RAW_LS = (typeof localStorage !== 'undefined') ? localStorage : null;

if (ACCOUNT_LS_PREFIX) {
  (function installAccountLsShim() {
    const P = ACCOUNT_LS_PREFIX;
    const shim = {
      getItem(k) { return _RAW_LS.getItem(P + k); },
      setItem(k, v) { _RAW_LS.setItem(P + k, String(v)); },
      removeItem(k) { _RAW_LS.removeItem(P + k); },
      key(i) { return lsKeys()[i] || null; },
      clear() { lsKeys().forEach(k => _RAW_LS.removeItem(P + k)); },
      get length() { return lsKeys().length; }
    };
    try {
      Object.defineProperty(window, 'localStorage', { get: () => shim, configurable: true });
    } catch (e) {
      // 极老浏览器等装不上垫片：退回无前缀（=default 命名空间），宁可串到
      // default 也不让页面瘫——账号切换后数据仍在服务端各账号域里
      console.warn('[accounts] localStorage 垫片安装失败，本页退回 default 命名空间');
    }
  })();
}

// 枚举当前账号命名空间的逻辑键（default = 物理键原样；否则前缀命中后剥前缀）。
// 「遍历键再回喂 getItem/removeItem」的代码（导出快照/清理白名单/迁移扫描）
// 必须走这里：垫片对象上 Object.keys 拿到的是方法名，会静默得到空集。
function lsKeys() {
  const out = [];
  try {
    const raw = _RAW_LS || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!raw || !raw.length) return out;
    for (let i = 0; i < raw.length; i++) {
      const k = raw.key(i);
      if (!k) continue;
      if (ACCOUNT_LS_PREFIX) {
        if (k.indexOf(ACCOUNT_LS_PREFIX) === 0) out.push(k.slice(ACCOUNT_LS_PREFIX.length));
      } else {
        out.push(k);
      }
    }
  } catch (e) {}
  return out;
}

// 所有 /api/ 请求恒带 account_id（含 default——P1 拍板服务端只认它）。
// 只重写「字符串 URL 且未带 account_id」的调用；Request 对象等少见形态保守
// 放行（服务端缺 account_id 落 default，不会错账）。
if (typeof fetch === 'function') {
  (function installAccountFetch() {
    const rawFetch = fetch;
    const wrapped = function (input, init) {
      try {
        if (typeof input === 'string' && input.indexOf('/api/') !== -1 && input.indexOf('account_id=') === -1) {
          input = input + (input.indexOf('?') === -1 ? '?' : '&') + 'account_id=' + encodeURIComponent(ACCOUNT_ID);
        }
      } catch (e) {}
      return rawFetch.call(this, input, init);
    };
    try { window.fetch = wrapped; } catch (e) {}
  })();
}

// ====== 存储键名常量 ======
const STORAGE_KEY_THEME = 'phymathia_theme';
// 壁纸挑选按深浅模式各记各的选择（ui.js 读写，键值＝WALLPAPER_SETS 的 id）
const STORAGE_KEY_BG_DARK = 'phymathia_bg_dark';
const STORAGE_KEY_BG_LIGHT = 'phymathia_bg_light';
// 主题翻转慢光栅判定（2026-10-01）：首切 LoAF 探测判慢机后落值（存判定时间戳，ms），
// 下次启动直接预挂 node-blur-lite——否则慢机每个会话的第一次切换都先吃一遍
// 磨砂重算风暴、探测才生效（用户实报「还是卡」的主因之一）。30 天过期重探，机器升级自愈。
const STORAGE_KEY_FLIP_SLOW = 'phymathia_flip_slow_raster';
// 节点皮肤模板（T128）：全局键，存当前模板 key（aurora=默认极光磨砂），与深浅主题同款机制
const STORAGE_KEY_NODE_SKIN = 'phymathia_node_skin';
// 风格家族（2026-10-02 用户拍板）：一个开关同时管面板质感＋节点皮肤＋强调色——
// data-panel-skin / data-node-skin 双属性同 key 同挂（家族即皮肤超集，杜绝「面板一个样、
// 节点另一个样」的零件级混搭）。缺键时从旧 phymathia_node_skin 折算（ui.js 迁移）。
const STORAGE_KEY_STYLE_FAMILY = 'phymathia_style_family';
// 深浅独立开关（2026-10-02 第三轮用户拍板）：默认两模式共用同一主题（点主题卡双写两侧、
// 翻深浅不换主题），勾选「深浅模式各自挑主题」后才按模式各记各的——家族走下面两条分模式键，
// 壁纸沿用上面两条 bg 键（联动只是「写时双写」，读侧永远按模式取键）。
const STORAGE_KEY_THEME_SPLIT = 'phymathia_theme_split';
const STORAGE_KEY_STYLE_FAMILY_DARK = 'phymathia_style_family_dark';
const STORAGE_KEY_STYLE_FAMILY_LIGHT = 'phymathia_style_family_light';
const STORAGE_KEY_LEVEL = 'phymathia_level';
const STORAGE_KEY_SESSIONS = 'phymathia_sessions';
const STORAGE_KEY_CURRENT = 'phymathia_current_session';
const STORAGE_KEY_KNOWLEDGE = 'phymathia_knowledge';
// 知识总览面板上次停留的标签页（knowledge/formulas，全局键；重开面板时恢复）
const STORAGE_KEY_KP_TAB = 'phymathia_kp_tab';
// 检测出题素材源偏好（mixed/ai/local，quiz-ui.js 写、quiz.js 读）
const STORAGE_KEY_QUIZ_SOURCE = 'phymathia_quiz_source';
const ONBOARDING_KEY = 'phymathia_onboarding_done';
const STORAGE_KEY_DEVICE_ID = 'phymathia_device_id';
// 节点配方库（P1）：全局键（不带会话后缀），localStorage 与服务端 /api/kv/node_recipes 双写
const STORAGE_KEY_NODE_RECIPES = 'phymathia_node_recipes';

// ===== Φ 智能体独立会话（2026-09-30 与画布解耦）======
// Φ 会话有独立 id 空间（phi_<uuid>），与画布会话（sess_<uuid>）互不隶属：
// 名单与当前指针走下面两个键（名单镜像到服务端 KV 全局键 phi_sessions 防换浏览器丢失）；
// 对话历史沿用 harness_history_ 前缀但挂 phi id（phymathia_harness_history_phi_<id>，
// 服务端 KV harness_history:phi_<id> 由 storage.py 的会话级前缀路由自动拆到 data/kv/phi_<id>.json）。
// 「清空画布」的键清单（session.js clearAllSessions）刻意不含这三个键——清画布不动 Φ 对话。
const STORAGE_KEY_PHI_SESSIONS = 'phymathia_phi_sessions';
const STORAGE_KEY_PHI_CURRENT = 'phymathia_current_phi_session';

// Φ 面板档位与容错开关（T97/T95 前端半边，2026-09-30）：都是用户级全局键，不带会话后缀。
// - 深度思考档位：''（自动，跟随模型默认）/ low / high / max，随 payload.thinking 上送，
//   具体参数映射由后端按供应商族做（与模型条目上的 thinking 字段同一套口径）。
// - 失败自动换备用模型：'1' 开 / '0' 关（默认关——兜底是用户开关不是默认，见评审路线 #10）。
const STORAGE_KEY_HARNESS_THINKING = 'phymathia_harness_thinking';
const STORAGE_KEY_HARNESS_FALLBACK = 'phymathia_harness_fallback';

// ====== 匿名设备 ID（用户画像隔离）======
function getDeviceId() {
  try {
    let id = localStorage.getItem(STORAGE_KEY_DEVICE_ID);
    if (!id) {
      id = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(STORAGE_KEY_DEVICE_ID, id);
    }
    return id;
  } catch (e) {
    return 'dev_local';
  }
}

// ====== 难度等级配置 ======
// 档位文案共三份手工同步（T132 防漂移）：改这里措辞必须同步
// src/server/config.py 的 LEVEL_PROMPTS（后端注入主聊天/文档/知识面板）与
// harness/prompts.py 的 _level_requirement（Φ 评审口径变体）。
const LEVEL_LABELS = { 'middle': '中学', 'university': '大学', 'research': '科研' };
const LEVEL_PROMPTS = {
  'middle': '（用户是初高中学生，请用最通俗易懂的语言讲解，避免使用大学水平的术语，多用生活中的类比，公式尽量简化，数学推导步骤详细不跳步）',
  'university': '（用户是大学生，请用标准大学物理/数学的教学深度讲解，可以使用专业术语但需要解释，推导步骤完整）',
  'research': '（用户是科研人员，请用学术深度讲解，可以使用高级数学工具和前沿研究视角，推导可以简略关键步骤，关注物理本质和数学结构的深层联系）'
};

function getCurrentLevelValue() {
  if (typeof currentLevel !== 'undefined' && currentLevel) return currentLevel;
  try {
    return localStorage.getItem(STORAGE_KEY_LEVEL) || 'university';
  } catch (e) {
    return 'university';
  }
}

function getLevelPrompt(level) {
  const resolved = level || getCurrentLevelValue();
  return '难度要求：' + (LEVEL_PROMPTS[resolved] || LEVEL_PROMPTS.university);
}

// ====== 通用线条图标 ======
const makeLineIcon = (body) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
const UI_ICON_SVG = {
  plus: makeLineIcon('<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>'),
  trash: makeLineIcon('<path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line>'),
  lightbulb: makeLineIcon('<path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"></path>'),
  moon: makeLineIcon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"></path>'),
  sun: makeLineIcon('<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>'),
  sliders: makeLineIcon('<line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line>'),
  database: makeLineIcon('<ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"></path><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"></path>'),
  book: makeLineIcon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path><line x1="9" y1="7" x2="16" y2="7"></line><line x1="9" y1="11" x2="14" y2="11"></line>'),
  formula: makeLineIcon('<path d="M6 6h12M6 12h12M6 18h8"></path><path d="M17 15l-2.5 3L17 21"></path>'),
  pencil: makeLineIcon('<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>'),
  reset: makeLineIcon('<path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-15-6.7L3 13"></path>'),
  school: makeLineIcon('<path d="M3 21h18M5 21V9l7-5 7 5v12"></path><path d="M9 21v-6h6v6"></path><path d="M9 10h.01M12 10h.01M15 10h.01"></path>'),
  cap: makeLineIcon('<path d="M22 10 12 5 2 10l10 5 10-5z"></path><path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5"></path>'),
  microscope: makeLineIcon('<path d="M6 18h12"></path><path d="M8 18a4 4 0 0 1 8 0"></path><path d="M12 18V8"></path><path d="M9 5h6l1 3H8z"></path>'),
  check: makeLineIcon('<path d="M20 6 9 17l-5-5"></path>'),
  key: makeLineIcon('<circle cx="7.5" cy="15.5" r="4"></circle><path d="M10.5 12.5 21 2M15 8l3 3M18 5l2 2"></path>'),
  monitor: makeLineIcon('<rect x="2" y="4" width="20" height="14" rx="2"></rect><line x1="8" y1="22" x2="16" y2="22"></line><line x1="12" y1="18" x2="12" y2="22"></line>'),
  copy: makeLineIcon('<rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>'),
  question: makeLineIcon('<circle cx="12" cy="12" r="9"></circle><path d="M9.2 9a3 3 0 0 1 5.8 1c0 1.6-2.5 2.1-2.5 4"></path><circle cx="12" cy="17.5" r=".5"></circle>'),
  expand: makeLineIcon('<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"></path>'),
  external: makeLineIcon('<path d="M14 3h7v7M21 3l-9 9"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>'),
  arrowRight: makeLineIcon('<path d="M5 12h14M13 5l7 7-7 7"></path>'),
  pointer: makeLineIcon('<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"></path>'),
  sparkles: makeLineIcon('<path d="M12 3l1.9 4.6 4.6 1.9-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"></path><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"></path>'),
  // 探索网右键菜单一族（M2 视觉细化）：菜单项按键名取图标，纯线性风格与上面一致
  target: makeLineIcon('<circle cx="12" cy="12" r="7.5"></circle><circle cx="12" cy="12" r="2.2"></circle><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"></path>'),
  clipboard: makeLineIcon('<rect x="8" y="3" width="8" height="4" rx="1.4"></rect><path d="M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"></path>'),
  download: makeLineIcon('<path d="M12 3v12"></path><path d="M7 11l5 5 5-5"></path><path d="M4 20h16"></path>'),
  undo: makeLineIcon('<path d="M9 14 4 9l5-5"></path><path d="M4 9h9a7 7 0 0 1 0 14H8"></path>'),
  // T121：Φ 面板「撤销历史」——时针＋回溯箭头，与 undo（纯回转箭头）区分
  history: makeLineIcon('<path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3L3 8.5"></path><path d="M3 3.5v5h5"></path><path d="M12 7.8V12l2.8 1.7"></path>'),
  redo: makeLineIcon('<path d="M15 14l5-5-5-5"></path><path d="M20 9h-9a7 7 0 0 0 0 14h5"></path>'),
  link: makeLineIcon('<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1 1"></path><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1-1"></path>'),
  curve: makeLineIcon('<path d="M3 19c0-9 4-14 9-14 4 0 6 3 6 6"></path><circle cx="3" cy="19" r="1.6"></circle><circle cx="18" cy="11" r="1.6"></circle>'),
  layout: makeLineIcon('<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"></rect><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"></rect><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"></rect><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"></rect>'),
  group: makeLineIcon('<rect x="3" y="3" width="18" height="18" rx="2.4" stroke-dasharray="4 3"></rect><rect x="7.5" y="7.5" width="4.6" height="4.6" rx="1"></rect><rect x="12.4" y="12.4" width="4.6" height="4.6" rx="1"></rect>'),
  selectAll: makeLineIcon('<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"></path><path d="M9 12h6"></path>'),
  frame: makeLineIcon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"></path><circle cx="12" cy="12" r="2.4"></circle>'),
  collapse: makeLineIcon('<path d="M9 4v6H3"></path><path d="M21 9h-6V3"></path><path d="M3 15h6v6"></path><path d="M15 21v-6h6"></path>'),
  note: makeLineIcon('<path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"></path><path d="M14 3v5h5"></path><path d="M9 13h6M9 17h4"></path>'),
  home: makeLineIcon('<path d="M4 20V10l8-6 8 6v10"></path><path d="M9.5 20v-6h5v6"></path>'),
  // 任务面板的播放控制（用户 2026-09-27：「暂停/停止/停别用文字，用图标」）。
  // pause/play 走线条；stop 例外用实心方块——空心方块缩到 12px 几乎看不出是"停"，
  // 靠 fill="currentColor" 吃按钮的墨色（hover/危险色照样跟）。
  pause: makeLineIcon('<path d="M9 5v14"></path><path d="M15 5v14"></path>'),
  play: makeLineIcon('<path d="M7 4.8v14.4L19 12z"></path>'),
  stop: makeLineIcon('<rect x="6.5" y="6.5" width="11" height="11" rx="1.6" fill="currentColor" stroke="none"></rect>'),
  // 知识面板「手动收藏」来源标记——线稿五角星，与 sparkles（AI 提取）在轮廓上区分得开
  star: makeLineIcon('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"></path>')
};
const LEVEL_ICON_SVG = {
  'middle': UI_ICON_SVG.school,
  'university': UI_ICON_SVG.cap,
  'research': UI_ICON_SVG.microscope
};

// ====== 对话图标选项 ======
const ICON_OPTIONS = [
  { id: 'mechanics', label: '力学', svg: makeLineIcon('<rect x="3" y="9" width="8" height="7" rx="1"></rect><path d="M13.5 12.5h6.5"></path><path d="M17 9.5l3 3-3 3"></path>') },
  { id: 'motion', label: '运动/抛体', svg: makeLineIcon('<path d="M3 18c3.5-11 10.5-12.5 15-4"></path><path d="M15.5 14.5l3.5-6.5 2.5 6.5"></path><path d="M19 13.5h-4"></path>') },
  { id: 'gravity', label: '引力/轨道', svg: makeLineIcon('<circle cx="11" cy="12" r="3"></circle><ellipse cx="11" cy="12" rx="8.5" ry="3.2" transform="rotate(-18 11 12)"></ellipse><circle cx="19" cy="9.8" r="1.1"></circle>') },
  { id: 'wave', label: '波动/振动', svg: makeLineIcon('<path d="M3 12c1.6-5 3.2-5 4.8 0s3.2 5 4.8 0 3.2-5 4.8 0 3.2 5 4.8 0"></path>') },
  { id: 'light', label: '光/光学', svg: makeLineIcon('<circle cx="12" cy="12" r="3"></circle><path d="M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2M6.8 6.8l1.4 1.4M15.8 15.8l1.4 1.4M17.2 6.8l-1.4 1.4M8.2 15.8l-1.4 1.4"></path>') },
  { id: 'electromagnetism', label: '电磁', svg: makeLineIcon('<path d="M13.5 2.5 6 13h5l-2.5 8.5L16.5 11h-5l2-8.5z"></path>') },
  { id: 'magnet', label: '磁场', svg: makeLineIcon('<path d="M5 3h4v8a3 3 0 0 1-6 0V3z"></path><path d="M15 3h4v8a3 3 0 0 1-6 0V3z"></path><path d="M9 11v3M15 11v3M9 6h6"></path>') },
  { id: 'circuit', label: '电路', svg: makeLineIcon('<path d="M3 12h2M8 12h8M19 12h2"></path><rect x="4.5" y="8" width="3.5" height="8" rx=".5"></rect><rect x="16" y="8" width="3.5" height="8" rx=".5"></rect><path d="M6 10v4M5 12h3M18 10v4M17 12h3"></path>') },
  { id: 'thermal', label: '热学', svg: makeLineIcon('<path d="M12 3a2 2 0 0 1 2 2v8.3a4.5 4.5 0 1 1-4 0V5a2 2 0 0 1 2-2z"></path><path d="M12 8v6"></path>') },
  { id: 'quantum', label: '量子', svg: makeLineIcon('<circle cx="12" cy="12" r="1.2"></circle><ellipse cx="12" cy="12" rx="8.5" ry="3.4" transform="rotate(28 12 12)"></ellipse><ellipse cx="12" cy="12" rx="8.5" ry="3.4" transform="rotate(-28 12 12)"></ellipse><ellipse cx="12" cy="12" rx="8.5" ry="3.4"></ellipse>') },
  { id: 'astronomy', label: '天体力学', svg: makeLineIcon('<circle cx="12" cy="12" r="2.2"></circle><ellipse cx="12" cy="12" rx="8.5" ry="3.2" transform="rotate(-22 12 12)"></ellipse><circle cx="19.5" cy="9.5" r="1"></circle>') },
  { id: 'fluid', label: '流体', svg: makeLineIcon('<path d="M12 3.2c3.2 3.7 5 6.2 5 9a5 5 0 0 1-10 0c0-2.8 1.8-5.3 5-9z"></path><path d="M9.8 13.5a2.4 2.4 0 0 0 1.6 2.3"></path>') },
  { id: 'collision', label: '碰撞', svg: makeLineIcon('<circle cx="7" cy="12" r="3"></circle><circle cx="17" cy="12" r="3"></circle><path d="M10 12h4"></path><path d="M4 8V5M4 5h3M20 16v3M20 19h-3"></path>') },
  { id: 'energy', label: '能量/功率', svg: makeLineIcon('<path d="M4 18a8 8 0 1 1 16 0"></path><path d="M12 18l4-5"></path><path d="M12 10v4"></path>') },
  { id: 'optics', label: '透镜/折射', svg: makeLineIcon('<path d="M12 3.5 20 20H4z"></path><path d="M12 3.5V20"></path><path d="M7 12h10"></path>') },
  { id: 'sound', label: '声波', svg: makeLineIcon('<path d="M5 10v4h3l4 3V7l-4 3H5z"></path><path d="M15 9a4 4 0 0 1 0 6"></path><path d="M17.5 6.5a7 7 0 0 1 0 11"></path>') },
  { id: 'relativity', label: '相对论/时空', svg: makeLineIcon('<circle cx="12" cy="12" r="7.5"></circle><path d="M12 8v4l2.5 2"></path><path d="M4 12h3M17 12h3"></path>') },
  { id: 'particle', label: '粒子/核', svg: makeLineIcon('<circle cx="8.5" cy="12" r="1.1"></circle><circle cx="16" cy="8.5" r="1.1"></circle><circle cx="16" cy="15.5" r="1.1"></circle><ellipse cx="12" cy="12" rx="7.5" ry="3" transform="rotate(-24 12 12)"></ellipse><ellipse cx="12" cy="12" rx="7.5" ry="3" transform="rotate(24 12 12)"></ellipse>') },
  { id: 'function', label: '函数', svg: makeLineIcon('<path d="M4 17c2-13 5-13 7 0s5 13 7 0"></path>') },
  { id: 'geometry', label: '几何', svg: makeLineIcon('<circle cx="12" cy="12" r="8"></circle><path d="M12 4 16.5 17h-9L12 4z"></path>') },
  { id: 'matrix', label: '矩阵', svg: makeLineIcon('<path d="M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2"></path><path d="M10 9h4M10 12h4M10 15h4"></path>') },
  { id: 'vector', label: '向量', svg: makeLineIcon('<path d="M4 20 20 4M14 4h6v6M4 20l6-6"></path>') },
  { id: 'probability', label: '概率/统计', svg: makeLineIcon('<path d="M4 18c3.5-11 12.5-11 16 0"></path><path d="M4 18h16M10 18c0-2.5 4-2.5 4 0"></path>') },
  { id: 'logic', label: '集合/逻辑', svg: makeLineIcon('<circle cx="9.5" cy="12" r="5"></circle><circle cx="14.5" cy="12" r="5"></circle>') },
  { id: 'graph', label: '图论/知识图谱', svg: makeLineIcon('<circle cx="6" cy="6" r="2"></circle><circle cx="18" cy="8" r="2"></circle><circle cx="10" cy="17" r="2"></circle><path d="M8 7l8 0M7.5 8l1.5 7M17.5 9.5l-5.5 5.5"></path>') },
  { id: 'calculus', label: '微积分', svg: makeLineIcon('<path d="M4 17c2-11 6-11 8 0s6 11 8 0"></path><path d="M12 6v12"></path>') },
  { id: 'sequence', label: '数列', svg: makeLineIcon('<path d="M5 8h4M5 12h7M5 16h10"></path>') },
  { id: 'pi', label: '圆周率 π', svg: 'π' },
  { id: 'integral', label: '积分 ∫', svg: '∫' },
  { id: 'summation', label: '求和 ∑', svg: '∑' },
  { id: 'root', label: '根号 √', svg: '√' },
  { id: 'infinity', label: '无穷 ∞', svg: '∞' },
  { id: 'delta', label: '变化量 Δ', svg: 'Δ' },
  { id: 'gradient', label: '梯度/场 ∇', svg: '∇' },
  { id: 'partial', label: '偏导数 ∂', svg: '∂' },
  { id: 'belongs', label: '属于 ∈', svg: '∈' }
];
const ICON_PAGE_SIZE = 9;

// ====== 背景图片 URL ======
const DARK_LAND_URL = '/bg_dark_landscape.jpg';
const DARK_PORT_URL = '/bg_dark_portrait.jpg';
const LIGHT_LAND_URL = '/bg_light_landscape.jpg';
const LIGHT_PORT_URL = '/bg_light_portrait.jpg';
// 成对主题壁纸：每套深浅各含横/竖两张。新增一套＝4 张资源进 src/static＋在此加一行，
// 挑选器（ui.js renderBgPanel）自动出卡。id 存进 phymathia_bg_dark / _bg_light。
// symbols（2026-10-02 用户拍板「符号只变色不换字符集＋数量随主题」）：飘浮符号的颜色/
// 光晕/透明度系数按壁纸套配置（深浅各一档），count 为桌面数量（星夜显眼偏少、素纸底
// 素净偏多、山影中等；移动端按 18/33 比例折算，ui.js __syncFloatingSymbols 换套重建）。
// 色值本体（T166 收编）在 styles.css「壁纸飘浮符号配色」令牌区，这里只引用令牌名。
const WALLPAPER_SETS = [
  { id: 'night', name: '星夜',
    dark: { land: DARK_LAND_URL, port: DARK_PORT_URL },
    light: { land: LIGHT_LAND_URL, port: LIGHT_PORT_URL },
    symbols: {
      dark: { color: 'var(--sym-night-dark-ink)', glow: 'var(--sym-night-dark-glow)', glowSize: 8, opacity: 1 },
      light: { color: 'var(--sym-night-light-ink)', glow: 'var(--sym-night-light-glow)', glowSize: 6, opacity: 1 },
      count: 33 } },
  { id: 'paper', name: '素纸',
    dark: { land: '/bg_paper_dark_landscape.jpg', port: '/bg_paper_dark_portrait.jpg' },
    light: { land: '/bg_paper_light_landscape.jpg', port: '/bg_paper_light_portrait.jpg' },
    symbols: {
      dark: { color: 'var(--sym-paper-dark-ink)', glow: 'var(--sym-paper-dark-glow)', glowSize: 7, opacity: 0.9 },
      light: { color: 'var(--sym-paper-light-ink)', glow: 'var(--sym-paper-light-glow)', glowSize: 5, opacity: 0.8 },
      count: 42 } },
  { id: 'mountain', name: '山影',
    dark: { land: '/bg_mountain_dark_landscape.jpg', port: '/bg_mountain_dark_portrait.jpg' },
    light: { land: '/bg_mountain_light_landscape.jpg', port: '/bg_mountain_light_portrait.jpg' },
    symbols: {
      dark: { color: 'var(--sym-mountain-dark-ink)', glow: 'var(--sym-mountain-dark-glow)', glowSize: 7, opacity: 0.9 },
      light: { color: 'var(--sym-mountain-light-ink)', glow: 'var(--sym-mountain-light-glow)', glowSize: 5, opacity: 0.85 },
      count: 28 } },
  { id: 'neon', name: '霓虹',
    dark: { land: '/bg_neon_dark_landscape.jpg', port: '/bg_neon_dark_portrait.jpg' },
    light: { land: '/bg_neon_light_landscape.jpg', port: '/bg_neon_light_portrait.jpg' },
    symbols: {
      dark: { color: 'var(--sym-neon-dark-ink)', glow: 'var(--sym-neon-dark-glow)', glowSize: 8, opacity: 0.95 },
      light: { color: 'var(--sym-neon-light-ink)', glow: 'var(--sym-neon-light-glow)', glowSize: 5, opacity: 0.85 },
      count: 36 } },
  { id: 'candy', name: '糖果',
    dark: { land: '/bg_candy_dark_landscape.jpg', port: '/bg_candy_dark_portrait.jpg' },
    light: { land: '/bg_candy_light_landscape.jpg', port: '/bg_candy_light_portrait.jpg' },
    symbols: {
      dark: { color: 'var(--sym-candy-dark-ink)', glow: 'var(--sym-candy-dark-glow)', glowSize: 7, opacity: 0.9 },
      light: { color: 'var(--sym-candy-light-ink)', glow: 'var(--sym-candy-light-glow)', glowSize: 5, opacity: 0.8 },
      count: 33 } }
];

// ====== 风格家族（2026-10-02 用户拍板：面板质感＋节点皮肤＋强调色焊成一个开关）======
// 每族一个 key，同时驱动 html 根的 data-panel-skin 与 data-node-skin 两属性＋一组
// 强调色/输入框底色覆盖（styles.css「风格家族面板质感」节）。默认族 aurora＝现状极光
// 玻璃，不挂属性、零 CSS 差异。★ key 三处必须同值：STYLE_FAMILIES ↔ GRAPH_NODE_SKINS
// （ui.js）↔ styles.css [data-panel-skin="<key>"] / graph-override.css [data-node-skin]，
// 加新家族＝四处同步（css 两块 + 两个注册表 + 启动预置自动跟随）。
const STYLE_FAMILIES = [
  { key: 'aurora', label: '极光磨砂', desc: '玻璃上的缓慢极光色斑（默认）' },
  { key: 'blueprint', label: '蓝图制图', desc: '绘图纸面＋淡网格＋蓝图蓝（素纸主题默认）' },
  { key: 'inkstone', label: '砚石·墨韵', desc: '青黑哑光石面＋石纹描边（山影主题默认）' },
  { key: 'neon', label: '霓虹夜光', desc: '近黑玻璃＋霓虹描边与流动光斑' },
  { key: 'candy', label: '糖果磨砂', desc: '暗面柔紫玻璃＋马卡龙柔光' },
];
// 主题（壁纸套 id）→ 默认风格家族：点主题卡＝换壁纸＋风格重置到这行（手动选风格
// 只活到下次点主题卡，Q2 拍板「切主题＝全套重置」）。壁纸套与家族解耦：任何壁纸
// 可配任何家族。新增壁纸套时在此补一行默认族，缺行安全回落 aurora。
const THEME_DEFAULT_FAMILY = { night: 'aurora', paper: 'blueprint', mountain: 'inkstone', neon: 'neon', candy: 'candy' };

// ====== 粒子特效参数 ======
const SYMBOL_COUNT = (window.innerWidth <= 768) ? 18 : 33;
const REPEL_RADIUS = 120;
const REPEL_STRENGTH = 0.6;
const MAX_PARTICLES = (window.innerWidth <= 768) ? 80 : 150;

// ====== 主题初始化 ======
const initIsDark = localStorage.getItem(STORAGE_KEY_THEME) !== 'light';

// ====== Mermaid 配置（懒加载，由 mermaid-loader 在首次需要时应用） ======
// 色值（T166 收编）在 styles.css「Mermaid 图主题变量」令牌区（--mm-*，深浅各一套），
// 这里按当前 data-theme 读计算值——themeVariables 必须是真色值（Mermaid 会做颜色运算）。
// 注意：config.js 早于 utils.js 加载（本文件顶层的 configureMermaid 调用就在加载期跑），
// 故用本文件私有读取、不引用 cssVarValue——同 graph-poster 的 _var，各文件私有实现。
function _cfgToken(name) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch (e) { return ''; }
}
function getMermaidConfig(isDark) {
  const v = _cfgToken;
  return {
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'strict',
    themeVariables: {
      primaryColor: v('--mm-bg'), primaryTextColor: v('--mm-ink'),
      primaryBorderColor: v('--mm-border'), lineColor: v('--mm-line'),
      secondaryColor: v('--mm-secondary'), tertiaryColor: v('--mm-tertiary'),
      mainBkg: v('--mm-bg'), nodeBorder: v('--mm-border'),
      clusterBkg: v('--mm-tertiary'), clusterBorder: v('--mm-border'),
      titleColor: v('--mm-ink'), edgeLabelBackground: v('--mm-bg'),
      fontFamily: 'inherit'
    }
  };
}

if (typeof configureMermaid === 'function') {
  configureMermaid(getMermaidConfig(initIsDark));
}
