// 技能界面（2026-11-16 第 4 步）：分析卡上的「技能：…」标签 ＋ 设置页技能按节点分组。
// 范围：_graphSkillPlanChipHtml 的渲染/不渲染边界、名字缓存与就地换字、
//       _settingsSkillGroups 的分组口径（byModule 优先、缺时按 scope 现算）。
// 纯同步用例：全部直接调沙箱里的真函数，不碰 DOM（换字那条用空 DOM 桩验证不抛）。
import { check, sandbox, fs } from './_runner.mjs';

const readSrc = (p) => fs.readFileSync(p, 'utf8');

function analysisNode(plan) {
  return {
    id: 'n1', kind: 'answer', manual: false, messageIndex: -1,
    analysis: '概要…', skillPlan: plan
  };
}

export function run() {
  check('skills-ui: 计划块两种形状都解析（{"viz":id} 与 {"viz":id,"why":"…"}），none/坏 JSON 当没计划', () => {
    const flat = sandbox._extractSkillPlan('<skill_plan>{"viz":"iso-cutaway"}</skill_plan>');
    if (!flat || flat.picks.viz !== 'iso-cutaway') throw new Error('扁平形状解析失败');
    const withWhy = sandbox._extractSkillPlan('<skill_plan>{"viz":"iso-cutaway","why":"装置内部结构"}</skill_plan>');
    if (!withWhy || withWhy.picks.viz !== 'iso-cutaway') throw new Error('带 why 的形状解析失败');
    if (withWhy.why !== '装置内部结构') throw new Error('why 没取到：' + withWhy.why);
    const wrapped = sandbox._extractSkillPlan('<skill_plan>{"picks":{"viz":"iso-cutaway"},"why":"x"}</skill_plan>');
    if (!wrapped || wrapped.picks.viz !== 'iso-cutaway') throw new Error('picks 包裹形状解析失败');
    if (sandbox._extractSkillPlan('<skill_plan>none</skill_plan>') !== null) throw new Error('none 应当作没有计划');
    if (sandbox._extractSkillPlan('<skill_plan>{oops</skill_plan>') !== null) throw new Error('坏 JSON 应当作没有计划');
    return true;
  });

  check('skills-ui: 分析卡有计划才渲染「技能：」标签，单条显示「节点 · 技能名」并可展开', () => {
    const prevNames = sandbox.window.__phymathiaSkillNames;
    sandbox.window.__phymathiaSkillNames = { 'iso-cutaway': '等距剖视画法' };
    try {
      const html = sandbox._graphSkillPlanChipHtml(analysisNode({
        picks: { viz: 'iso-cutaway' }, why: '这道题问内部结构，用剖视更能看出装配关系'
      }));
      if (!html.includes('graph-skill-chip')) throw new Error('没有渲染技能标签');
      if (!html.includes('技能：')) throw new Error('缺「技能：」前缀');
      if (!html.includes('交互可视化 · 等距剖视画法')) throw new Error('标签没拼成「节点 · 技能名」：' + html.slice(0, 160));
      if (!html.includes('data-skill-id="iso-cutaway"')) throw new Error('缺 data-skill-id（名字晚到时就地换字靠它定位）');
      if (!html.includes('剖视更能看出装配关系')) throw new Error('没把理由铺开在可展开区里');
      if (!html.includes('<details') || !html.includes('<summary')) throw new Error('理由区应是 details/summary（原生开合，零 JS 状态）');
      return true;
    } finally {
      if (prevNames === undefined) delete sandbox.window.__phymathiaSkillNames;
      else sandbox.window.__phymathiaSkillNames = prevNames;
    }
  });

  check('skills-ui: 整卡渲染把标签接在正文之后（有图就出现、没图就整块没有）', () => {
    const prevNames = sandbox.window.__phymathiaSkillNames;
    const prevMd = sandbox.renderMarkdown;
    sandbox.window.__phymathiaSkillNames = { 'iso-cutaway': '等距剖视画法' };
    // 整卡渲染会走 renderMarkdown（依赖 vendor 的 marked，沙箱里没有），换最小桩
    sandbox.renderMarkdown = (text) => '<p>' + String(text) + '</p>';
    const state = { collapsed: {}, hidden: {}, expandedAnswers: {}, openedModules: {}, positions: {}, sizes: {}, pinned: {} };
    const node = {
      id: 'n_chip', kind: 'answer', manual: false, messageIndex: -1, x: 0, y: 0, w: 200, h: 100,
      analysis: '概要正文', content: '',
      skillPlan: { picks: { viz: 'iso-cutaway' }, why: '装置内部结构', at: 1 }
    };
    try {
      const html = sandbox._renderNodeHtml(node, [], state);
      if (!html.includes('graph-skill-chip')) throw new Error('整卡里没有接上技能标签');
      if (html.indexOf('graph-skill-chip') < html.indexOf('graph-node-full-content')) {
        throw new Error('标签应在正文之后，不该插在标题/正文之前');
      }
      const plain = Object.assign({}, node);
      delete plain.skillPlan;
      if (sandbox._renderNodeHtml(plain, [], state).includes('graph-skill-chip')) {
        throw new Error('没有计划时整卡不该产出标签');
      }
      return true;
    } finally {
      if (prevNames === undefined) delete sandbox.window.__phymathiaSkillNames;
      else sandbox.window.__phymathiaSkillNames = prevNames;
      sandbox.renderMarkdown = prevMd;
    }
  });

  check('skills-ui: 没挂技能 / 挂空 / 非分析卡一律不渲染（数学题不该多出标签）', () => {
    const none = ['', null, undefined, {}, { picks: {} }, { picks: { viz: '' } }, { picks: { viz: null } }];
    for (const plan of none) {
      const html = sandbox._graphSkillPlanChipHtml(analysisNode(plan));
      if (html !== '') throw new Error('没有有效计划时应返回空串，实得：' + String(html).slice(0, 80));
    }
    const manual = Object.assign(analysisNode({ picks: { viz: 'iso-cutaway' } }), { manual: true });
    if (sandbox._graphSkillPlanChipHtml(manual) !== '') throw new Error('手工回答卡不该显示技能标签');
    const socratic = Object.assign(analysisNode({ picks: { viz: 'iso-cutaway' } }), { socraticMeta: { stage: 'x' } });
    if (sandbox._graphSkillPlanChipHtml(socratic) !== '') throw new Error('苏格拉底反馈卡不该显示技能标签');
    const inChat = Object.assign(analysisNode({ picks: { viz: 'iso-cutaway' } }), { messageIndex: 3 });
    if (sandbox._graphSkillPlanChipHtml(inChat) !== '') throw new Error('消息链节点不该显示技能标签');
    return true;
  });

  check('skills-ui: 理由与技能名按文本转义渲染（模型吐的尖括号不能变成 DOM）', () => {
    const prevNames = sandbox.window.__phymathiaSkillNames;
    sandbox.window.__phymathiaSkillNames = { 'iso-cutaway': '剖视<b>画法</b>' };
    try {
      const html = sandbox._graphSkillPlanChipHtml(analysisNode({
        picks: { viz: 'iso-cutaway' }, why: '<img src=x onerror=alert(1)>'
      }));
      if (html.includes('<img')) throw new Error('理由未转义，直出了 <img>');
      if (html.includes('<b>画法')) throw new Error('技能名未转义，直出了 <b>');
      if (!html.includes('&lt;img')) throw new Error('理由没有按文本转义（应见 &lt;img）');
      return true;
    } finally {
      if (prevNames === undefined) delete sandbox.window.__phymathiaSkillNames;
      else sandbox.window.__phymathiaSkillNames = prevNames;
    }
  });

  check('skills-ui: 名字缓存缺位时退回 id 且不阻塞渲染；换字函数在无 DOM 环境不抛', () => {
    const prevNames = sandbox.window.__phymathiaSkillNames;
    delete sandbox.window.__phymathiaSkillNames;
    try {
      const html = sandbox._graphSkillPlanChipHtml(analysisNode({ picks: { math: 'force-analysis' }, why: '' }));
      if (!html.includes('数学视角 · force-analysis')) throw new Error('没有名字时应退回 id，实得：' + html.slice(0, 160));
      if (!html.includes('没写理由')) throw new Error('空理由应有一句说明，而不是留白');
      sandbox._refreshSkillChips(); // 沙箱 document 是松散代理：只要不抛即算过
      return true;
    } finally {
      if (prevNames === undefined) delete sandbox.window.__phymathiaSkillNames;
      else sandbox.window.__phymathiaSkillNames = prevNames;
    }
  });

  check('skills-ui: 设置页按 byModule 分组（一条技能勾两个节点就在两组各出现一次）', () => {
    const items = [
      { id: 'iso-cutaway', name: '等距剖视画法', desc: '装置内部结构', scope: ['viz'], builtin: true, chars: 845 },
      { id: 'force-analysis', name: '受力分析七步', desc: '斜面/连接体', scope: ['physics', 'math'], builtin: false, chars: 500 }
    ];
    const byModule = {
      physics: ['force-analysis'], math: ['force-analysis'], graph: [],
      viz: ['iso-cutaway'], socratic: [], learn: []
    };
    const split = sandbox._settingsSkillGroups(items, byModule);
    if (split.groups.length !== 3) throw new Error('应分成 3 组（物理/数学/可视化），实为 ' + split.groups.length);
    const get = (key) => split.groups.filter(g => g.key === key)[0];
    if (!get('physics') || get('physics').items.length !== 1) throw new Error('物理视角组应有 1 条');
    if (!get('math') || get('math').items[0].id !== 'force-analysis') throw new Error('数学视角组应含 force-analysis');
    if (!get('viz') || get('viz').items[0].id !== 'iso-cutaway') throw new Error('交互可视化组应含 iso-cutaway');
    if (split.emptyLabels.length !== 3) throw new Error('未覆盖节点应报 3 个，实为 ' + split.emptyLabels.length);
    if (split.emptyLabels.indexOf('知识图谱') < 0) throw new Error('未覆盖节点里缺知识图谱');
    return true;
  });

  check('skills-ui: byModule 缺席时按 scope 现算分组（旧接口也不退化成一坨平铺）', () => {
    const items = [
      { id: 'a', name: 'A', scope: ['viz'] },
      { id: 'b', name: 'B', scope: ['physics', 'learn'] }
    ];
    const split = sandbox._settingsSkillGroups(items, {});
    const keys = split.groups.map(g => g.key).join(',');
    if (keys !== 'physics,viz,learn') throw new Error('按 scope 现算的分组不对：' + keys);
    return true;
  });

  check('skills-ui: 样式契约——标签走令牌圆角、且整块在最小化/无计划时不占位', () => {
    const css = readSrc('src/static/css/graph-override.css');
    if (!css.includes('.graph-skill-chip > summary.graph-skill-chip-summary')) throw new Error('缺标签 summary 样式');
    if (!/\.graph-skill-chip[^{]*\{[^}]*--r-sm/.test(css) && !/border-radius:\s*var\(--r-sm\)[^;]*;\s*color: var\(--text-secondary\)/.test(css)) {
      throw new Error('标签圆角应走 --r-sm 令牌（2026-11-21 小圆角化，不再用 --r-pill 大胶囊）');
    }
    if (!/max-width:\s*100%/.test(css) || !/box-sizing:\s*border-box/.test(css) || !/overflow-wrap:\s*anywhere/.test(css)) {
      throw new Error('长技能名换行须只长高不撑宽：max-width/box-sizing/overflow-wrap 三件套缺一');
    }
    if (!/\.graph-node\.minimized \.graph-skill-chip\s*\{[^}]*display:\s*none/.test(css)) {
      throw new Error('最小化卡应隐藏技能标签');
    }
    const render = readSrc('src/static/js/graph-render.js');
    if (!/const skillChipHtml = skipBody \? '' : _graphSkillPlanChipHtml\(node\)/.test(render)) {
      throw new Error('渲染入口应跳过最小化卡，且在无计划时留空');
    }
    const settings = readSrc('src/static/js/settings.js');
    if (!settings.includes('data.byModule')) throw new Error('设置页没有消费 byModule');
    return true;
  });
}
