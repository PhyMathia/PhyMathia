// ===== 官方配方包（P4 生态，2026-11-01）：官方写好但不常驻的示范配方，勾选添加 =====
// D-R7：配方默认空、绝不预置；配方包以「可一键添加清单」形式（默认全不勾，勾选才添加，
// 对齐模型预设侧「没主动添加的不进列表」哲学）。条目是完整八维度配方数据不是代码（D-R2），
// 添加＝走 graph-recipes.js 的导入核心（importRecipesFromList：id 重生成、同名查重挡），
// 入「我的配方」后就是普通用户配方，可编辑可删除——包本身不是第二个事实源。
// packKey 只用于「已添加」标记（localStorage phymathia_recipe_pack_added），不落配方库
// （normalizeRecipeInput 字段白名单剥除未知字段）。条目必须逐条过 validateRecipe，
// 冒烟 recipes.mjs 有全包校验＋覆盖面断言（至少一条 html_iframe、一条动态出口）。
// 只进主包（build_frontend.mjs），viewer 不加载——只读页没有添加面板与配方库。
// 设计文档：docs/节点配方与创造模式-总体设计-2026-09-29.md 第 6 节 P4。

const OFFICIAL_RECIPE_PACK = [
  {
    packKey: 'official:feynman-restate',
    recipe: {
      name: '费曼复述',
      desc: '用大白话讲明白：本质 / 打比方 / 卡点自查 / 检验',
      base: { kind: 'module' },
      appearance: { palette: 'teal' },
      generate: {
        prompt: '针对上游的问题或知识点做一次费曼式复述，分四段输出：第一段「一句话本质」，用大白话说清它在讲什么，不许用术语；第二段「讲给外行听」，打一个生活里的比方，把关键机制对应到比方里的东西上；第三段「卡点自查」，列出学到这里最容易卡住的两三个概念，各给一句提示；第四段「复述检验」，出 3 个能验证是否真懂的快问快答。',
        strict_output: '只输出四段，每段以「### 」标题开头（### 一句话本质 / ### 讲给外行听 / ### 卡点自查 / ### 复述检验），不要开场白和总结。',
        followup_prompt: '',
        retry_prompt: '',
        context_channel: 'workflow_context',
        model_role: 'agent',
      },
      ports: { static: [{ label: '追问', drag_form: 'draft' }] },
      content_kind: 'markdown',
    },
  },
  {
    packKey: 'official:multi-solution',
    recipe: {
      name: '一题多解',
      desc: '同一道题换 2–4 种方法解，末尾给解法对比表',
      base: { kind: 'module' },
      appearance: { palette: 'blue' },
      generate: {
        prompt: '针对上游给出的题目，给出 2–4 种思路不同的解法，每种单独成段：以「### 解法N·方法名」开头，先用两三句讲清思路，再列关键步骤；全部解法之后用「### 解法对比」收尾，用一张 markdown 表格从「步骤多少 / 易出错点 / 适用场景」三个维度对比各解法。',
        strict_output: '每个解法必须以「### 解法」开头的标题分段；最后一段标题必须是「### 解法对比」；不要重复抄题。',
        followup_prompt: '',
        retry_prompt: '',
        context_channel: 'workflow_context',
        model_role: 'agent',
      },
      ports: { static: [{ label: '追问', drag_form: 'draft' }, { label: '换种解法', drag_form: 'user' }] },
      content_kind: 'markdown',
    },
  },
  {
    packKey: 'official:exam-flashcards',
    recipe: {
      name: '考前速记卡',
      desc: '把上游压成考前 10 分钟能看完的四段速记',
      base: { kind: 'module' },
      appearance: { palette: 'rose' },
      generate: {
        prompt: '把上游内容压缩成考前最后 10 分钟能看完的速记卡，分四段：「### 必背公式」一条一行，用 $...$ 或 $$...$$ 写清，右边附一句每个符号是什么；「### 关键结论」最多 5 条，每条一句话；「### 易忘细节」列单位、正负号、成立条件这类最容易丢分的点；「### 30 秒自测」出 3 个简短问答题，每题后面紧跟一行「答：」。',
        strict_output: '只输出四段，每段以「### 」标题开头；公式一律用 LaTeX（$...$ / $$...$$）书写。',
        followup_prompt: '',
        retry_prompt: '',
        context_channel: 'workflow_context',
        model_role: 'agent',
      },
      ports: { static: [{ label: '追问', drag_form: 'draft' }] },
      content_kind: 'markdown',
    },
  },
  {
    packKey: 'official:concept-compare',
    recipe: {
      name: '概念辨析',
      desc: '两个易混概念一张表分清：区分 / 对比表 / 典型错用',
      base: { kind: 'module' },
      appearance: { palette: 'violet' },
      generate: {
        prompt: '针对上游内容里出现的两个（或多个）易混概念，输出辨析：第一段「### 一句话区分」，用最核心的一条差别把概念分开；第二段「### 对比表」，用 markdown 表格从「定义 / 适用对象 / 常见公式或表达 / 典型反例」四行对比；第三段「### 典型错用」，给一个最常见的混淆例子，指出错在哪、用什么口诀判别。',
        strict_output: '只输出三段，标题依次是「### 一句话区分」「### 对比表」「### 典型错用」；对比表必须是 markdown 表格。',
        followup_prompt: '',
        retry_prompt: '',
        context_channel: 'prompt_inline',
        model_role: 'agent',
      },
      ports: { static: [{ label: '追问', drag_form: 'draft' }] },
      content_kind: 'markdown',
    },
  },
  {
    packKey: 'official:mini-interactive',
    recipe: {
      name: '交互小演示',
      desc: '生成可调参数的单文件网页演示（用 HTML 生成槽）',
      base: { kind: 'module' },
      appearance: { palette: 'amber' },
      generate: {
        prompt: '根据上游内容生成一个单文件交互演示网页，帮助理解其中的核心机制：页面上至少有一个滑块或按钮可以改变参数，画面用 CSS 图形、SVG 或 canvas 绘制，随参数实时变化并显示关键读数；控件与结论都用中文标注；深色背景配高对比文字；不引用任何外部资源。',
        strict_output: '只输出一个完整的 HTML 文档（从 <!DOCTYPE html> 开始到 </html> 结束），不要解释文字。',
        followup_prompt: '',
        retry_prompt: '请务必只输出完整 HTML，不要任何解释。',
        context_channel: 'workflow_context',
        model_role: 'html',
        on_incomplete: { max_retries: 1 },
      },
      ports: { static: [{ label: '追问', drag_form: 'draft' }] },
      content_kind: 'html_iframe',
    },
  },
  {
    packKey: 'official:three-tier-probe',
    recipe: {
      name: '三级追问器',
      desc: '基础 / 进阶 / 拓展三档编号问题，动态出口现场解析',
      base: { kind: 'module' },
      appearance: { palette: 'note' },
      generate: {
        prompt: '针对上游内容向学习者连续追问，帮助自查理解深度：先输出一行标题「### 追问」，然后按顺序输出 3–6 行编号问题——「[基础]」档问概念本身，「[进阶]」档问为什么、问机制，「[拓展]」档问变式、边界或与其它知识的联系。只写问题不写答案；问题要具体到上游内容，不要空泛。',
        strict_output: '编号行格式必须是「1. [基础] 问题文本」：序号＋[基础]/[进阶]/[拓展] 之一＋问题；除标题行与编号行外不要输出别的段落。',
        followup_prompt: '',
        retry_prompt: '',
        context_channel: 'workflow_context',
        model_role: 'agent',
      },
      ports: {
        static: [{ label: '追问', drag_form: 'draft' }],
        dynamic: {
          parser: { pattern: 'numbered_list', level_tags: ['基础', '进阶', '拓展'], max: 12, label_from: 'index_question' },
          fallback: { mode: 'label_questions_from_text', labels: ['问题1', '问题2', '问题3'] },
          each: { type: 'socratic', drag_form: 'draft' },
        },
      },
      content_kind: 'markdown',
    },
  },
];

// ---- 「已添加」标记（localStorage，config.js STORAGE_KEY_RECIPE_PACK_ADDED）----

function _recipePackAddedKey() {
  return typeof STORAGE_KEY_RECIPE_PACK_ADDED !== 'undefined'
    ? STORAGE_KEY_RECIPE_PACK_ADDED : 'phymathia_recipe_pack_added';
}

function getRecipePackAddedKeys() {
  try {
    const raw = localStorage.getItem(_recipePackAddedKey());
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch (e) {
    return new Set();
  }
}

function _markRecipePackAdded(packKey) {
  const keys = getRecipePackAddedKeys();
  keys.add(String(packKey));
  try {
    localStorage.setItem(_recipePackAddedKey(), JSON.stringify([...keys]));
  } catch (e) { /* 标记写失败只影响「已添加」显示，不影响配方本体 */ }
}

// ---- 添加核心：勾选的 packKey → 导入核心 → 落库＋打标记。返回 {added, failed} 供 UI/toast ----

function addOfficialRecipesFromPack(packKeys) {
  const keys = (Array.isArray(packKeys) ? packKeys : []).map(String);
  const items = OFFICIAL_RECIPE_PACK.filter(item => keys.includes(item.packKey));
  if (!items.length) return { added: [], failed: [] };
  const existing = getUserRecipes();
  const result = importRecipesFromList(items.map(item => item.recipe), existing);
  if (result.added.length) {
    setUserRecipes(existing.concat(result.added));
    // 按名字对回 packKey 打标记（导入核心不认识 packKey，配方库里也不存它）
    const addedNames = new Set(result.added.map(item => item.name));
    items.forEach(item => {
      if (addedNames.has(item.recipe.name)) _markRecipePackAdded(item.packKey);
    });
    _recipeRefreshAddPanel();
  }
  return result;
}

// ---- 勾选清单弹窗（默认全不勾；已添加的条目禁勾并标注）----

let recipePackOverlay = null;
let recipePackSelection = {};

function _recipePackMetaLine(recipe) {
  const meta = RECIPE_BASE_META[recipe.base && recipe.base.kind] || {};
  let line = (meta.label || '').split('（')[0];
  if (recipe.content_kind === 'html_iframe') line += ' · 交互网页';
  else if (recipe.content_kind === 'mermaid') line += ' · 知识图谱';
  if (recipe.ports && recipe.ports.dynamic) line += ' · 动态出口';
  const staticCount = (recipe.ports && Array.isArray(recipe.ports.static)) ? recipe.ports.static.length : 0;
  if (staticCount) line += ' · ' + staticCount + ' 个出口';
  return line;
}

function openRecipePackModal() {
  closeRecipePackModal();
  recipePackSelection = {};
  const addedKeys = getRecipePackAddedKeys();
  const rows = OFFICIAL_RECIPE_PACK.map(item => {
    const isAdded = addedKeys.has(item.packKey);
    const disabledAttr = isAdded ? ' disabled' : '';
    const addedTag = isAdded ? '<span class="recipe-pack-added">已添加</span>' : '';
    return '<label class="recipe-pack-row">'
      + '<input type="checkbox"' + disabledAttr + ' onchange="recipePackToggle(\'' + item.packKey + '\', this.checked)">'
      + '<span class="recipe-pack-name">' + escapeHtml(item.recipe.name) + '</span>'
      + '<span class="recipe-pack-meta">' + escapeHtml(_recipePackMetaLine(item.recipe)) + '</span>'
      + addedTag
      + '</label>';
  }).join('');
  const overlay = document.createElement('div');
  overlay.className = 'graph-network-modal-overlay';
  overlay.innerHTML = '<div class="graph-network-modal aurora-glass aurora-glass--dialog">'
    + '<div class="graph-network-modal-head"><span>官方配方包</span><button onclick="closeRecipePackModal()" title="关闭">×</button></div>'
    + '<div class="recipe-pack-hint">官方附赠的示范配方，默认一个都不添加——勾选想要的，点「添加所选」，它们会进「我的配方」，之后随便改随便删。想看官方配方怎么写的，点开就是现成例子。</div>'
    + rows
    + '<div class="graph-network-modal-actions">'
    + '<button class="graph-network-modal-save" id="recipePackAddBtn" onclick="addSelectedRecipePack()">添加所选</button>'
    + '<button onclick="closeRecipePackModal()">关闭</button>'
    + '</div>'
    + '</div>';
  overlay.addEventListener('pointerdown', event => {
    if (event.target === overlay) closeRecipePackModal();
  });
  document.body.appendChild(overlay);
  recipePackOverlay = overlay;
  _recipePackSyncFooter();
}

function closeRecipePackModal() {
  if (recipePackOverlay) {
    recipePackOverlay.remove();
    recipePackOverlay = null;
  }
  recipePackSelection = {};
}

function recipePackToggle(packKey, checked) {
  recipePackSelection[String(packKey)] = !!checked;
  _recipePackSyncFooter();
}

function _recipePackSyncFooter() {
  const btn = document.getElementById('recipePackAddBtn');
  if (!btn) return;
  const count = Object.keys(recipePackSelection).filter(key => recipePackSelection[key]).length;
  btn.textContent = count ? '添加所选（' + count + '）' : '添加所选';
  btn.disabled = !count;
}

function addSelectedRecipePack() {
  const chosen = Object.keys(recipePackSelection).filter(key => recipePackSelection[key]);
  if (!chosen.length) { toastMsg('先勾选要添加的配方'); return; }
  const result = addOfficialRecipesFromPack(chosen);
  const parts = [];
  if (result.added.length) parts.push('已添加 ' + result.added.length + ' 条到「我的配方」');
  result.failed.forEach(f => parts.push('「' + f.name + '」没加成：' + f.reason));
  toastMsg(parts.length ? parts.join('；') : '没有可添加的配方');
  closeRecipePackModal();
}

window.OFFICIAL_RECIPE_PACK = OFFICIAL_RECIPE_PACK;
window.getRecipePackAddedKeys = getRecipePackAddedKeys;
window.addOfficialRecipesFromPack = addOfficialRecipesFromPack;
window.openRecipePackModal = openRecipePackModal;
window.closeRecipePackModal = closeRecipePackModal;
window.recipePackToggle = recipePackToggle;
window.addSelectedRecipePack = addSelectedRecipePack;
