// 节点全屏划词快捷工具（node-fs-toolbar.js，2026-10-25）静态/沙箱契约。
// 范围：本页全屏阅读层浮条 ＋ 新窗口预览页内嵌浮条 ＋ 预览壳转发桥。
// 只写同步用例——共享沙箱教训：异步用例不能和重置沙箱的同步用例同文件（AGENTS.md）；
// 行为验证靠浏览器真机档（当日日志有验收清单），这里守住「符号在、接线对、坏拼接当场炸」。
import { check, code, sandbox, fs } from './_runner.mjs';

const readSrc = (p) => fs.readFileSync(p, 'utf8');

export function run() {
  check('node-fs-toolbar: 动作层符号挂上全局（选区提取/浮条/输入行/桥接收端/预览脚本生成器）', () => {
    for (const fn of ['_nodeFsPickSelection', '_nodeFsHideBar', '_nodeFsExpandInput', '_nodeFsRunAction', '_buildNodeFsPreviewScript', '_setNodeFsPreviewCtx', '_nodeFsComposeFollowup']) {
      if (typeof sandbox[fn] !== 'function') throw new Error(fn + ' 未暴露');
    }
    return true;
  });

  check('node-fs-toolbar: 桥上白名单＝追问/收藏公式/查找，已删的 explain/excerpt 不许回潮', () => {
    const src = readSrc('src/static/js/node-fs-toolbar.js');
    if (!/NODE_FS_BRIDGE_ACTIONS\s*=\s*\['followup',\s*'collectFormula',\s*'search'\]/.test(src)) return false;
    // 只拦动作字符串字面量（属性名 .excerpt 之类的普通命名不算回潮）
    if (/'(explain|excerpt)'/.test(src)) return false;
    return true;
  });

  check('node-fs-toolbar: 预览脚本生成器两模式产物都能编译、标题带 </script> 被转义', () => {
    const bridge = sandbox._buildNodeFsPreviewScript({ bridge: true, token: 'tok_smoke', nodeId: 'n1', title: '含 </script> 的标题' });
    new Function(bridge); // 只编译不执行——字符串拼接坏了这里当场炸
    const plain = sandbox._buildNodeFsPreviewScript({ bridge: false, nodeId: 'n1', title: 'T' });
    new Function(plain);
    if (bridge.indexOf('</script') !== -1) return false;
    return true;
  });

  check('node-fs-toolbar: _buildContentPreviewPage 传 ctx 含 token/脚本/data-node-id，不传不含（viewer 老调用零变化）', () => {
    const realEsc = sandbox.escapeHtml;
    // 沙箱裸 escapeHtml 解析到 loose 代理（恒返回 0）——recipes 全屏用例同款先桩掉
    sandbox.escapeHtml = t => (t == null ? '' : String(t));
    try {
      const plain = sandbox._buildContentPreviewPage('标题', '<p>正文</p>');
      if (plain.includes('node-fs-action') || plain.includes('data-node-id')) return false;
      const ctxd = sandbox._buildContentPreviewPage('标题', '<p>正文</p>', { nodeId: 'n1', token: 'tok_smoke', title: '标题', bridge: true });
      if (!ctxd.includes('data-node-id="n1"') || !ctxd.includes('tok_smoke') || !ctxd.includes('node-fs-action')) return false;
      return true;
    } finally {
      sandbox.escapeHtml = realEsc;
    }
  });

  check('node-fs-toolbar: 桥四道校验都在场（壳认 source、主应用认 source+token+白名单、800ms 兜底）', () => {
    const shell = readSrc('src/static/content-preview.html');
    if (!shell.includes('ev.source !== frame.contentWindow')) return false;
    if (!shell.includes("'node-fs-action'") || !shell.includes("'node-fs-ack'")) return false;
    if (!shell.includes('800')) return false;
    const bar = readSrc('src/static/js/node-fs-toolbar.js');
    if (!bar.includes('ev.source !== ctx.win')) return false;
    if (!bar.includes('d.token !== ctx.token')) return false;
    if (!bar.includes("NODE_FS_BRIDGE_ACTIONS.indexOf(d.action) < 0")) return false;
    return true;
  });

  check('node-fs-toolbar: Esc capture 先收浮条并 stopPropagation（ui.js 关全屏这轮不触发）', () => {
    const bar = readSrc('src/static/js/node-fs-toolbar.js');
    const idx = bar.indexOf("'Escape'");
    if (idx < 0) return false;
    const seg = bar.slice(idx, idx + 400);
    const stopAt = seg.indexOf('stopPropagation');
    const hideAt = seg.indexOf('_nodeFsHideBar');
    if (stopAt < 0 || hideAt < 0) return false;
    if (bar.slice(idx, idx + 900).indexOf('}, true);') < 0) return false; // capture 注册
    return true;
  });

  check('node-fs-toolbar: 构建顺序在 graph-custom 之后、app.js 产物已含本模块', () => {
    const bf = readSrc('scripts/build_frontend.mjs');
    const a = bf.indexOf("'graph-custom.js'");
    const b = bf.indexOf("'node-fs-toolbar.js'");
    if (a < 0 || b < 0 || b < a) return false;
    if (!code.includes('NODE_FS_BRIDGE_ACTIONS')) return false;
    return true;
  });

  check('node-fs-toolbar: graph-custom 集成点（overlay 带节点上下文/新窗口造 token/file:// 关桥/浮条随层收）', () => {
    const src = readSrc('src/static/js/graph-custom.js');
    if (!src.includes('overlay.dataset.nodeFsId') || !src.includes('attachNodeFsSelectionBar(overlay)')) return false;
    if (!src.includes('bridge: true') || !src.includes('bridge: false')) return false;
    if (!src.includes('_buildContentPreviewPage(title, contentHtml, ctx)')) return false;
    if (!src.includes('_nodeFsMintPreviewToken()')) return false;
    if (!src.includes('typeof _nodeFsHideBar === \'function\'')) return false;
    return true;
  });

  check('node-fs-toolbar: 浮条样式进 graph-override.css（胶囊＋引文输入行＋窄屏图标化）', () => {
    const css = readSrc('src/static/css/graph-override.css');
    return css.includes('.node-fs-bar')
      && css.includes('.node-fs-input')
      && css.includes('.node-fs-quote-chip')
      && css.includes('@media (max-width: 520px)');
  });
}
