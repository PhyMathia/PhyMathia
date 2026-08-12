# -*- coding: utf-8 -*-
"""苏格拉底闭环修复逻辑测试（临时文件，可删除）"""
import sys
sys.path.insert(0, 'D:/PhyMathia/src')
from server import context
_orig_fns = {name: getattr(context, name) for name in ("_mutate_json", "_read_socratic_state", "_write_socratic_state", "_delete_socratic_state")}

# 1) _sync_socratic_state_from_prompt：保留连对次数/已答轮数，刷新问题与等级
state = {"active": True, "level": "basic", "question": "旧问题", "correctStreak": 2, "answeredCount": 3}
context._sync_socratic_state_from_prompt(state, "[苏格拉底回答]\n追问等级：进阶\n追问问题：为什么振幅不影响周期？\n我的回答：因为周期与振幅无关")
assert state["level"] == "advanced", state
assert state["question"] == "为什么振幅不影响周期？", state
assert state["correctStreak"] == 2 and state["answeredCount"] == 3, state

# 2) _extract_parent_source
msgs = [
    {"role": "assistant", "timestamp": 1, "content": "<physics>物理</physics><extend>延伸问题</extend>"},
    {"role": "assistant", "timestamp": 2, "content": "继续追问 [基础] 下一题"},
]
assert context._extract_parent_source(msgs, 1, "extend") == "延伸问题"
assert context._extract_parent_source(msgs, 2, "extend") == ""

# 3) _delete_socratic_state：精确 key + 分支链前缀清理，保留其他会话
captured = {"data": {}}
orig_mutate = context._mutate_json
def fake_mutate(path, updater):
    captured["data"] = updater(dict(captured["data"]))
context._mutate_json = fake_mutate
captured["data"] = {
    "socratic:sess_abc": {"active": True},
    "socratic:br_sess_abc_1234567890": {"active": True},
    "socratic:br_sess_abc_abcdef1234": {"active": True},
    "socratic:br_sess_xyz_1234567890": {"active": True},
    "other_key": 1,
}
context._delete_socratic_state("sess_abc")
remaining = captured["data"]
assert "socratic:sess_abc" not in remaining
assert "socratic:br_sess_abc_1234567890" not in remaining
assert "socratic:br_sess_abc_abcdef1234" not in remaining
assert "socratic:br_sess_xyz_1234567890" in remaining
assert "other_key" in remaining

# 4) _load_session_context：复用 branchId 时整条苏格拉底链都在上下文，父卡片回退
fake_messages = [
    {"role": "user", "timestamp": 100, "content": "解释简谐运动"},
    {"role": "assistant", "timestamp": 101, "content": "<physics>物理</physics><math>数学</math><extend>\n1. [基础] 为什么加速度指向平衡位置？\n2. [进阶] 振幅影响周期吗？\n3. [拓展] 能量如何转化？</extend>"},
    {"role": "user", "timestamp": 102, "content": "[苏格拉底回答]\n追问等级：基础\n追问问题：为什么加速度指向平衡位置？\n我的回答：因为弹力指向平衡位置", "branch": "socratic", "branchId": "br_sess_abc_111", "branchType": "socratic", "parentId": "101", "sourceModule": "extend"},
    {"role": "assistant", "timestamp": 103, "content": "基本正确，但加速度由合力决定… <socratic_meta correct=\"partial\" done=\"false\" />", "branch": "socratic", "branchId": "br_sess_abc_111", "branchType": "socratic"},
    {"role": "user", "timestamp": 104, "content": "[苏格拉底回答]\n追问等级：基础\n追问问题：那加速度大小由什么决定？\n我的回答：由弹簧劲度系数和位移决定", "branch": "socratic", "branchId": "br_sess_abc_111", "branchType": "socratic", "parentId": "103", "sourceModule": "extend"},
]
orig_resolve = context._resolve_messages_path
orig_read = context._read_json
context._resolve_messages_path = lambda sid: "fake_path"
context._read_json = lambda path, default: fake_messages
try:
    result = context._load_session_context(
        "sess_abc", max_rounds=3, include_socratic=True,
        branch_id="br_sess_abc_111", branch_type="socratic",
        source_module="extend", parent_id="103",
    )
finally:
    context._resolve_messages_path = orig_resolve
    context._read_json = orig_read
joined = "\n".join(m["content"] for m in result)
assert "为什么加速度指向平衡位置" in joined, joined       # 父卡片 extend（回退）
assert "加速度由合力决定" in joined, joined                # 上一轮 AI 反馈（闭环连续）
assert "因为弹力指向平衡位置" in joined, joined           # 上一轮用户回答
assert "由弹簧劲度系数和位移决定" in joined, joined       # 当前回答
# 主线最近 2 轮会保留完整卡片（设计如此）；父卡片 extend 通过回退注入
assert "1. [基础] 为什么加速度指向平衡位置" in joined or "为什么加速度指向平衡位置" in joined

# 5) _update_socratic_state_from_content：streak 累计、答错清零、连续 2 次答对/done 结束
captured_state = {"active": True, "level": "basic", "question": "q", "correctStreak": 0, "answeredCount": 1}
calls = {"write": [], "delete": []}
context._read_socratic_state = lambda ref: captured_state
context._write_socratic_state = lambda ref, st: calls["write"].append((ref, dict(st)))
context._delete_socratic_state = lambda ref: calls["delete"].append(ref)
# 第 1 次答对：streak 0 -> 1，写回不删除
context._update_socratic_state_from_content('<socratic_meta correct="correct" done="false" />', "br_x")
assert calls["write"] and calls["write"][0][1]["correctStreak"] == 1, calls
assert calls["write"][0][1]["answeredCount"] == 2, calls
assert calls["delete"] == [], calls
# 第 2 次答错：streak 清零，写回
captured_state = dict(calls["write"][0][1])
calls = {"write": [], "delete": []}
context._update_socratic_state_from_content('<socratic_meta correct="wrong" done="false" />', "br_x")
assert calls["write"] and calls["write"][0][1]["correctStreak"] == 0, calls
assert calls["delete"] == [], calls
# 再答对两次：streak 1 -> 2 → 触发“连续答对 2 次结束”
captured_state = dict(calls["write"][0][1])
calls = {"write": [], "delete": []}
context._update_socratic_state_from_content('<socratic_meta correct="correct" done="false" />', "br_x")
assert calls["write"][0][1]["correctStreak"] == 1, calls
captured_state = dict(calls["write"][0][1])
calls = {"write": [], "delete": []}
context._update_socratic_state_from_content('<socratic_meta correct="correct" done="false" />', "br_x")
assert calls["delete"] == ["br_x"], calls
# done=true 直接结束
captured_state = {"active": True, "level": "basic", "question": "q", "correctStreak": 1, "answeredCount": 3}
calls = {"write": [], "delete": []}
context._update_socratic_state_from_content('<socratic_meta correct="correct" done="true" />', "br_x")
assert calls["delete"] == ["br_x"], calls

# 6) _socratic_state_instruction：包含轮数与兜底结束规则
context._read_socratic_state = lambda ref: {"active": True, "level": "advanced", "question": "q?", "correctStreak": 1, "answeredCount": 5}
inst = context._socratic_state_instruction("br_x")
assert "问题等级=advanced" in inst, inst
assert "已连续答对 1 次" in inst, inst
assert "已问答 5 轮" in inst, inst
assert "结束闭环" in inst, inst
context._read_socratic_state = lambda ref: None
assert context._socratic_state_instruction("br_x") == "", inst

# 7) _load_session_context_from_path：中间轮父消息无 extend 标签时回退到原始卡片 + 保留分支链
context._resolve_messages_path = lambda sid: "fake_path2"
context._read_json = lambda path, default: fake_messages
try:
    result2 = context._load_session_context_from_path(
        "sess_abc", [{"kind": "answer", "timestamp": "103", "module": "extend"}],
        branch_id="br_sess_abc_111", source_module="extend", max_rounds=3,
        current_prompt="[苏格拉底回答]\n追问问题：那加速度大小由什么决定？\n我的回答：由弹簧劲度系数和位移决定",
    )
finally:
    context._resolve_messages_path = orig_resolve
    context._read_json = orig_read
joined2 = "\n".join(m["content"] for m in result2)
assert "为什么加速度指向平衡位置" in joined2, joined2   # 回退到原始卡片 extend
assert "加速度由合力决定" in joined2, joined2            # 上一轮 AI 反馈
assert "由弹簧劲度系数和位移决定" in joined2, joined2   # 当前回答

# 8) _resolve_socratic_branch：手动路径定位最近活动分支 / 消息回退 / 空
kv_fake = {
    "socratic:sess_abc": {"active": True, "updatedAt": 100},
    "socratic:br_sess_abc_old": {"active": True, "updatedAt": 200},
    "socratic:br_sess_abc_new": {"active": True, "updatedAt": 300},
    "socratic:br_sess_abc_done": {"active": False, "updatedAt": 400},
    "other": 1,
}
def fake_read3(path, default):
    if str(path) == "fake_messages":
        return fake_messages
    if str(path) == str(context.KV_PATH):
        return kv_fake
    return default
context._resolve_messages_path = lambda sid: "fake_messages"
context._read_json = fake_read3
try:
    assert context._resolve_socratic_branch("sess_abc") == "br_sess_abc_new", context._resolve_socratic_branch("sess_abc")
    # 无活动分支状态时，回退到消息里最近一条苏格拉底消息的分支
    kv_fake.pop("socratic:br_sess_abc_old")
    kv_fake.pop("socratic:br_sess_abc_new")
    assert context._resolve_socratic_branch("sess_abc") == "br_sess_abc_111", context._resolve_socratic_branch("sess_abc")
    # 都没有：无活动状态且消息里也没有苏格拉底消息
    kv_fake.pop("socratic:sess_abc")
    def fake_read_empty(path, default):
        if str(path) == "fake_messages":
            return [{"role": "user", "content": "普通问题", "timestamp": 1}]
        return kv_fake
    context._read_json = fake_read_empty
    assert context._resolve_socratic_branch("sess_abc") == "", context._resolve_socratic_branch("sess_abc")
finally:
    context._resolve_messages_path = orig_resolve
    context._read_json = orig_read

# 9) _is_socratic_prompt_text / _is_socratic_message 新前缀 / 指令 mode 与 lastCorrect/lastConfidence
assert context._is_socratic_prompt_text("[苏格拉底回答]\n追问问题：x")
assert context._is_socratic_prompt_text("[苏格拉底提示]\n追问问题：x")
assert context._is_socratic_prompt_text("[苏格拉底讲解]\n追问问题：x")
assert not context._is_socratic_prompt_text("普通问题")
assert not context._is_socratic_prompt_text("")
assert context._is_socratic_message({"role": "user", "content": "[苏格拉底提示]\n追问问题：x"})
assert context._is_socratic_message({"role": "user", "content": "[苏格拉底讲解]\n追问问题：x"})
state9 = {"active": True, "level": "advanced", "question": "q?", "correctStreak": 1, "answeredCount": 2, "lastCorrect": "partial", "lastConfidence": "很有把握"}
context._read_socratic_state = lambda ref: state9
inst9 = context._socratic_state_instruction("br_x", "answer")
assert "上一轮判定：partial" in inst9, inst9
assert "用户上次自评把握：很有把握" in inst9, inst9
instHint = context._socratic_state_instruction("br_x", "hint")
assert "【提示】" in instHint and "不输出 <socratic_meta>" in instHint, instHint
instExplain = context._socratic_state_instruction("br_x", "explain")
assert "【讲解】" in instExplain and 'done="true"' in instExplain, instExplain
context._read_socratic_state = lambda ref: None
assert context._socratic_state_instruction("br_x", "hint") == ""

for _name, _fn in _orig_fns.items():
    setattr(context, _name, _fn)

print("ALL SOCRATIC FIX TESTS PASSED")
