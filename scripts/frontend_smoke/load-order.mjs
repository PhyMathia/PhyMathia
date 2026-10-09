// 首屏脚本加载契约（T208）。index.html 的 app.js 原本是全页唯一同步外部脚本，
// 且不处在文件末尾（259 行处、后面还有 560 行标记）——浏览器要先下载并执行完
// 1.2MB 才继续解析后半页，期间不画屏；defer 后改为全 DOM 建完再执行。
// 本域静态断言（读 index.html 原文）守住两个容易手滑回退的点：加载属性被改回
// 同步、填版本号的内联脚本不再等 DOMContentLoaded。真正的执行时序冒烟沙箱
// 覆盖不到（沙箱不读 index.html、不跑浏览器），由 scripts/verify_load_defer.mjs
// 真机验。
// 不碰共享 localStorage 键；纯同步段，注册在薄壳尾部（token-usage 之后）。
import { check, fs } from './_runner.mjs';

const readIndex = () => fs.readFileSync('src/static/index.html', 'utf8');

export function run() {
  check('load-order：app.js 标签带 defer（不得回退同步阻塞）', () => {
    const html = readIndex();
    const m = html.match(/<script[^>]*src="\/js\/app\.js[^"]*"[^>]*>/);
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
    const m = html.match(/src="\/js\/app\.js(\?v=[0-9A-Za-z]+)?[^"]*"/);
    if (!m) throw new Error('找不到 app.js 的 script 标签');
    if (!m[1]) throw new Error('app.js 的 URL 上没有 ?v=<哈希>——改了 JS 浏览器不换新包');
    return true;
  });
}
