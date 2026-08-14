// ====== 应用版本 ======
const APP_VERSION = '1.2.6';

// ====== 存储键名常量 ======
const STORAGE_KEY_THEME = 'phymathia_theme';
const STORAGE_KEY_LEVEL = 'phymathia_level';
const STORAGE_KEY_SESSIONS = 'phymathia_sessions';
const STORAGE_KEY_CURRENT = 'phymathia_current_session';
const STORAGE_KEY_KNOWLEDGE = 'phymathia_knowledge';
const ONBOARDING_KEY = 'phymathia_onboarding_done';
const STORAGE_KEY_DEVICE_ID = 'phymathia_device_id';

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
  sparkles: makeLineIcon('<path d="M12 3l1.9 4.6 4.6 1.9-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"></path><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"></path>')
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

// ====== 等待提示语 ======
const waitingTips = [
  '仍在处理中，好内容值得等待...',
  '小贴士：试试点击延伸思考的问题按钮，一键深入探索！',
  '正在为你深度解析，请稍候...',
  '小贴士：生成的交互式HTML可以拖动滑块实时调参，体验感拉满！',
  '公式推导需要点时间，马上就好~',
  '小贴士：知识图谱里的概念都可以继续追问，探索更多关联',
  '可视化正在生成中，精彩即将呈现...',
  '小贴士：点击左上角菜单可以管理多张画布',
  '知识图谱正在构建，请耐心等待...',
  '小贴士：试试切换难度等级（中学/大学/科研），不同深度不同收获',
  '小贴士：点击右上角可以切换深色/浅色模式',
  '小贴士：可视化HTML里的「没看懂」按钮可以一键复制问题回来问',
  '小贴士：长按麦克风按钮说话，松开自动发送，上滑可取消',
  '小贴士：追问「换个类比解释」可以让PhyMathia用新方式讲解',
  '小贴士：推荐使用电脑端访问，交互式可视化效果最佳',
];

// ====== 背景图片 URL ======
const DARK_LAND_URL = '/bg_dark_landscape.jpg';
const DARK_PORT_URL = '/bg_dark_portrait.jpg';
const LIGHT_LAND_URL = '/bg_light_landscape.jpg';
const LIGHT_PORT_URL = '/bg_light_portrait.jpg';

// ====== 智能滚动与语音阈值 ======
const SCROLL_THRESHOLD = 80;
const VOICE_CANCEL_THRESHOLD = 80;

// ====== 粒子特效参数 ======
const SYMBOL_COUNT = (window.innerWidth <= 768) ? 18 : 33;
const REPEL_RADIUS = 120;
const REPEL_STRENGTH = 0.6;
const MAX_PARTICLES = (window.innerWidth <= 768) ? 80 : 150;

// ====== 上下文轮次 ======
const MAX_CONTEXT_ROUNDS = 3;

// ====== 主题初始化 ======
const initIsDark = localStorage.getItem(STORAGE_KEY_THEME) !== 'light';

// ====== Mermaid 初始化 ======
mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  securityLevel: 'strict',
  themeVariables: initIsDark ? {
    primaryColor: '#0c2d3e', primaryTextColor: '#a5f3fc',
    primaryBorderColor: '#0891b2', lineColor: '#22d3ee',
    secondaryColor: '#0f3649', tertiaryColor: '#0a2533',
    mainBkg: '#0c2d3e', nodeBorder: '#0891b2',
    clusterBkg: '#0a2533', clusterBorder: '#0891b2',
    titleColor: '#a5f3fc', edgeLabelBackground: '#0c2d3e',
    fontFamily: 'inherit'
  } : {
    primaryColor: '#f0fdfa', primaryTextColor: '#134e4a',
    primaryBorderColor: '#0891b2', lineColor: '#0891b2',
    secondaryColor: '#f0fdfa', tertiaryColor: '#ecfdf5',
    mainBkg: '#f0fdfa', nodeBorder: '#0891b2',
    clusterBkg: '#ecfdf5', clusterBorder: '#0891b2',
    titleColor: '#134e4a', edgeLabelBackground: '#f0fdfa',
    fontFamily: 'inherit'
  }
});
