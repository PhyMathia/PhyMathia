// 快捷键注册表（hotkeys.js，2026-11-15，backlog #468/#469 及第二步扩充）契约与行为。
// 范围：唯一事实源、只列真实支持且能执行的键、平台符号、纯按键映射、输入框让行、
// 不抢浏览器保留键、命令面板、Space 平移接入、查看页让行、Esc 一次只关一层。
// 全部同步用例，不写共享 localStorage 键、不 await。
import { check, sandbox, fs } from './_runner.mjs';

const readSrc = (p) => fs.readFileSync(p, 'utf8');

function registryBlock() {
  const src = readSrc('src/static/js/hotkeys.js');
  const start = src.indexOf('const PHY_HOTKEYS = [');
  const end = src.indexOf('\n];', start);
  if (start < 0 || end < 0) throw new Error('hotkeys.js 找不到 PHY_HOTKEYS 注册表块');
  return src.slice(start, end);
}

const ev = (key, opts) => Object.assign({
  key: key, target: null, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
  preventDefault: function () {}, stopPropagation: function () {},
}, opts || {});

export function run() {
  check('hotkey-registry: 新源文件已登记进 app.js 包，注册表覆盖 24 条真实存在的键', () => {
    const build = readSrc('scripts/build_frontend.mjs');
    if (!/'\s*hotkeys\.js\s*'/.test(build)) throw new Error('build_frontend.mjs 的 entries 漏登记 hotkeys.js');
    const block = registryBlock();
    for (const id of ['undo', 'redo', 'copy', 'paste', 'delete', 'escape', 'fullscreen', 'send',
      'selectAll', 'duplicate', 'group', 'ungroup', 'fit', 'zoomReset', 'search', 'export', 'pan',
      'search_viewer', 'undo_continent', 'viewCanvas', 'viewContinent', 'viewKnowledge', 'help', 'palette']) {
      if (!new RegExp("id: '" + id + "'").test(block)) throw new Error('注册表缺真实按键：' + id);
    }
    const count = (block.match(/\{ id: '/g) || []).length;
    if (count !== 24) throw new Error('注册表条数与事实源不一致：' + count + '（新增键必须同步改本断言）');
    return true;
  });

  check('hotkey-registry: 提示不说谎——不列浏览器保留键，每条可执行动作都有实现', () => {
    const block = registryBlock();
    for (const banned of ['Mod+N', 'Mod+T', 'Mod+W', 'Mod+L', 'Mod+R', 'Mod+P', 'Mod+Shift+I']) {
      if (block.includes(banned)) throw new Error('注册表占了浏览器保留键：' + banned);
    }
    const src = readSrc('src/static/js/hotkeys.js');
    // 动作表是顶层 const（不挂沙箱全局），走静态源码断言；运行期另有 selfCheck 兜底。
    const actStart = src.indexOf('const PHY_HOTKEY_ACTIONS = {');
    const actEnd = src.indexOf('\n};', actStart);
    if (actStart < 0 || actEnd < 0) throw new Error('找不到动作表');
    const actBlock = src.slice(actStart, actEnd);
    const rows = sandbox.phyHotkeyList();
    for (const row of rows) {
      if (!row.action) continue;
      if (!new RegExp('\\b' + row.action + ': function').test(actBlock)) {
        throw new Error(row.id + ' 的动作未实现：' + row.action);
      }
    }
    const problems = sandbox.phyHotkeySelfCheck();
    if (!Array.isArray(problems) || problems.length) throw new Error('启动自检未通过：' + JSON.stringify(problems));
    if (!src.includes('只列程序里真实')) throw new Error('速查/命令面板缺「只列真实键」声明');
    return true;
  });

  check('hotkey-registry: Enter 与 Ctrl+Enter 合并成一条，知识大陆 Ctrl+Z 独立如实登记', () => {
    const block = registryBlock();
    if (!/id: 'send'[\s\S]{0,160}Enter \/ Mod\+Enter/.test(block)) throw new Error('发送键没合并成一条');
    if (/id: 'submit'/.test(block)) throw new Error('不该再单列 Ctrl+Enter 一条');
    if (!/id: 'undo_continent'[\s\S]{0,160}大陆自有撤销栈/.test(block)) throw new Error('大陆独立撤销栈没如实登记');
    return true;
  });

  check('hotkey-registry: Mod 按平台渲染、brief 给窄容器用、输入框与 Esc 判定正确', () => {
    const undo = String(sandbox.phyHotkeyKey('undo'));
    if (undo !== 'Ctrl+Z' && undo !== '⌘Z') throw new Error('撤销键的平台符号不对：' + undo);
    const redoFull = String(sandbox.phyHotkeyKey('redo'));
    const redoBrief = String(sandbox.phyHotkeyKey('redo', true));
    if (redoFull === redoBrief) throw new Error('重做的完整写法与菜单缩写应不同');
    if (!/Shift|⇧/.test(redoFull)) throw new Error('重做完整写法缺第二种组合');
    const list = sandbox.phyHotkeyList();
    if (!Array.isArray(list) || list.length !== 24) throw new Error('速查列表条数不对');
    for (const row of list) {
      if (!row.combo || !row.label || !row.scope || !row.source) throw new Error('速查行缺字段：' + JSON.stringify(row));
    }
    if (!sandbox.phyIsTypingTarget({ target: { closest: () => true } })) throw new Error('输入框内应判定为让行');
    if (sandbox.phyIsTypingTarget({ target: null })) throw new Error('无 target 不应判定为输入框');
    const esc = { key: 'Escape' };
    if (!sandbox.phyEscClaim(esc)) throw new Error('同一次 Esc 的首次认领应成功');
    if (sandbox.phyEscClaim(esc)) throw new Error('同一次 Esc 不应被第二个浮层再次认领');
    if (!sandbox.phyEscClaim({ key: 'Escape' })) throw new Error('新一轮 Esc 应可重新认领');
    return true;
  });

  check('hotkey-registry: 纯按键映射覆盖全部新键，输入框内一律让行，不重复接管已有键', () => {
    const R = sandbox.phyHotkeyResolve;
    const cases = [
      ['a', { ctrlKey: true }, 'selectAll'], ['d', { ctrlKey: true }, 'duplicate'],
      ['f', { ctrlKey: true }, 'search'], ['k', { ctrlKey: true }, 'palette'],
      ['s', { ctrlKey: true }, 'export'], ['g', { ctrlKey: true }, 'group'],
      ['G', { ctrlKey: true, shiftKey: true }, 'ungroup'],
      ['1', { ctrlKey: true, shiftKey: true }, 'viewCanvas'],
      ['2', { ctrlKey: true, shiftKey: true }, 'viewContinent'],
      ['3', { ctrlKey: true, shiftKey: true }, 'viewKnowledge'],
      ['?', {}, 'help'], ['f', {}, 'fit'], ['0', {}, 'zoomReset'], [' ', {}, 'pan'],
    ];
    for (const [key, opts, want] of cases) {
      const got = R(ev(key, opts));
      if (got !== want) throw new Error(key + ' + ' + JSON.stringify(opts) + ' 应映射到 ' + want + '，实际 ' + got);
    }
    const typingTarget = { closest: () => true };
    for (const key of ['a', 'd', 'f', 'k', 's', 'g', '?', '0', ' ']) {
      const got = R(ev(key, { ctrlKey: true, target: typingTarget }));
      if (got) throw new Error('输入框内不该抢键：' + key + ' → ' + got);
    }
    for (const keep of ['n', 't', 'w', 'l', 'r', 'p', 'z', 'y', 'c', 'v']) {
      if (R(ev(keep, { ctrlKey: true }))) throw new Error('不该接管浏览器保留键或已有键：Ctrl+' + keep);
    }
    return true;
  });

  check('hotkey-registry: 右键菜单提示改从注册表取，不再硬编码第二份字符串', () => {
    const cm = readSrc('src/static/js/graph-contextmenu.js');
    if (!cm.includes('graphCtxKeyHint(item.key)')) throw new Error('菜单渲染没调注册表取键');
    if (!cm.includes("duplicate: 'copy'")) throw new Error('复制节点没映射到 copy');
    if (!cm.includes("'paste-clip': 'paste'")) throw new Error('粘贴节点没映射到 paste');
    for (const old of ["undo: 'Ctrl+Z'", "redo: 'Ctrl+Y'", "delete: 'Del'"]) {
      if (cm.includes(old)) throw new Error('菜单里仍残留手写按键：' + old);
    }
    return true;
  });

  check('hotkey-registry: 查看页 F// 不抢输入框、⋯ 有速查入口、Esc 一次只关一层', () => {
    const vm = readSrc('src/static/js/viewer-main.js');
    const guardAt = vm.indexOf("closest('input, textarea, select, [contenteditable], iframe')");
    const fAt = vm.indexOf("e.key === 'f'");
    if (guardAt < 0 || fAt < 0 || guardAt > fAt) throw new Error('查看页 F// 之前缺少输入框让行');
    if (vm.indexOf('if (e.ctrlKey || e.metaKey || e.altKey) return;') < 0) {
      throw new Error('查看页没把带修饰键的组合让给浏览器');
    }
    const gi = readSrc('src/static/js/graph-interact.js');
    if (!gi.includes('phyOpenHotkeyHelp();closeGraphToolbarMore()')) throw new Error('⋯ 菜单缺快捷键速查入口');
    const ui = readSrc('src/static/js/ui.js');
    if (!/closeNodeFullscreen\(\);\s*\n\s*return;/.test(ui)) throw new Error('节点全屏层 Esc 后没 return');
    if (!/closeVizFullscreen\(\);\s*\n\s*return;/.test(ui)) throw new Error('viz 全屏 Esc 后没 return');
    return true;
  });

  check('hotkey-registry: Space 平移接入画布指针判定，速查与命令面板共用注册表和主题令牌', () => {
    const ge = readSrc('src/static/js/graph-events.js');
    if (!ge.includes('phyIsSpacePanning()')) throw new Error('画布 pointerdown 没接 Space 平移判定');
    const spaceAt = ge.indexOf('按住 Space 时一律走画布平移');
    const bodyReturn = "if (e.target.closest('.graph-node-full-content, .graph-blank-content, .graph-node-label, .graph-node-sub')) return;";
    const returnAt = ge.indexOf(bodyReturn);
    if (spaceAt < 0 || returnAt < 0 || spaceAt > returnAt) {
      throw new Error('Space 判定必须放在节点正文 return 之前，否则正文上拖不动');
    }
    const hk = readSrc('src/static/js/hotkeys.js');
    if (!hk.includes('const rows = phyHotkeyList();')) throw new Error('速查面板没从注册表取行');
    if (!hk.includes('!!r.action')) throw new Error('命令面板没筛出可执行的动作');
    if (!hk.includes('phyOpenCommandPalette')) throw new Error('缺命令面板入口');
    for (const token of ['var(--bg-panel', 'var(--text-primary', 'var(--border', 'var(--accent']) {
      if (!hk.includes(token)) throw new Error('浮层缺主题令牌：' + token);
    }
    if (!hk.includes('stopPropagation()')) throw new Error('浮层开着时 Esc 没拦下其他浮层');
    if (!hk.includes("window.addEventListener('blur'")) throw new Error('Space 状态没在窗口失焦时清除');
    return true;
  });
}
