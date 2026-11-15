// 快捷键注册表（hotkeys.js，2026-11-15，backlog #468/#469）契约与行为。
// 范围：唯一事实源、只列真实支持的键、平台符号、菜单提示不再手抄、查看页输入框让行、
// ⋯ 速查入口、Esc 一次只关一层。全部同步用例，不写共享 localStorage 键、不 await。
import { check, sandbox, fs } from './_runner.mjs';

const readSrc = (p) => fs.readFileSync(p, 'utf8');

function registryBlock() {
  const src = readSrc('src/static/js/hotkeys.js');
  const start = src.indexOf('const PHY_HOTKEYS = [');
  const end = src.indexOf('\n];', start);
  if (start < 0 || end < 0) throw new Error('hotkeys.js 找不到 PHY_HOTKEYS 注册表块');
  return src.slice(start, end);
}

export function run() {
  check('hotkey-registry: 新源文件已登记进 app.js 包，注册表覆盖 12 条真实存在的键', () => {
    const build = readSrc('scripts/build_frontend.mjs');
    if (!/'\s*hotkeys\.js\s*'/.test(build)) throw new Error('build_frontend.mjs 的 entries 漏登记 hotkeys.js（漏注册守卫会红）');
    const block = registryBlock();
    for (const id of ['undo', 'redo', 'copy', 'paste', 'delete', 'escape', 'fullscreen',
      'submit', 'send', 'fit', 'search', 'help']) {
      if (!new RegExp("id: '" + id + "'").test(block)) throw new Error('注册表缺真实按键：' + id);
    }
    if ((block.match(/\{ id: '/g) || []).length !== 12) {
      throw new Error('注册表条数与事实源不一致（新增键必须同步改本断言）');
    }
    return true;
  });

  check('hotkey-registry: 速查表不列尚未实现的主流键（Ctrl+A / Ctrl+D / Space / Ctrl+K）', () => {
    // 「提示不说谎」是这套系统能帮用户记忆的前提，本轮明确不新增按键。
    const block = registryBlock();
    for (const banned of ['Mod+A', 'Mod+D', 'Mod+K', 'Ctrl+A', 'Ctrl+D', 'Ctrl+K', 'Space+']) {
      if (block.includes(banned)) throw new Error('注册表列了尚未实现的键：' + banned);
    }
    if (!block.includes("id: 'help'")) throw new Error('缺 ? 速查入口');
    return true;
  });

  check('hotkey-registry: Mod 按平台渲染、brief 给窄容器用、自检无冲突、输入框与 Esc 判定正确', () => {
    const undo = String(sandbox.phyHotkeyKey('undo'));
    if (undo !== 'Ctrl+Z' && undo !== '⌘Z') throw new Error('撤销键的平台符号不对：' + undo);
    const redoFull = String(sandbox.phyHotkeyKey('redo'));
    const redoBrief = String(sandbox.phyHotkeyKey('redo', true));
    if (redoFull === redoBrief) throw new Error('重做的完整写法与菜单缩写应不同（要列出 Ctrl+Shift+Z）');
    if (!/Shift|⇧/.test(redoFull)) throw new Error('重做完整写法缺第二种组合');
    const dup = sandbox.phyHotkeySelfCheck();
    if (!Array.isArray(dup) || dup.length) throw new Error('启动自检报出重复组合键：' + JSON.stringify(dup));
    const list = sandbox.phyHotkeyList();
    if (!Array.isArray(list) || list.length !== 12) throw new Error('速查列表条数不对');
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

  check('hotkey-registry: 右键菜单提示改从注册表取，不再硬编码 Ctrl+Z 等第二份字符串', () => {
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
    if (!/closeNodeFullscreen\(\);\s*\n\s*return;/.test(ui)) throw new Error('节点全屏层 Esc 后没 return，会连关两层');
    if (!/closeVizFullscreen\(\);\s*\n\s*return;/.test(ui)) throw new Error('viz 全屏 Esc 后没 return，会连关两层');
    return true;
  });

  check('hotkey-registry: 速查面板内容来自注册表、跟主题令牌、? 与 Esc 都能关', () => {
    const hk = readSrc('src/static/js/hotkeys.js');
    if (!hk.includes('const rows = phyHotkeyList();')) throw new Error('速查面板没有从注册表取行');
    for (const token of ['var(--bg-panel', 'var(--text-primary', 'var(--border', 'var(--accent']) {
      if (!hk.includes(token)) throw new Error('速查面板缺主题令牌：' + token);
    }
    if (!hk.includes("e.key !== '?'")) throw new Error('缺 ? 打开的按键判定');
    if (!hk.includes('if (phyIsTypingTarget(e)) return;')) throw new Error('? 在输入框内没让行');
    if (!hk.includes('stopPropagation()')) throw new Error('速查面板开着时 Esc 没拦下其他浮层');
    return true;
  });
}
