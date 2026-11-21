// 首屏脚本加载契约（T208）。index.html 的 app.js 原本是全页唯一同步外部脚本，
// 且不处在文件末尾（259 行处、后面还有 560 行标记）——浏览器要先下载并执行完
// 1.2MB 才继续解析后半页，期间不画屏；defer 后改为全 DOM 建完再执行。
// 本域静态断言（读 index.html 原文）守住两个容易手滑回退的点：加载属性被改回
// 同步、填版本号的内联脚本不再等 DOMContentLoaded。真正的执行时序冒烟沙箱
// 覆盖不到（沙箱不读 index.html、不跑浏览器），由 scripts/verify_load_defer.mjs
// 真机验。
// 不碰共享 localStorage 键；纯同步段，注册在薄壳尾部（token-usage 之后）。
import { check, fs, code, bundleMap, sandbox, vm } from './_runner.mjs';
import { decodePosition } from '../decode_client_error.mjs';

const readIndex = () => fs.readFileSync('src/static/index.html', 'utf8');

export function run() {
  check('load-order：app.js 标签带 defer（不得回退同步阻塞）', () => {
    const html = readIndex();
    const m = html.match(/<script[^>]*src="\/dist\/app\.js[^"]*"[^>]*>/);
    if (!m) throw new Error('index.html 里找不到 app.js 的 script 标签');
    if (!/\bdefer\b/.test(m[0])) throw new Error('app.js 缺 defer（同步脚本会阻断后半页解析）：' + m[0]);
    return true;
  });

  check('load-order：appVersion 内联脚本等 DOMContentLoaded 且元素在位', () => {
    const html = readIndex();
    if (!/id="appVersion"/.test(html)) throw new Error('index.html 缺 #appVersion 元素（版本号无处可填）');
    const blocks = html.match(/<script>[\s\S]*?<\/script>/g) || [];
    const block = blocks.find(b => b.includes('appVersion') && b.includes('APP_VERSION'));
    if (!block) throw new Error('找不到填 appVersion 的内联脚本');
    const at = block.search(/addEventListener\(\s*['"]DOMContentLoaded['"]/);
    if (at < 0) {
      throw new Error('内联脚本没等 DOMContentLoaded——它先于 defer 的 app.js 执行，APP_VERSION 尚未定义，版本号留空');
    }
    if (block.indexOf("getElementById('appVersion')") < at) {
      throw new Error('textContent 赋值在 addEventListener 之前——仍是同步执行');
    }
    return true;
  });

  check('load-order：全页外部脚本一律 defer（无第二个同步钉子户）', () => {
    const html = readIndex();
    const tags = html.match(/<script[^>]*src="[^"]*"[^>]*>/g) || [];
    if (tags.length === 0) throw new Error('一个外部 script 标签都没解析到，正则与页面脱节了');
    const sync = tags.filter(t => !/\bdefer\b/.test(t));
    if (sync.length > 0) throw new Error('存在同步外部脚本：' + sync.join(' | '));
    return true;
  });

  check('load-order：app.js 仍带 ?v= 内容哈希（缓存失效机制没被抹掉）', () => {
    const html = readIndex();
    const m = html.match(/src="\/dist\/app\.js(\?v=[0-9A-Za-z]+)?[^"]*"/);
    if (!m) throw new Error('找不到 app.js 的 script 标签');
    if (!m[1]) throw new Error('app.js 的 URL 上没有 ?v=<哈希>——改了 JS 浏览器不换新包');
    return true;
  });

  // T378（2026-10-23）：单遍压缩产 app.js.map，前端上报的产物坐标才能解回源码。
  // 往返自检：产物里找字面量 → 算产物行:列 → 解码 → 必须落在对应源文件非空行。
  // 纯同步（readFileSync＋纯函数），不碰沙箱与共享键。
  check('load-order：app.js.map sourcemap 往返（T378）——产物坐标解回源文件', () => {
    const bundle = code;
    if (!/sourceMappingURL=app\.js\.map/.test(bundle.slice(-300))) throw new Error('产物尾部缺 sourceMappingURL 引用');
    const map = bundleMap();
    if (!map.sourcesContent || !map.sourcesContent[0]) throw new Error('map 缺 sourcesContent（离线解码依赖它）');
    if (!/source: config\.js =====/.test(map.sourcesContent[0])) throw new Error('拼接源缺文件边界 banner（解码无法归到源文件）');
    for (const [lit, file] of [['_VIZ_MOUNT_ROOT_MARGIN', 'render.js'], ['_reportClientError', 'utils.js'], ['WALLPAPER_SETS', 'config.js']]) {
      const idx = bundle.indexOf(lit);
      if (idx < 0) throw new Error('产物里找不到 ' + lit + '（顶层名不该被改名）');
      const before = bundle.slice(0, idx);
      const line = before.split('\n').length;
      const col = idx - (before.lastIndexOf('\n') + 1) + 1;
      const r = decodePosition(map, line, col);
      if (!r) throw new Error(lit + ' 解码失败（无 ≤ 该位置的映射段）');
      if (r.file !== file) throw new Error(lit + ' 应解回 ' + file + '，实得 ' + r.file + ':' + r.line);
      if (!r.text) throw new Error('解码行内容为空');
    }
    return true;
  });

  // 516 侧栏动作总线（2026-11-21）：重命名/图标定位必须走 event.target 向上
  // closest，不能用 event.currentTarget——容器委托后 currentTarget 指向 #sessionList
  // 容器，closest('.session-item') 必空，实测点重命名毫无反应、图标面板定位到整列表。
  check('516 侧栏委托：重命名/图标定位走 event.target 而非 currentTarget（防点不动回归）', () => {
    const src = fs.readFileSync('src/static/js/session.js', 'utf8');
    const stripComments = (s) => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    const bodyOf = (name) => {
      const start = src.indexOf('function ' + name + '(');
      if (start < 0) throw new Error('找不到函数 ' + name);
      const next = src.indexOf('\n    function ', start + 10);
      return stripComments(src.slice(start, next < 0 ? src.length : next));
    };
    const rename = bodyOf('startRenameSession');
    const icon = bodyOf('toggleIconPicker');
    if (!rename.includes("event.target.closest('.session-item')")) {
      throw new Error('startRenameSession 必须用 event.target.closest(".session-item") 定位所在行');
    }
    if (rename.includes('event.currentTarget')) {
      throw new Error('startRenameSession 不得再用 event.currentTarget（委托后指向列表容器）');
    }
    if (!icon.includes("event.target.closest('[data-act=\"sess-icon\"]')")) {
      throw new Error('toggleIconPicker 必须用 event.target 向上 closest 到 sess-icon 元素定位面板');
    }
    if (icon.includes('event.currentTarget')) {
      throw new Error('toggleIconPicker 不得再用 event.currentTarget 定位图标元素');
    }
    return true;
  });

  // 516 画布委托的同类回归：source-drop 容器内部嵌着带 data-act 的子控件（source-paste
  // 等），drop 落到子控件上时最近的 data-act 不是容器。handler 必须沿祖先链向上找
  // 第一个在当前事件类型登记了的动作，否则拖图片到「粘贴截图」框里静默不入篮。
  check('516 画布委托：drop 落在 source-paste 子控件上仍命中外层 source-drop', () => {
    vm.runInContext(`
      (function () {
        var calls = [];
        var dropScript = 'drop';
        var prevDrop = _GRAPH_ACT_TABLE[dropScript]['source-drop'];
        _GRAPH_ACT_TABLE[dropScript]['source-drop'] = function (el) { calls.push(el.dataset.act); };
        try {
          // 模拟 e.target = textarea[data-act=source-paste]，其父是 div[data-act=source-drop]
          var dropEl = { dataset: { act: 'source-drop', nodeId: 'n1' }, parentElement: null };
          var pasteEl = {
            dataset: { act: 'source-paste', nodeId: 'n1' },
            parentElement: dropEl,
            closest: function (sel) { return sel === '[data-act]' ? this : null; }
          };
          dropEl.closest = function (sel) { return sel === '[data-act]' ? this : null; };
          _graphActBusHandler({ type: 'drop', target: pasteEl, stopPropagation: function () {} });

          // 反例：source-paste 的 click 不在 click 表登记，整条链都没登记 → 不得误触发
          var clickCalls = [];
          var prevClick = _GRAPH_ACT_TABLE.click['source-add'];
          _GRAPH_ACT_TABLE.click['source-add'] = function (el) { clickCalls.push(el.dataset.act); };
          try {
            _graphActBusHandler({ type: 'click', target: pasteEl, stopPropagation: function () {} });
          } finally {
            _GRAPH_ACT_TABLE.click['source-add'] = prevClick;
          }
          globalThis.__smoke516Drop = { calls: calls, clickCalls: clickCalls };
        } finally {
          _GRAPH_ACT_TABLE[dropScript]['source-drop'] = prevDrop;
        }
      })();
    `, sandbox);
    const r = JSON.parse(vm.runInContext('JSON.stringify(globalThis.__smoke516Drop)', sandbox));
    if (r.calls.length !== 1 || r.calls[0] !== 'source-drop') {
      throw new Error('drop 落在 source-paste 上应命中 source-drop 一次，实得 ' + JSON.stringify(r.calls));
    }
    if (r.clickCalls.length !== 0) {
      throw new Error('source-paste 的 click 不该误触发任何登记动作，实得 ' + JSON.stringify(r.clickCalls));
    }
    vm.runInContext('delete globalThis.__smoke516Drop', sandbox);
    return true;
  });
}
