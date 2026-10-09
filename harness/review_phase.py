"""Φ 相位与意图识别（T82 关键词表超集契约）＋撤销意图/逆操作过滤。

自 review.py 拆出（2026-10-04，T163）：全部为纯函数与常量，不触模型、不触 IO；
调用方与 tests 仍经 harness.review 导入（那边已 re-import）。tests/test_harness_loop.py
的 T82 用例逐词钉住关键词表覆盖，改表先读那边。
"""

from .core import normalize_snapshot

# T82 收敛（后端半边）：相位识别权归 _detect_phase 一处。前端 payload 只直通
# chat/preset/apply/expand，normal/evaluate 的本地猜测一律降级为 normal——所以
# 下面四张关键词表必须覆盖前端旧正则的每一个分支（超集，缺词＝识别退化；
# 逐词覆盖由 tests/test_harness_loop.py 的 T82 用例钉住）。
EVALUATE_HINTS = (
    "评价", "建议", "反馈", "点评", "指出", "哪里需要改进",
    "挑错", "有问题吗", "对不对", "哪里不对", "帮我看看",
)
APPLY_HINTS = ("应用建议", "采纳建议", "按建议", "执行建议", "应用评价", "按评价")
MODIFY_HINTS = (
    "修改", "改成", "更正", "纠正", "重写", "更新", "删掉", "删除",
    "补充", "新增", "创建", "连接", "加上", "加一个", "补一个", "改进", "完善",
)
EXPAND_HINTS = ("拓展", "进阶", "延伸学习", "深入学习", "深化")

TOOLS_USER_HINT = (
    "\n\n（本次请求支持工具调用：请优先使用提供的工具提交 operations，"
    "不要在文本里重复输出 JSON；文本内容只写一句话 summary。若工具不可用，再按上面的 JSON 结构输出。）"
)
TOOLS_AUTO_HINT = (
    "\n\n（本次支持两种回答方式：如果用户只是提问/讨论，请直接用文字回答，不需要调用工具；"
    "如果用户要求修改图，请使用工具提交 operations，文本只写一句话 summary。）"
)

# ---- T93（评审路线 #8）只读查询回灌：先查图，看完了再决定改哪 ----
# 工具表含只读查询工具时（normal/expand/apply/preset），给 user 消息补的使用说明。
# 2026-10-09 优化新路径六第 1 档：并入 graph_stats（学习教练）。
READONLY_TOOLS_HINT = (
    "\n\n（你可以先调用只读查询工具（read_node / list_neighbors / search_nodes）"
    "了解图中内容，用 search_knowledge / search_formulas 检索用户的知识库与公式速查，"
    "用 graph_stats 做整图学习结构体检（连通分量/链深梯度/无先修知识节点/检测薄弱点覆盖）；"
    "再输出编辑操作；查询不会修改图。）"
)
# 答疑模式（2026-10-03 智能化第二期）专用的 user 消息工具说明：chat 相位工具表
# 是纯只读，通用 TOOLS_AUTO_HINT 的「用户要求修改图请使用工具」与答疑红线矛盾，
# 不能照抄——chat 只讲「先查后答、绝不改图」。
HARNESS_CHAT_TOOLS_HINT = (
    "\n\n（你可以调用只读查询工具：read_node / list_neighbors / search_nodes 查看图，"
    "search_knowledge / search_formulas 检索用户的知识库与公式速查，"
    "graph_stats 查整图学习结构统计——用户问「该先学什么/学习路线合不合理」时先拉它再答；"
    "先查再答，回答引用出处。当前是答疑模式：不要输出任何编辑操作，直接用文字回答。）"
)
UNDO_HINTS = (
    "撤销", "回退", "恢复", "还原", "撤回", "不要刚才", "重来",
    "改回去", "改回", "退回", "退回去", "撤掉", "撤了", "不要了",
    "刚加的", "删掉刚才", "undo", "rollback",
)


def _detect_undo_intent(instruction: str) -> bool:
    text = str(instruction or "")
    return any(hint in text.lower() for hint in UNDO_HINTS)


# ---- T226：确定性撤销的「短指令」门槛 ----
# UNDO_HINTS 是宽泛子串匹配，「这个公式不要了，删掉它」「把公式恢复成正确写法」
# 这类**复合编辑指令**会误命中撤销词 → 图被确定性回滚、summary 还谎报「已撤销
# 上一步修改」。修法：给确定性撤销加「指令足够短」门槛，配在 review.py:1018
# 使用处（_detect_undo_intent 函数内部**不动**——它还有 review.py:1605 的
# 「编辑意图重试」判定在用，改内部会顺带改掉那处语义）。
# 取舍一：长指令＝复合编辑指令，交给模型带上下文自行判断；「命中即不调模型」的
# 拍板对短指令原样保留。
# 取舍二：前端「↩ 撤销上一条」按钮的实际文案是「撤销刚才的修改，恢复原样」
# （12 字符，harness-run.js undoLastHarnessEdit 实发），语义却毫不含糊就是撤
# 上一步；而误报示例「把公式恢复成正确写法」只有 10 字符——**任何纯长度阈值
# 都无法同时放行前者又分流后者**。故对明确指回「上一步」的指令放开长度限制
# （回溯标记均出自本表撤销语族：刚才/刚加/上一步…）。复合编辑指令不会指回
# 上一步，两者可分。
UNDO_MAX_INSTRUCTION_CHARS = 8
_PREVIOUS_STEP_MARKERS = ("刚才", "刚刚", "刚加", "上一步", "上一次")


def _is_unambiguous_undo(text: str) -> bool:
    """指令是否构成无歧义撤销（T226 短指令门槛）。

    指令去空白后足够短（<= UNDO_MAX_INSTRUCTION_CHARS），或明确指回「上一步」
    时返回 True——此时命中撤销词就是撤销本身；否则视为复合编辑指令，其中的
    撤销词只是从句里的附带说法，不应触发确定性回滚。
    """
    s = str(text or "").strip()
    if not s:
        return False
    if len(s) <= UNDO_MAX_INSTRUCTION_CHARS:
        return True
    return any(marker in s for marker in _PREVIOUS_STEP_MARKERS)


def _filter_inverse_by_targets(inverse_ops: list, targets, snapshot=None) -> list:
    targets = {str(item) for item in (targets or []) if str(item)}
    if not targets:
        return inverse_ops
    edge_ends = {}
    if snapshot is not None:
        try:
            norm = normalize_snapshot(snapshot)
            for e in norm["edges"]:
                key = str(e.get("key") or "")
                if key:
                    edge_ends[key] = {str(e.get("from") or ""), str(e.get("to") or "")}
        except Exception:
            edge_ends = {}
    kept = []
    for op in inverse_ops:
        ids = [op.get("id"), op.get("from"), op.get("to"), op.get("temp_id"), op.get("force_id")]
        if any(str(item) in targets for item in ids if item):
            kept.append(op)
            continue
        ek = str(op.get("edge_key") or op.get("key") or "")
        ends = edge_ends.get(ek)
        if ends and ends & targets:
            kept.append(op)
    if kept:
        # 恢复对成对判定：保住 add_edge(T->D) 时，它端点 D 的 restore_node 也
        # 必须一起保——只留边不留节点，build_next_snapshot 会报「终点不存在」，
        # 这条边从此撤不回来（09-20 修复）
        kept_ends = set()
        for op in kept:
            if str(op.get("op") or "") == "add_edge":
                for end in (op.get("from"), op.get("to")):
                    if end:
                        kept_ends.add(str(end))
        if kept_ends:
            for op in inverse_ops:
                if str(op.get("op") or "") == "restore_node" \
                        and str(op.get("id") or "") in kept_ends and op not in kept:
                    kept.append(op)
    return kept


def _undo_scope(instruction: str, focus_node_ids) -> str:
    """Decide how much history an undo request should revert.

    - 'full': 撤销全部/所有修改（回到最初快照）
    - 'targeted': 指定了目标节点，且表达“恢复原样/改回去/撤掉”等上下文反悔
      —— 撤销该目标相关的全部历史改动，保留其它改动
    - 'last': 只撤销上一步修改
    """
    text = str(instruction or "")
    if "全部" in text or "所有" in text:
        return "full"
    if focus_node_ids and any(k in text for k in (
        "恢复", "还原", "原样", "改回", "退回", "撤掉", "撤了", "不要了", "刚加的", "那边",
    )):
        return "targeted"
    return "last"
def _has_edit_intent(text: str) -> bool:
    """True when the instruction contains explicit graph-edit verbs."""
    return any(hint in str(text or "") for hint in MODIFY_HINTS)


# 模型用文字解释"为什么不做操作"时的特征词：目标不存在/已满足/受保护/无内容等。
# 此时再强制重试只是浪费一次模型调用（线上即数十秒延迟），应直接接受空操作结果。
_REFUSAL_MARKERS = (
    "不存在", "没有找到", "未找到", "找不到", "没有名为", "无此节点", "查无",
    "只读", "无法删除", "无法修改", "不能删除", "不能修改", "受保护", "不适合", "不宜",
    "已存在", "已经存在", "已有连线", "无需重复", "重复添加", "已经是",
    "空的", "空图", "没有节点", "暂无节点", "没有可评价", "无可评价", "无从评价", "没有内容",
)


def _refusal_explained(summary: str) -> bool:
    """模型是否在 summary 里给出了不做操作的具体原因。

    空操作 + 解释 = 合法拒绝（目标不存在 / 操作已满足 / 节点只读 / 图为空），
    强制重试只会逼模型编造操作；空操作 + 无解释才视为偷懒，需要重试。"""
    text = str(summary or "").strip()
    if len(text) < 8:
        return False
    return any(marker in text for marker in _REFUSAL_MARKERS)


def _detect_phase(phase: str, instruction: str, snapshot: dict, focus_node_ids=None) -> str:
    """Choose the intended harness phase from explicit phase or instruction hints."""
    text = str(instruction or "")
    has_eval = any(hint in text for hint in EVALUATE_HINTS)
    has_modify = any(hint in text for hint in MODIFY_HINTS)
    has_expand = any(hint in text for hint in EXPAND_HINTS)
    has_apply = any(hint in text for hint in APPLY_HINTS)
    focus_ids = [str(item) for item in (focus_node_ids or []) if str(item)]
    has_eval_nodes = any(node.get("kind") == "ai_eval" for node in snapshot.get("nodes", []))
    # 创造模式（P3，D-R6）：只有前端「✦ 创造模式」按钮显式锁定 phase=preset 才进入，
    # 意图词检测永不猜它——误触少、边界清楚
    if phase == "preset":
        return "preset"
    # 答疑模式（三模式切换器，2026-09-30）：显式只读通道，与 preset 同款直通，
    # 意图词检测永不改写它
    if phase == "chat":
        return "chat"
    auto_phases = ("", "auto", "normal")
    if phase == "apply" or (phase in auto_phases and has_apply and has_eval_nodes):
        return "apply"
    # 显式 expand 直通（此前 explicit expand 混在 auto_phases 里，会被评价词覆盖）
    if phase == "expand" or (phase in auto_phases and has_expand and focus_ids):
        return "expand"
    if phase == "evaluate" or (phase in auto_phases and has_eval):
        return "evaluate"
    if phase in auto_phases and has_modify and not has_eval:
        return "normal"
    return "normal"
