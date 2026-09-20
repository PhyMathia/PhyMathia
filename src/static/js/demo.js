// ====== 演示会话（新手引导用）：真实示例内容，引导时高亮真实探索网 ======
const DEMO_SESSION_ID = 'sess_demo_moon';
const DEMO_SESSION_TITLE = '示例 · 月亮为什么不会掉下来';

function _buildDemoVizHtml() {
  return '<div style="text-align:center;font-family:system-ui,sans-serif;padding:6px">'
    + '<canvas id="moonOrbit" width="230" height="230" style="max-width:100%;border-radius:14px;background:#0b1224"></canvas>'
    + '<div style="margin-top:10px;display:flex;align-items:center;justify-content:center;gap:10px">'
    + '<span style="color:#94a3b8;font-size:12px">切向速度</span>'
    + '<input id="moonV" type="range" min="0" max="2" step="0.01" value="1" style="width:150px;accent-color:#f59e0b">'
    + '</div>'
    + '<p style="color:#64748b;font-size:11px;margin:8px 0 2px">拖拽滑块：速度过慢会坠向地球，过快会逃逸</p>'
    + '<script>'
    + '(function(){var c=document.getElementById("moonOrbit");if(!c)return;var x=c.getContext("2d");var s=document.getElementById("moonV");var R=85,a=0;function draw(){x.clearRect(0,0,230,230);x.strokeStyle="#1e293b";x.lineWidth=2;x.beginPath();x.arc(115,115,R,0,Math.PI*2);x.stroke();x.fillStyle="#60a5fa";x.beginPath();x.arc(115,115,11,0,Math.PI*2);x.fill();var v=parseFloat(s.value);if(v>0.05)a+=0.025*v;var px=115+R*Math.cos(a),py=115+R*Math.sin(a);x.fillStyle=v>1.15?"#f87171":(v<0.45?"#fbbf24":"#e2e8f0");x.beginPath();x.arc(px,py,7,0,Math.PI*2);x.fill();x.strokeStyle="rgba(148,163,184,.5)";x.beginPath();x.moveTo(115,115);x.lineTo(px,py);x.stroke();requestAnimationFrame(draw);}draw();})();'
    + '<\/script>'
    + '</div>';
}

function _buildDemoAnswer() {
  const viz = _buildDemoVizHtml();
  return [
    '<summary>月亮绕地球运动时，地球引力只改变它的运动方向，因此它一直在"下落"却永远掉不到地上。</summary>',
    '',
    '<physics>',
    '**物理直觉：牛顿的大炮**',
    '想象在山顶水平发射炮弹：速度越快，落地前飞得越远。当速度达到约 7.9 km/s 时，炮弹下落的弧线恰好与地球表面的弯曲重合——它一直在"往下掉"，却永远掉不到地上。',
    '月亮正是这样的"炮弹"：地球的引力（<formula>F=\\frac{GMm}{r^2}</formula>）不断把它拉向地球，而它的切向速度让落点不断"错过"地球，最终形成稳定的圆周轨道。',
    '</physics>',
    '',
    '<math>',
    '**数学本质：引力提供向心力**',
    '设月球质量 m、轨道半径 r、线速度 v：',
    '',
    '- 万有引力恰好等于向心力：<formula>\\frac{GMm}{r^2}=\\frac{mv^2}{r}</formula>',
    '- 消去 m，得到轨道速度：<formula>v=\\sqrt{\\frac{GM}{r}}</formula>',
    '- 代入 <formula>M=5.97\\times10^{24}\\ \\mathrm{kg}</formula>、<formula>r=3.84\\times10^{8}\\ \\mathrm{m}</formula>，得 <formula>v\\approx1.02\\ \\mathrm{km/s}</formula>，与月球实际速度一致。',
    '',
    '**关键：**速度方向在变、大小不变，所以月亮既不会掉下来，也不会飞走。',
    '</math>',
    '',
    '<graph>',
    '\`\`\`mermaid',
    'graph TD',
    '  A[地球引力 F=GMm/r²] --> B[提供向心力]',
    '  C[月球切向速度] --> D[沿轨道运动]',
    '  B --> D',
    '  D --> E[月亮不会掉下来]',
    '\`\`\`',
    '</graph>',
    '',
    '<viz>',
    '\`\`\`html',
    viz,
    '\`\`\`',
    '</viz>',
    '',
    '<extend>',
    '## 苏格拉底追问',
    '',
    'Q1. 如果月球突然停止绕行，它会怎样运动？请先用你的直觉回答，再对比自由落体。',
    'Q2. "失重"等于"没有引力"吗？空间站里的宇航员为什么飘着？',
    '',
    '## 进阶学习方向',
    '',
    '1. 用能量观点分析：月球机械能 <formula>E=-\\frac{GMm}{2r}</formula> 与轨道半径的关系。',
    '2. 如果月球速度减半，轨道会发生什么变化？',
    '3. 潮汐锁定：为什么我们永远只能看到月球的同一面？',
    '</extend>',
  ].join('\n');
}

function _buildDemoMessages() {
  const now = Date.now();
  return [
    { role: 'user', content: '为什么月亮不会掉下来？', timestamp: now - 60000, aborted: false },
    { role: 'assistant', content: _buildDemoAnswer(), timestamp: now - 50000, duration: 15000, aborted: false },
  ];
}

function _buildDemoKnowledge(sessionId) {
  const base = { sessionId: sessionId, createdAt: Date.now() };
  return {
    k_demo_gravity: { id: 'k_demo_gravity', title: '万有引力定律', summary: '任何两个物体之间都存在引力：大小与质量乘积成正比，与距离平方成反比。', formulas: ['F=\\frac{GMm}{r^2}'], ...base },
    k_demo_centripetal: { id: 'k_demo_centripetal', title: '向心力', summary: '物体做圆周运动时指向圆心的合力，由其他力（如引力）提供。', formulas: ['F=\\frac{mv^2}{r}'], ...base },
    k_demo_circular: { id: 'k_demo_circular', title: '圆周运动', summary: '物体沿圆形轨道运动，速度方向时刻改变、大小可以不变。', formulas: ['v=\\frac{2\\pi r}{T}'], ...base },
    k_demo_moon: { id: 'k_demo_moon', title: '月球公转', summary: '月球绕地球做近似圆周运动，地球引力提供向心力，所以它不会掉下来。', formulas: [], ...base },
  };
}

function _buildDemoFormulas(sessionId) {
  const now = Date.now();
  return {
    f_demo_gravity: { id: 'f_demo_gravity', latex: 'F=\\frac{GMm}{r^2}', meaning: '万有引力定律：两物体间的引力与质量乘积成正比、与距离平方成反比。', concept: '万有引力', meaningSource: 'local', sessionId: sessionId, createdAt: now },
    f_demo_orbit: { id: 'f_demo_orbit', latex: 'v=\\sqrt{\\frac{GM}{r}}', meaning: '环绕速度：由引力提供向心力推导出的轨道速度公式。', concept: '环绕速度', meaningSource: 'local', sessionId: sessionId, createdAt: now },
    f_demo_centripetal: { id: 'f_demo_centripetal', latex: 'a=\\frac{v^2}{r}', meaning: '向心加速度：描述圆周运动中速度方向变化的快慢。', concept: '向心加速度', meaningSource: 'local', sessionId: sessionId, createdAt: now },
  };
}

// 画布就绪后自动整理布局（避免示例会话节点堆叠）并适配视口
async function _settleDemoCanvas() {
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 100)));
  if (typeof autoArrangeGraph === 'function') {
    try { autoArrangeGraph(); } catch (e) {}
  }
  if (typeof fitGraph === 'function') {
    try { fitGraph(); } catch (e) {}
  }
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 80)));
}

// 引导/演示入口：当前画布为空时准备演示会话（已存在则直接切换）
async function ensureDemoSession() {
  const currentId = typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '';
  const currentMsgs = typeof window.getSessionMessages === 'function' ? window.getSessionMessages(currentId) : [];
  if (Array.isArray(currentMsgs) && currentMsgs.length) return false;

  const existing = typeof window.getSessionById === 'function' ? window.getSessionById(DEMO_SESSION_ID) : null;
  if (existing) {
    if (typeof window.switchToSession === 'function') await window.switchToSession(DEMO_SESSION_ID);
    await _settleDemoCanvas();
    return true;
  }

  if (typeof window.createSessionWithMessages !== 'function') return false;
  const sid = await window.createSessionWithMessages(
    { title: DEMO_SESSION_TITLE, icon: 'gravity', isDemo: true },
    _buildDemoMessages(),
    DEMO_SESSION_ID
  );
  const session = typeof window.getSessionById === 'function' ? window.getSessionById(sid) : null;
  const sessionId = session ? session.sessionId : '';
  if (sessionId) {
    try {
      if (typeof saveKnowledgeItems === 'function') await saveKnowledgeItems(_buildDemoKnowledge(sessionId));
      if (typeof setFormulaCache === 'function') setFormulaCache(_buildDemoFormulas(sessionId));
      await fetch('/api/formulas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.values(_buildDemoFormulas(sessionId))),
      });
    } catch (e) {
      console.warn('[Demo] seed knowledge/formulas failed:', e);
    }
    if (typeof window.invalidateKnowledgeCache === 'function') window.invalidateKnowledgeCache();
  }
  if (typeof window.renderSessionList === 'function') window.renderSessionList();
  await _settleDemoCanvas();
  return true;
}
