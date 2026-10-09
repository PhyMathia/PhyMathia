#!/usr/bin/env node
// ===== 本地 mock 上游（OpenAI 兼容 /chat/completions SSE）=====
// 用途（backlog T57 落地）：给「改了发送链必须真发验证」的脚本一个可提交的假上游，
//   不花钱、不依赖真模型密钥。用法：
//     node scripts/mock_upstream.mjs            # 默认端口 5065（T84：5060/5061 是 undici 坏端口，Node 直连报 bad port）
//     PORT=5070 node scripts/mock_upstream.mjs
//   然后把某个模型槽指向它：
//     provider=opencode-go, baseUrl=http://127.0.0.1:5065/v1, model=mock-1, apiKey 任意
//   已知的消费方：
//     scripts/harness_battery.mjs  （MODEL_CFG 指到本 mock：node scripts/harness_battery.mjs http://localhost:5052 mock-1 里的 BASE/MODEL 配好即可）
//     scripts/verify_send_channels.mjs（主聊天/分支/苏格拉底通道真发取证）
// 回包保真度坑（T57，按踩到顺序）：
//   ① 内容必须每次都不同（带自增序号），否则「重生成后内容真的变了」断言永远过不了；
//   ② 苏格拉底模块必须吐 <extend> 段＋「1. [基础] …」带级别标记的编号行，
//     否则产品走兜底端口、question 为空（连带 T56）；
//   ③ 建议模块要靠分析文本里的「建议模块：物理视角、数学视角、苏格拉底追问」一行，
//     缺了默认只长 physics/math。
// 真机通道剧本（2026-09-30 追加，供 verify_phi_sessions 通道⑩⑪）：
//   ④ T93 只读工具回灌：tools 含 read_node 且指令含「细读」时，第一次（messages 里
//      还没有 role:"tool"）只回 read_node 的 tool_calls；回灌后的第二次回 update_node
//      编辑调用——这样一轮对话里必然出现「查询 → 回灌 → 编辑」多步循环；
//   ⑤ T95 429 退避重试：「限流演练」关键词第一次必 429（Retry-After: 0），第二次放行；
//      GET /__stats 返回全局计数（真机脚本核对「同一对话真的发了 ≥2 次请求」）。
import http from 'node:http';

const PORT = Number(process.env.PORT || 5065);
let seq = 0;
const nextId = () => 'mock-' + Date.now() + '-' + (++seq);

// 剧本计数器（长驻进程按全局；verify 脚本按增量读 /__stats）
const stats = { chatRequests: 0, retryScripts: {}, selfcheckResultState: 0, semanticRecall: 0, graphStats: 0, coachReport: 0 };
const rateLimitSeen = {};

// 从请求 messages 里抽取"要看什么"的判据文本
function judgeOf(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...msgs].reverse().find(m => m.role === 'user');
  const system = msgs.find(m => m.role === 'system') || {};
  return {
    userText: String((lastUser && lastUser.content) || ''),
    allText: msgs.map(m => String(m.content || '')).join('\n'),
    systemText: String(system.content || ''),
    tools: Array.isArray(body.tools) ? body.tools.map(t => t.function && t.function.name).filter(Boolean) : [],
  };
}

function sseChunk(delta) {
  return 'data: ' + JSON.stringify({ id: nextId(), choices: [{ delta: { content: delta.content || '' }, tool_calls: delta.tool_calls }] }) + '\n\n';
}

function sseDone() {
  return 'data: ' + JSON.stringify({ id: nextId(), choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n';
}

function replyOf(body) {
  const j = judgeOf(body);
  const t = j.userText + '\n' + j.systemText;
  const sfx = '（第 ' + (seq + 1) + ' 次）';
  const text = (s) => ({ content: s });
  // —— T95 429 退避重试剧本（真机通道⑪）：同关键词第一次必 429、第二次放行 ——
  // 必须排在只读回灌分支之前：429 剧本的指令若与画布快照里出现的关键词（如节点
  // label 带「细读」）撞车，优先走重试剧本，否则会被 read_node 分支截胡。
  // _status 由请求处理端识别并直接以此状态码回包（响应头带 Retry-After: 0，
  // 后端 _call_model 读到后免等待立即重试）；第二次走正常回包，重试对用户无感。
  if (t.includes('限流演练')) {
    const seen = (rateLimitSeen['限流演练'] = (rateLimitSeen['限流演练'] || 0) + 1);
    if (seen === 1) {
      return {
        _status: 429,
        _headers: { 'content-type': 'application/json', 'retry-after': '0' },
        _body: { error: { message: 'mock 限流演练：第一次必 429（Retry-After: 0），第二次放行', type: 'rate_limit_exceeded' } },
      };
    }
    return text('限流演练第二次已放行：mock 正常回包 ' + sfx + '，用于验证 429 自动重试无感。');
  }
  // —— 创造模式（P3 battery）：按指令关键词回配方 tool_calls ——
  // 结构体形式：由请求处理端按 stream 与否输出 SSE 分帧或整包 JSON（harness 的
  // 模型调用是非流式的——只回 SSE 会让后端 JSON 解析失败，2026-09-29 踩过）
  const toolCall = (name, args) => ({
    content: '好的，这是按你的要求准备的配方操作 ' + '（第 ' + (seq + 1) + ' 次）',
    tool_calls: [{ id: 'call_' + nextId(), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
  // —— T93 只读查询回灌（Φ 多步循环真机通道⑩）：先查图，回灌后再出编辑 ops ——
  // 第一次（messages 里还没有 role:"tool"）回 read_node 查询；后端执行查询并以
  // role:"tool" 回灌后的第二次回 update_node 编辑调用（reason 必填，照工具 schema）。
  // —— 路径二第一步（质检看结果图，2026-10-09）两个分支须在 toolCall 声明之后
  // （同一函数作用域，放在声明前是 TDZ ReferenceError，critic 请求会把 mock 进程
  // 直接打崩——本轮 battery 首跑实踩）——
  // ① 质检员请求＝tools 含 submit_selfcheck：stats.selfcheckResultState 计数
  //    「质检请求确实看到了结果图段」（battery criticSawResultState 断言读 /__stats）；
  //    「公式核对演练」剧本判 false（公式未达成）→ 主循环带反馈重试；其他场景的
  //    质检请求不在此返回，维持既有「落兜底文本→parse_error→放行」，零行为变化。
  if (j.tools.includes('submit_selfcheck')) {
    if (j.allText.includes('操作执行后的结果图')) stats.selfcheckResultState += 1;
    if (t.includes('公式核对演练')) {
      return toolCall('submit_selfcheck', {
        ok: false,
        issues: ['公式未达成：导数节点的公式没有改成 F=ma，改的都不是公式字段'],
        missing: ['把导数节点 A 的公式更新为 F=ma'],
      });
    }
  }
  // ② 主链路剧本：第一次四条合法操作（>3 条触发质检门）但没一条改公式；
  //    重试消息带质检反馈「公式未达成」字样，据此回正确的一条 update_node。
  if (!j.tools.includes('submit_selfcheck') && t.includes('公式核对演练')) {
    if (j.allText.includes('公式未达成')) {
      return toolCall('update_node', { node_id: 'A', patch: { formula: 'F=ma' }, reason: '按指令把导数公式改成 F=ma' });
    }
    return {
      content: '好的，按你的要求整理导数相关的图 ' + sfx,
      tool_calls: [
        { id: 'call_u1_' + nextId(), type: 'function', function: { name: 'update_node', arguments: JSON.stringify({ node_id: 'A', patch: { label: '导数（概念）' }, reason: '整理标题' }) } },
        { id: 'call_u2_' + nextId(), type: 'function', function: { name: 'update_node', arguments: JSON.stringify({ node_id: 'D', patch: { content: '（润色）导数描述变化快慢' }, reason: '顺手润色' }) } },
        { id: 'call_e1_' + nextId(), type: 'function', function: { name: 'update_edge', arguments: JSON.stringify({ edge_key: 'B:out-0->A:in-0', patch: { relation: '前置' }, reason: '明确关系' }) } },
        { id: 'call_e2_' + nextId(), type: 'function', function: { name: 'add_edge', arguments: JSON.stringify({ from: 'D', to: 'C', relation: '补充', reason: '把理解接到物理视角' }) } },
      ],
    };
  }
  // —— 路径二第二步（达成清单机检，2026-10-09）：≤3 条操作不触发质检门，
  // 只有本地机检能拦下「自报目标未达成」。主链路第一次两条合法操作＋content
  // JSON 外壳里带 checklist（自报「导数的 formula 已更新为 F=ma」，实际没改公式）
  // → 机检带反馈重试；重试消息含「达成清单未达成」→ 回正确的一条 update_node＋
  // 同一份 checklist（重试达成→warnings 汇总「本次目标 1 条，达成 1 条」）。
  if (!j.tools.includes('submit_selfcheck') && t.includes('达成清单演练')) {
    const checklist = ['「导数」的 formula 已更新为「F=ma」'];
    if (j.allText.includes('达成清单未达成')) {
      return {
        content: JSON.stringify({ summary: '已把导数的公式改成 F=ma', checklist }),
        tool_calls: [{ id: 'call_chkfix_' + nextId(), type: 'function', function: { name: 'update_node', arguments: JSON.stringify({ node_id: 'A', patch: { formula: 'F=ma' }, reason: '按达成清单把导数公式改成 F=ma' }) } }],
      };
    }
    return {
      content: JSON.stringify({ summary: '已按要求整理导数', checklist }),
      tool_calls: [
        { id: 'call_ck1_' + nextId(), type: 'function', function: { name: 'update_node', arguments: JSON.stringify({ node_id: 'A', patch: { label: '导数（概念）' }, reason: '整理标题' }) } },
        { id: 'call_ck2_' + nextId(), type: 'function', function: { name: 'update_node', arguments: JSON.stringify({ node_id: 'D', patch: { content: '（润色）导数描述变化快慢' }, reason: '顺手润色' }) } },
      ],
    };
  }
  // —— 路径三（语义检索，2026-10-09）：第一次回 search_nodes(keyword=电磁感应)；
  // 图里只有「法拉第定律」节点（正文无「电磁感应」字样），字面必 miss——回灌的
  // role:"tool" 结果里含「法拉第定律」即语义召回命中（stats.semanticRecall 计数，
  // battery semanticRecall 断言读 /__stats），据此回 update_node 改 F 节点。
  if (j.tools.includes('search_nodes') && t.includes('同义检索演练')) {
    const fedTool = (Array.isArray(body.messages) ? body.messages : [])
      .some(m => m && m.role === 'tool' && String(m.content || '').includes('法拉第定律'));
    if (fedTool) {
      stats.semanticRecall += 1;
      return toolCall('update_node', { node_id: 'F', patch: { content: '（已结合电磁感应复习）磁通量变化产生感应电动势，ε=-dΦ/dt' }, reason: '按检索到的法拉第定律节点补充复习标注' });
    }
    return {
      content: '',
      tool_calls: [{ id: 'call_sem1', type: 'function', function: { name: 'search_nodes', arguments: JSON.stringify({ keyword: '电磁感应' }) } }],
    };
  }
  // —— 路径六第 2 档（课程表体检报告，2026-10-09）：统计已由服务端预计算注入
  // user 消息（匹配锚「已代你计算」——注入块独有措辞；不能用「整图学习结构统计」
  // 作锚：chat 答疑相位的工具提示词里本来就有这六个字，会把第 1 档的答疑剧本
  // 全部截胡，首跑实踩），据此一次调用直接回报告＋建议批次（3 条 ops：补先修
  // 连线把孤岛「动量守恒」接回主体＋为检测薄弱点补进阶链；≤3 条不触发质检门）。
  // stats.coachReport 计数「体检请求确实带上了注入统计块」（battery statsInjected
  // 断言读 /__stats）。排在「学习路线演练」分支之前双保险。
  if (j.tools.includes('graph_stats') && j.userText.includes('已代你计算')) {
    stats.coachReport += 1;
    return {
      content: '体检报告：这张图分成了 2 个互不连通的部分，「动量守恒」是孤岛主题（没有任何连线），也没有先修来源；检测薄弱的「动量守恒」错了 2 次掌握度 40，图上只有这 1 个节点、没有进阶链。建议先学连通主体打地基，再补动量守恒的先修连线与进阶链。',
      tool_calls: [
        { id: 'call_coach_e1_' + nextId(), type: 'function', function: { name: 'add_edge', arguments: JSON.stringify({ from: 'B', to: 'E', relation: '前置', label: '动量守恒的冲量计算依赖微积分基础', reason: '补先修连线：孤岛「动量守恒」接回连通主体' }) } },
        { id: 'call_coach_n1_' + nextId(), type: 'function', function: { name: 'create_node', arguments: JSON.stringify({ temp_id: 'n_coach_adv', kind: 'answer', label: '动量守恒的进阶学习', content: '碰撞与守恒律、变质量系统的进阶方向', reason: '为检测薄弱点「动量守恒」补进阶链' }) } },
        { id: 'call_coach_e2_' + nextId(), type: 'function', function: { name: 'add_edge', arguments: JSON.stringify({ from: 'E', to: 'n_coach_adv', relation: '进阶', reason: '薄弱点「动量守恒」接上进阶链' }) } },
      ],
    };
  }
  // —— 路径六第 1 档（学习教练，2026-10-09）：答疑「先拉 stats 再答」——
  // 第一次（还没回灌统计）回 graph_stats 调用；后端执行整图统计并以 role:"tool"
  // 回灌；第二次看到统计事实（"components" 等字段）后 stats.graphStats 计数并回
  // 引用统计数字的文字答案（chat 相位纯文本，绝不带编辑 ops）。
  if (j.tools.includes('graph_stats') && t.includes('学习路线演练')) {
    const fedStats = (Array.isArray(body.messages) ? body.messages : [])
      .some(m => m && m.role === 'tool' && String(m.content || '').includes('"components"'));
    if (fedStats) {
      stats.graphStats += 1;
      return text('先学「极限」：整图统计显示图分成了 2 个互不连通的部分，「动量守恒」是孤岛主题，且它没有任何先修来源连线；检测薄弱的「动量守恒」在图上有节点但没有向外延伸的进阶链——建议先学极限打地基，再给动量守恒补前置连线 ' + sfx);
    }
    return {
      content: '',
      tool_calls: [{ id: 'call_gs1', type: 'function', function: { name: 'graph_stats', arguments: '{}' } }],
    };
  }
  if (j.tools.includes('read_node') && t.includes('细读')) {
    const fedBack = (Array.isArray(body.messages) ? body.messages : []).some(m => m && m.role === 'tool');
    if (!fedBack) {
      return {
        content: '',
        tool_calls: [{
          id: 'call_read_1', type: 'function',
          function: { name: 'read_node', arguments: JSON.stringify({ node_id: 'phi_node_1' }) },
        }],
      };
    }
    return {
      content: '已细读 phi_node_1 的原文 ' + sfx,
      tool_calls: [{
        id: 'call_upd_' + nextId(), type: 'function',
        function: {
          name: 'update_node',
          arguments: JSON.stringify({
            node_id: 'phi_node_1',
            patch: { content: '细读后的准确表述：' + sfx },
            reason: '依据 read_node 读到的原文修正表述（mock 多步循环）',
          }),
        },
      }],
    };
  }
  if (j.tools.includes('create_recipe') && t.includes('三级追问')) {
    return toolCall('create_recipe', {
      reason: '用户要一个三级追问节点',
      recipe: {
        name: '三级追问', desc: '三级追问，出口即问题',
        base: { kind: 'module' },
        appearance: { palette: 'rose', shape: 'is-round' },
        generate: {
          prompt: '针对当前问题，从基础、进阶、拓展三级各生成一个追问。',
          strict_output: '只输出「### 追问」标题与三条编号行：1. [基础] … 2. [进阶] … 3. [拓展] …；禁止前言、答案、解释。',
          context_channel: 'workflow_context', model_role: 'agent',
        },
        ports: {
          static: [],
          dynamic: {
            parser: { pattern: 'numbered_list', level_tags: ['基础', '进阶', '拓展'], max: 12, label_from: 'index_question' },
            fallback: { mode: 'label_questions_from_text', labels: ['问题1', '问题2', '问题3'] },
            each: { type: 'socratic', branch_type: 'socratic', drag_form: 'draft' },
          },
        },
        content_kind: 'markdown',
      },
    });
  }
  if (j.tools.includes('create_recipe') && t.includes('考点复盘')) {
    return toolCall('create_recipe', {
      reason: '用户要一个双出口复盘配方',
      recipe: {
        name: '考点复盘', desc: '分考点与口诀',
        base: { kind: 'module' },
        appearance: { palette: 'amber', shape: 'is-round' },
        generate: { prompt: '分「考点回顾」「记忆口诀」两段输出。', strict_output: '只输出两段，每段以「### 」开头。', context_channel: 'workflow_context' },
        ports: { static: [{ label: '再测一道', drag_form: 'user' }, { label: '追问', drag_form: 'draft' }] },
        content_kind: 'markdown',
      },
    });
  }
  if (j.tools.includes('update_recipe') && t.includes('主提示词')) {
    return toolCall('update_recipe', {
      recipe_id: 'recipe-b1', reason: '按用户要求改提示词',
      recipe: {
        name: '错题复盘', base: { kind: 'module' },
        appearance: { palette: 'amber', shape: 'is-round' },
        generate: { prompt: '分考点、易错点、口诀三段输出。', context_channel: 'workflow_context' },
        ports: { static: [] }, content_kind: 'markdown',
      },
    });
  }
  if (j.tools.includes('delete_recipe') && t.includes('删除配方')) {
    return toolCall('delete_recipe', { recipe_id: 'recipe-b1', reason: '用户明确要求删除' });
  }
  // —— 主链路（verify_send_channels）：问题概要 / 模块 XML / 苏格拉底编号行 ——
  if (t.includes('只输出简洁的问题概要')) {
    return text('### 问题概要 ' + sfx + '\n核心概念：简谐运动；数学结构：二阶常系数线性微分方程；关系：回复力线性化导出振动方程。');
  }
  if (t.includes('建议模块')) {
    return text('物理直觉成立。综合来看：' + sfx + '\n建议模块：物理视角、数学视角、苏格拉底追问');
  }
  if (t.includes('完整学习卡片') || t.includes('<physics>')) {
    return text('<physics>\n简谐运动是回复力与位移成正比且反向的运动 ' + sfx + '。\n<formula>x(t)=A\\cos(\\omega t+\\varphi_0)</formula>\n</physics>\n<math>\n微分方程 <formula>\\frac{d^2x}{dt^2}+\\omega^2 x=0</formula> 的解即余弦型。\n</math>\n<extend>\n### 进阶学习方向\n1. 阻尼振动的运动方程\n2. 受迫振动与共振\n3. 从简谐运动到傅里叶分析\n### 苏格拉底追问\n1. [基础] 弹簧振子的回复力与位移有什么关系？\n2. [进阶] 如何由胡克定律与牛顿第二定律建立运动方程？\n3. [拓展] 加入阻尼后运动会如何变化？\n</extend>\n<summary>简谐运动＝线性回复力下的二阶线性微分方程解 ' + sfx + '。</summary>');
  }
  if (t.includes('苏格拉底追问') || (t.includes('三条编号行') && t.includes('[基础]'))) {
    return text('### 苏格拉底追问 ' + sfx + '\n1. [基础] 弹簧振子的回复力与位移有什么关系？\n2. [进阶] 如何由胡克定律与牛顿第二定律建立运动方程？\n3. [拓展] 加入阻尼后运动如何改变？');
  }
  // —— harness 自由 JSON 兜底（万一脚本走到 json 模式）——
  if (j.tools.length && t.includes('配方')) {
    return text('{"summary":"mock：请用工具调用产出配方操作 ' + sfx + '","operations":[]}');
  }
  // —— 兜底：友好中文一句（每次不同）——
  return text('收到' + sfx + '。这是一条 mock 上游回复，用于验证发送链路是否真的走通。');
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mock: true, seq }));
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model' }] }));
    return;
  }
  if (req.method === 'GET' && req.url === '/__stats') {
    // 真机脚本核对观测点（通道⑪）：chat_requests 总次数 + 各剧本关键词的
    // attempts（本关键词收到的 /chat/completions 次数）/ rejected_429（真的 429 了几次）
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ mock: true, seq, chat_requests: stats.chatRequests, retry_scripts: stats.retryScripts, selfcheck_result_state: stats.selfcheckResultState, semantic_recall: stats.semanticRecall, graph_stats: stats.graphStats, coach_report: stats.coachReport }));
    return;
  }
  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (e) {}
      stats.chatRequests += 1;
      const j = judgeOf(body);
      const rlEntry = (j.userText.includes('限流演练'))
        ? (stats.retryScripts['限流演练'] = stats.retryScripts['限流演练'] || { attempts: 0, rejected_429: 0 })
        : null;
      if (rlEntry) rlEntry.attempts += 1;
      const msg = replyOf(body);
      if (msg._status) {
        // 剧本要求的非 200 响应（429 等）：按指定状态码与响应头整包回
        if (rlEntry && msg._status === 429) rlEntry.rejected_429 += 1;
        res.writeHead(msg._status, msg._headers || { 'content-type': 'application/json' });
        res.end(JSON.stringify(msg._body || { error: 'mock scripted status' }));
        return;
      }
      if (body.stream) {
        // SSE：content 走 delta 增量；tool_calls 按 index 两帧（name / arguments）
        let frames = [];
        if (msg.content) frames.push(sseChunk({ content: msg.content }));
        if (msg.tool_calls) {
          msg.tool_calls.forEach((tc, i) => {
            frames.push('data: ' + JSON.stringify({ id: nextId(), choices: [{ delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] } }] }) + '\n\n');
            frames.push('data: ' + JSON.stringify({ id: nextId(), choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: tc.function.arguments } }] } }] }) + '\n\n');
          });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(frames.join('') + sseDone());
      } else {
        // 非流式：标准 OpenAI JSON 整包（harness 的 _call_model 走这条）
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: nextId(), object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls || [] }, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }] }));
      }
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[mock_upstream] listening on http://127.0.0.1:' + PORT + '/v1 (SSE chat/completions; model=mock-1)');
});
