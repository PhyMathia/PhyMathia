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

  check('暂定画布闸门（2026-10-13 空会话治理）：新建打标＋元数据上送/信标/同步上传/改名 PUT 四口全拦＋有内容摘帽', () => {
    const src = fs.readFileSync('src/static/js/session.js', 'utf8');
    const marks = src.match(/provisional: true/g) || [];
    if (marks.length < 2) throw new Error('createNewSession 与 init 兜底两处都必须打 provisional 标，实打 ' + marks.length + ' 处');
    const gate = src.match(/async function _saveSessionToServer\([\s\S]{0,240}?\n    \}/);
    if (!gate || !gate[0].includes('sessData.provisional')) throw new Error('_saveSessionToServer 缺暂定闸门（saveSessions/_saveSessionMeta 的唯一汇点）');
    if (!src.includes('if (_tombstonedSids.has(sid) || sdata.provisional) continue;')) {
      throw new Error('卸载信标的名单循环未跳过暂定画布');
    }
    if (!src.includes('!(localSessions[sid] && localSessions[sid].provisional)')) {
      throw new Error('15 秒同步的「本地独有上传」分支未跳过暂定画布');
    }
    if (!src.includes('if (!sessions[sessionId].provisional) fetch(`/api/sessions/${sessionId}`')) {
      throw new Error('改名 PUT 未跳过暂定画布（PUT 对陌生 id 会建条目绕开闸门）');
    }
    const unmark = src.match(/_markSessionContented\(/g) || [];
    if (unmark.length < 3) throw new Error('摘帽须被消息与图状态两个写入点调用（定义＋2 调用，实打 ' + unmark.length + ' 处引用）');
    return true;
  });

  check('空画布徽标（2026-10-13 空会话治理）：判定含 customNodes/connections/nodes 口径＋两处渲染挂 is-empty＋写入点失效缓存', () => {
    const src = fs.readFileSync('src/static/js/session.js', 'utf8');
    const fn = src.match(/function _sessionIsEmpty\([\s\S]{0,1600}?\n    \}/);
    if (!fn) throw new Error('找不到 _sessionIsEmpty');
    for (const key of ['customNodes', 'connections', 'nodes']) {
      if (!fn[0].includes(key)) throw new Error('空判定漏了 ' + key + ' 口径（纯工作流画布没有消息但不能误判空）');
    }
    const badges = src.match(/\$\{empty \? SESSION_EMPTY_MARK : ''\}/g) || [];
    if (badges.length < 2) throw new Error('普通行与多选行的标题都要挂空徽标，实挂 ' + badges.length + ' 处');
    if ((src.match(/' is-empty' : ''}/g) || []).length < 2) throw new Error('两处 renderItem 都要挂 is-empty 类');
    const invalidations = src.match(/_emptyBadgeCache\.delete\(/g) || [];
    if (invalidations.length < 6) {
      throw new Error('写入点（消息保存/图保存/服务端图拉回/清空/删除/同步拉回）都要失效徽标缓存，实打 ' + invalidations.length + ' 处');
    }
    return true;
  });
  await drain();
}
