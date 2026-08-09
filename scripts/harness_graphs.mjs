// 图语料库：harness 测试用的多张知识网络图。
// 每张图提供 nodes/edges，以及 label->ids 语义索引（支持同名节点）。
// G1 与旧 makeSnapshot 完全一致（id A/B/C/D），保证存量场景零改动。

function idx(nodes) {
  const m = {};
  for (const n of nodes) {
    const label = String(n.label || '').trim();
    if (!label) continue;
    (m[label] = m[label] || []).push(n.id);
  }
  return m;
}

const G1 = {
  id: 'G1',
  label: '微积分基础（4 节点）',
  nodes: [
    { id: 'A', kind: 'knowledge', label: '导数', content: '导数就是函数在某一点的瞬时变化率，表示切线的斜率。', formula: "f'(x)=\\lim_{\\Delta x\\to 0}\\frac{\\Delta y}{\\Delta x}" },
    { id: 'B', kind: 'knowledge', label: '极限', content: '当自变量趋近某个值时函数值趋近的值。', formula: '' },
    { id: 'C', kind: 'module', module_key: 'physics', label: '物理视角', content: '速度是位移对时间的导数。', formula: '' },
    { id: 'D', kind: 'human_note', label: '我的理解', content: '导数就是斜率，变化越快导数越大。', formula: '' },
  ],
  edges: [
    { key: 'B:out-0->A:in-0', from: 'B', to: 'A', relation: '依赖', label: '需要先掌握' },
    { key: 'A:out-0->C:in-0', from: 'A', to: 'C', relation: '物理意义', label: '从物理直觉理解导数' },
    { key: 'A:out-0->D:in-0', from: 'A', to: 'D', relation: '补充视角', label: '用户理解' },
  ],
};

const G2 = {
  id: 'G2',
  label: '电磁学（9 节点，跨领域）',
  nodes: [
    { id: 'E1', kind: 'knowledge', label: '电场', content: '电荷周围存在的场，用电场强度描述。', formula: "\\vec{E}=\\frac{\\vec{F}}{q}" },
    { id: 'E2', kind: 'knowledge', label: '电势', content: '单位正电荷在电场中某点的电势能。', formula: "\\varphi=\\frac{W}{q}" },
    { id: 'E3', kind: 'knowledge', label: '高斯定理', content: '穿过闭合曲面的电通量等于面内电荷除以真空介电常数。', formula: "\\oint \\vec{E}\\cdot d\\vec{S}=\\frac{Q_{\\text{in}}}{\\varepsilon_0}" },
    { id: 'E4', kind: 'knowledge', label: '环路定理', content: '静电场中电场强度沿闭合路径的线积分为零。', formula: "\\oint \\vec{E}\\cdot d\\vec{l}=0" },
    { id: 'E5', kind: 'module', module_key: 'physics', label: '物理视角', content: '电场线密度代表场强大小。', formula: '' },
    { id: 'E6', kind: 'module', module_key: 'math', label: '数学视角', content: '通量与环量是两类积分。', formula: '' },
    { id: 'E7', kind: 'human_note', label: '我的理解', content: '高斯定理就是电场线的数量守恒。', formula: '' },
    { id: 'E8', kind: 'answer', label: 'AI 回答', content: '高斯定理与环路定理共同刻画静电场。', formula: '' },
    { id: 'E9', kind: 'knowledge', label: '电场强度', content: '单位正电荷所受的电场力。', formula: "E=\\frac{F}{q}" },
  ],
  edges: [
    { key: 'E1:out-0->E9:in-0', from: 'E1', to: 'E9', relation: '导出', label: '定义' },
    { key: 'E1:out-0->E2:in-0', from: 'E1', to: 'E2', relation: '关联' },
    { key: 'E1:out-0->E3:in-0', from: 'E1', to: 'E3', relation: '应用' },
    { key: 'E1:out-0->E4:in-0', from: 'E1', to: 'E4', relation: '应用' },
    { key: 'E1:out-0->E5:in-0', from: 'E1', to: 'E5', relation: '物理意义' },
    { key: 'E1:out-0->E6:in-0', from: 'E1', to: 'E6', relation: '数学意义' },
    { key: 'E1:out-0->E7:in-0', from: 'E1', to: 'E7', relation: '补充视角' },
    { key: 'E7:out-0->E8:in-0', from: 'E7', to: 'E8', relation: '回答' },
  ],
};

const G3 = {
  id: 'G3',
  label: '线性代数（8 节点，数学向）',
  nodes: [
    { id: 'L1', kind: 'knowledge', label: '向量', content: '既有大小又有方向的量。', formula: "\\vec{a}=(a_1,a_2,\\dots,a_n)" },
    { id: 'L2', kind: 'knowledge', label: '矩阵', content: '按矩形排列的数表。', formula: "A=(a_{ij})_{m\\times n}" },
    { id: 'L3', kind: 'knowledge', label: '行列式', content: '方阵的一个标量值。', formula: "\\det A" },
    { id: 'L4', kind: 'knowledge', label: '特征值', content: '满足 Ax=lambda x 的标量。', formula: "A\\vec{x}=\\lambda\\vec{x}" },
    { id: 'L5', kind: 'knowledge', label: '线性变换', content: '保持加法和数乘的映射。', formula: "T(\\vec{u}+\\vec{v})=T\\vec{u}+T\\vec{v}" },
    { id: 'L6', kind: 'module', module_key: 'math', label: '数学视角', content: '矩阵是线性变换的坐标表示。', formula: '' },
    { id: 'L7', kind: 'module', module_key: 'physics', label: '物理视角', content: '特征值对应振动模式频率。', formula: '' },
    { id: 'L8', kind: 'human_note', label: '我的理解', content: '行列式就是体积的缩放倍数。', formula: '' },
  ],
  edges: [
    { key: 'L1:out-0->L2:in-0', from: 'L1', to: 'L2', relation: '前置' },
    { key: 'L2:out-0->L3:in-0', from: 'L2', to: 'L3', relation: '导出' },
    { key: 'L2:out-0->L4:in-0', from: 'L2', to: 'L4', relation: '导出' },
    { key: 'L5:out-0->L2:in-0', from: 'L5', to: 'L2', relation: '表示' },
    { key: 'L2:out-0->L6:in-0', from: 'L2', to: 'L6', relation: '数学意义' },
    { key: 'L2:out-0->L7:in-0', from: 'L2', to: 'L7', relation: '物理意义' },
    { key: 'L2:out-0->L8:in-0', from: 'L2', to: 'L8', relation: '补充视角' },
  ],
};

const G4 = {
  id: 'G4',
  label: '真实应用拓扑（问题→回答簇→模块→分支）',
  nodes: [
    { id: 'q-1786114829873', kind: 'user', label: '什么是简谐运动？', content: '什么是简谐运动？', formula: '', read_only: true },
    { id: 'a-1786114980545', kind: 'answer', label: 'AI 回答', content: '简谐运动是回复力与位移成正比的振动。', formula: '' },
    { id: 'm-1786114980545-physics', kind: 'module', module_key: 'physics', label: '物理视角', content: '弹簧振子与单摆。', formula: '' },
    { id: 'm-1786114980545-math', kind: 'module', module_key: 'math', label: '数学视角', content: 'x=Acos(wt+phi)。', formula: 'x(t)=A\\cos(\\omega t+\\varphi)' },
    { id: 'm-1786114980545-graph', kind: 'module', module_key: 'graph', label: '知识图谱', content: '概念关系。', formula: '' },
    { id: 'm-1786114980545-viz', kind: 'module', module_key: 'viz', label: '交互可视化', content: 'HTML 演示。', formula: '' },
    { id: 'm-1786114980545-socratic', kind: 'module', module_key: 'socratic', label: '苏格拉底追问', content: '为什么回复力与位移成正比？', formula: '' },
    { id: 'm-1786114980545-learn', kind: 'module', module_key: 'learn', label: '进阶学习', content: '阻尼振动与受迫振动。', formula: '' },
    { id: 'human_note-custom-1', kind: 'human_note', label: '我的理解', content: '简谐运动就是来回摆动。', formula: '' },
    { id: 'f-1', kind: 'user', label: '追问：能量如何转化？', content: '追问：能量如何转化？', formula: '' },
    { id: 'f-1-answer', kind: 'answer', label: 'AI 回答（追问）', content: '动能与势能相互转化。', formula: '' },
    { id: 's-1', kind: 'answer', label: '苏格拉底回答', content: '若回复力与位移不成正比呢？', formula: '' },
    { id: 'l-1', kind: 'answer', label: '进阶学习回答', content: '从简谐到阻尼振动。', formula: '' },
  ],
  edges: [
    { key: 'q:out->a:in', from: 'q-1786114829873', to: 'a-1786114980545', relation: '回答', custom: false },
    { key: 'a:out->physics:in', from: 'a-1786114980545', to: 'm-1786114980545-physics', relation: '模块', custom: false },
    { key: 'a:out->math:in', from: 'a-1786114980545', to: 'm-1786114980545-math', relation: '模块', custom: false },
    { key: 'a:out->graph:in', from: 'a-1786114980545', to: 'm-1786114980545-graph', relation: '模块', custom: false },
    { key: 'a:out->viz:in', from: 'a-1786114980545', to: 'm-1786114980545-viz', relation: '模块', custom: false },
    { key: 'a:out->socratic:in', from: 'a-1786114980545', to: 'm-1786114980545-socratic', relation: '模块', custom: false },
    { key: 'a:out->learn:in', from: 'a-1786114980545', to: 'm-1786114980545-learn', relation: '模块', custom: false },
    { key: 'a:out->note:in', from: 'a-1786114980545', to: 'human_note-custom-1', relation: '补充视角', custom: false },
    { key: 'physics:out->f:in', from: 'm-1786114980545-physics', to: 'f-1', relation: '追问', custom: false },
    { key: 'f:out->fans:in', from: 'f-1', to: 'f-1-answer', relation: '回答', custom: false },
    { key: 'socratic:out->s:in', from: 'm-1786114980545-socratic', to: 's-1', relation: '回答', custom: false },
    { key: 'learn:out->l:in', from: 'm-1786114980545-learn', to: 'l-1', relation: '回答', custom: false },
  ],
};

const G5 = {
  id: 'G5',
  label: '大图（32 节点：多分支 + 孤立组件 + 重复标题）',
  nodes: [
    { id: 'D1', kind: 'knowledge', label: '导数', content: '导数定义（分支一）。' },
    { id: 'D2', kind: 'knowledge', label: '导数', content: '导数在物理学中的另一种表述（分支二，同名）。' },
    { id: 'D3', kind: 'knowledge', label: '极限', content: '极限定义。' },
    { id: 'D4', kind: 'knowledge', label: '连续', content: '连续定义。' },
    { id: 'D5', kind: 'knowledge', label: '微分', content: '微分定义。' },
    { id: 'D6', kind: 'knowledge', label: '积分', content: '不定积分。' },
    { id: 'D7', kind: 'knowledge', label: '定积分', content: '定积分定义。' },
    { id: 'D8', kind: 'knowledge', label: '微积分基本定理', content: '联系微分与积分。' },
    { id: 'D9', kind: 'knowledge', label: '泰勒公式', content: '多项式逼近。' },
    { id: 'D10', kind: 'knowledge', label: '傅里叶级数', content: '周期函数展开。' },
    { id: 'D11', kind: 'knowledge', label: '向量微积分', content: '梯度散度旋度。' },
    { id: 'D12', kind: 'knowledge', label: '常微分方程', content: 'ODE 基本概念。' },
    { id: 'D13', kind: 'module', module_key: 'physics', label: '物理视角', content: '物理应用。' },
    { id: 'D14', kind: 'module', module_key: 'math', label: '数学视角', content: '数学结构。' },
    { id: 'D15', kind: 'module', module_key: 'socratic', label: '苏格拉底追问', content: '追问。' },
    { id: 'D16', kind: 'module', module_key: 'learn', label: '进阶学习', content: '进阶。' },
    { id: 'D17', kind: 'human_note', label: '我的理解', content: '分支一的理解。' },
    { id: 'D18', kind: 'human_note', label: '我的理解', content: '分支二的理解（同名）。' },
    { id: 'D19', kind: 'answer', label: 'AI 回答', content: '回答一。' },
    { id: 'D20', kind: 'answer', label: 'AI 回答', content: '回答二。' },
    { id: 'D21', kind: 'user', label: '什么是导数？', content: '什么是导数？' },
    { id: 'D22', kind: 'user', label: '为什么要有极限？', content: '为什么要有极限？' },
    { id: 'D23', kind: 'knowledge', label: '概率', content: '概率定义（孤立组件）。' },
    { id: 'D24', kind: 'knowledge', label: '期望', content: '期望定义（孤立组件）。' },
    { id: 'D25', kind: 'knowledge', label: '方差', content: '方差定义（孤立组件）。' },
    { id: 'D26', kind: 'knowledge', label: '电场', content: '电场（孤立组件）。' },
    { id: 'D27', kind: 'knowledge', label: '电势', content: '电势（孤立组件）。' },
    { id: 'D28', kind: 'relation', label: '导数与连续', content: '可导必连续。' },
    { id: 'D29', kind: 'relation', label: '积分与微分', content: '互逆。' },
    { id: 'D30', kind: 'summary', label: 'AI 总结', content: '总结一。' },
    { id: 'D31', kind: 'source', label: '教材输入', content: '教材片段。' },
    { id: 'D32', kind: 'hub', label: '汇聚', content: '多路汇聚。' },
  ],
  edges: [
    { key: 'D21:out->D19:in', from: 'D21', to: 'D19', relation: '回答' },
    { key: 'D19:out->D1:in', from: 'D19', to: 'D1', relation: '导出' },
    { key: 'D19:out->D13:in', from: 'D19', to: 'D13', relation: '模块' },
    { key: 'D1:out->D17:in', from: 'D1', to: 'D17', relation: '补充视角' },
    { key: 'D22:out->D20:in', from: 'D22', to: 'D20', relation: '回答' },
    { key: 'D20:out->D2:in', from: 'D20', to: 'D2', relation: '导出' },
    { key: 'D2:out->D18:in', from: 'D2', to: 'D18', relation: '补充视角' },
    { key: 'D3:out->D1:in', from: 'D3', to: 'D1', relation: '依赖' },
    { key: 'D1:out->D4:in', from: 'D1', to: 'D4', relation: '前置' },
    { key: 'D1:out->D5:in', from: 'D1', to: 'D5', relation: '导出' },
    { key: 'D5:out->D6:in', from: 'D5', to: 'D6', relation: '逆运算' },
    { key: 'D6:out->D7:in', from: 'D6', to: 'D7', relation: '导出' },
    { key: 'D7:out->D8:in', from: 'D7', to: 'D8', relation: '应用' },
    { key: 'D1:out->D9:in', from: 'D1', to: 'D9', relation: '应用' },
    { key: 'D9:out->D10:in', from: 'D9', to: 'D10', relation: '拓展' },
    { key: 'D11:out->D12:in', from: 'D11', to: 'D12', relation: '关联' },
    { key: 'D1:out->D14:in', from: 'D1', to: 'D14', relation: '数学意义' },
    { key: 'D1:out->D15:in', from: 'D1', to: 'D15', relation: '追问' },
    { key: 'D1:out->D16:in', from: 'D1', to: 'D16', relation: '进阶' },
    { key: 'D1:out->D28:in', from: 'D1', to: 'D28', relation: '联系' },
    { key: 'D6:out->D29:in', from: 'D6', to: 'D29', relation: '联系' },
    { key: 'D1:out->D30:in', from: 'D1', to: 'D30', relation: '总结' },
    { key: 'D31:out->D1:in', from: 'D31', to: 'D1', relation: '来源' },
    { key: 'D1:out->D32:in', from: 'D1', to: 'D32', relation: '汇聚' },
    { key: 'D23:out->D24:in', from: 'D23', to: 'D24', relation: '导出' },
    { key: 'D24:out->D25:in', from: 'D24', to: 'D25', relation: '导出' },
    { key: 'D26:out->D27:in', from: 'D26', to: 'D27', relation: '关联' },
    { key: 'D11:out->D12:in', from: 'D11', to: 'D12', relation: '应用' },
  ],
};

const G6 = {
  id: 'G6',
  label: '特殊图（只读根节点 + 同名节点 + 孤立）',
  nodes: [
    { id: 'R', kind: 'user', label: '根问题', content: '根问题', read_only: true },
    { id: 'N1', kind: 'knowledge', label: '导数', content: '同名节点一。' },
    { id: 'N2', kind: 'knowledge', label: '导数', content: '同名节点二。' },
    { id: 'N3', kind: 'human_note', label: '我的理解', content: '理解。' },
    { id: 'N4', kind: 'knowledge', label: '孤立节点', content: '没有任何连线。' },
    { id: 'N5', kind: 'module', module_key: 'physics', label: '物理视角', content: '物理。' },
  ],
  edges: [
    { key: 'R:out->N1:in', from: 'R', to: 'N1', relation: '回答', custom: false },
    { key: 'R:out->N2:in', from: 'R', to: 'N2', relation: '回答', custom: false },
    { key: 'N1:out->N3:in', from: 'N1', to: 'N3', relation: '补充视角' },
    { key: 'N1:out->N5:in', from: 'N1', to: 'N5', relation: '物理意义' },
  ],
};

const G7 = {
  id: 'G7',
  label: '空图',
  nodes: [],
  edges: [],
};

const G8 = {
  id: 'G8',
  label: '单只读根节点',
  nodes: [{ id: 'ROOT', kind: 'user', label: '根问题', content: '根问题', read_only: true }],
  edges: [],
};

export const GRAPHS = [G1, G2, G3, G4, G5, G6, G7, G8].map(g => ({ ...g, index: idx(g.nodes) }));

export function graphById(id) {
  return GRAPHS.find(g => g.id === id) || GRAPHS[0];
}

export function resolveLabels(graph, labels) {
  const out = [];
  for (const label of labels || []) {
    const ids = (graph.index || {})[String(label).trim()] || [];
    for (const id of ids) if (!out.includes(id)) out.push(id);
  }
  return out;
}
