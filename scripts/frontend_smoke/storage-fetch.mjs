// 会话存储层 fetch 超时契约（T237）：session.js 里每处 fetch 都必须挂
// AbortSignal.timeout——同步链路（批量消息/会话元数据/图状态/保存/删除/卸载
// 信标）任何一处挂死都会让整条链静默停在半路（服务端已生效、本地状态对不上），
// 且调用方 catch 到也只能 warn。静态守卫：新增无 signal 的 fetch 即红。
// 检查手法：逐处 fetch( 匹配到配平右括号，调用文本内必须出现 signal:。
import { check, drain, fs } from './_runner.mjs';

export async function run() {
  check('session.js fetch 超时契约（T237：每处 fetch 必带 AbortSignal.timeout）', () => {
    const src = fs.readFileSync('src/static/js/session.js', 'utf8');
    const bare = [];
    for (const m of src.matchAll(/fetch\(/g)) {
      let depth = 1;
      let i = m.index + m[0].length;
      while (i < src.length && depth > 0) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') depth--;
        i++;
      }
      const call = src.slice(m.index, i);
      if (!call.includes('signal:')) bare.push(call.split('\n')[0].trim());
    }
    if (bare.length) {
      throw new Error('无超时兜底的 fetch：\n' + bare.join('\n'));
    }
    return true;
  });
  await drain();
}
