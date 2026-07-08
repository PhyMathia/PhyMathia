// ====== 存储键名常量 ======
const STORAGE_KEY_THEME = 'phymathia_theme';
const STORAGE_KEY_LEVEL = 'phymathia_level';
const STORAGE_KEY_SESSIONS = 'phymathia_sessions';
const STORAGE_KEY_CURRENT = 'phymathia_current_session';
const STORAGE_KEY_KNOWLEDGE = 'phymathia_knowledge';
const ONBOARDING_KEY = 'phymathia_onboarding_done';

// ====== 难度等级配置 ======
const LEVEL_LABELS = { 'middle': '🏫 中学', 'university': '🎓 大学', 'research': '🔬 科研' };
const LEVEL_PROMPTS = {
  'middle': '（用户是初高中学生，请用最通俗易懂的语言讲解，避免使用大学水平的术语，多用生活中的类比，公式尽量简化，数学推导步骤详细不跳步）',
  'university': '（用户是大学生，请用标准大学物理/数学的教学深度讲解，可以使用专业术语但需要解释，推导步骤完整）',
  'research': '（用户是科研人员，请用学术深度讲解，可以使用高级数学工具和前沿研究视角，推导可以简略关键步骤，关注物理本质和数学结构的深层联系）'
};

// ====== 对话图标选项 ======
const ICON_OPTIONS = ['📐', '⚛️', '🧲', '⚡', '🌀', '🔭', '📏', '🧪'];

// ====== 等待提示语 ======
const waitingTips = [
  '仍在处理中，好内容值得等待...',
  '小贴士：试试点击延伸思考的问题按钮，一键深入探索！',
  '正在为你深度解析，请稍候...',
  '小贴士：生成的交互式HTML可以拖动滑块实时调参，体验感拉满！',
  '公式推导需要点时间，马上就好~',
  '小贴士：知识图谱里的概念都可以继续追问，探索更多关联',
  '可视化正在生成中，精彩即将呈现...',
  '小贴士：点击左上角菜单可以管理多个对话会话',
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
  securityLevel: 'loose',
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
