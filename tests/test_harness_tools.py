"""Unit tests for harness.tools: tool schemas and tool_calls -> op conversion."""

import os
import sys
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from harness.tools import PHASE_TOOLS, TOOL_TO_OP, build_tools, parse_tool_calls


def _call(name, arguments):
    return {"function": {"name": name, "arguments": arguments}}


class BuildToolsTest(unittest.TestCase):
    def test_unknown_phase_returns_empty(self):
        self.assertEqual(build_tools("nonsense"), [])
        # 空阶段按设计回退 normal（phase or "normal"）
        self.assertEqual(len(build_tools("")), len(PHASE_TOOLS["normal"]))

    def test_every_phase_tool_name_has_schema(self):
        for phase, names in PHASE_TOOLS.items():
            schemas = build_tools(phase)
            self.assertEqual([s["function"]["name"] for s in schemas], names)

    def test_evaluate_phase_only_gets_eval_tool(self):
        schemas = build_tools("evaluate")
        self.assertEqual([s["function"]["name"] for s in schemas], ["create_eval_node"])

    def test_schema_shape(self):
        schema = build_tools("normal")[0]
        self.assertEqual(schema["type"], "function")
        params = schema["function"]["parameters"]
        self.assertEqual(params["type"], "object")
        self.assertTrue(params["required"])
        self.assertIn("properties", params)


class ParseToolCallsErrorsTest(unittest.TestCase):
    def test_non_list_input(self):
        self.assertEqual(parse_tool_calls(None), ([], []))
        self.assertEqual(parse_tool_calls("nope"), ([], []))

    def test_non_dict_call(self):
        ops, errors = parse_tool_calls(["junk"])
        self.assertEqual(ops, [])
        self.assertEqual(errors[0]["reason"], "工具调用格式非法")

    def test_missing_function_field(self):
        ops, errors = parse_tool_calls([{"id": 1}])
        self.assertEqual(ops, [])
        self.assertEqual(errors[0]["reason"], "工具调用缺少 function 字段")

    def test_unknown_tool_name(self):
        ops, errors = parse_tool_calls([_call("destroy_world", "{}")])
        self.assertEqual(ops, [])
        self.assertEqual(errors[0]["reason"], "不支持的工具: destroy_world")

    def test_unparseable_arguments(self):
        ops, errors = parse_tool_calls([_call("delete_node", "not-json{")])
        self.assertEqual(ops, [])
        self.assertEqual(len(errors), 1)
        self.assertIn("JSON", errors[0]["reason"])

    def test_non_object_arguments(self):
        ops, errors = parse_tool_calls([_call("delete_node", "[1,2]")])
        self.assertEqual(ops, [])
        self.assertEqual(errors[0]["reason"], "工具 delete_node 的参数必须是对象")

    def test_missing_required_arguments(self):
        ops, errors = parse_tool_calls([_call("delete_node", '{"node_id": "A"}')])
        self.assertEqual(ops, [])
        self.assertEqual(errors[0]["reason"], "工具 delete_node 缺少必填参数")

    def test_dict_arguments_accepted(self):
        # 09-20 修复：部分网关把 arguments 直接给成对象，不能再抛 TypeError
        ops, errors = parse_tool_calls([_call("delete_node", {"node_id": "A", "reason": "冗余"})])
        self.assertEqual(errors, [])
        self.assertEqual(ops, [{"op": "delete_node", "id": "A", "reason": "冗余"}])


class ParseToolCallsConversionsTest(unittest.TestCase):
    def test_create_node_full(self):
        args = ('{"temp_id":"t1","kind":"knowledge","label":"牛顿第二定律",'
                '"content":"F=ma","formula":"F=ma","reason":"补充核心定律"}')
        ops, errors = parse_tool_calls([_call("create_node", args)])
        self.assertEqual(errors, [])
        self.assertEqual(ops[0]["op"], "create_node")
        self.assertEqual(ops[0]["temp_id"], "t1")
        self.assertEqual(ops[0]["content"], "F=ma")

    def test_update_node_accepts_id_alias(self):
        args = '{"id":"A","patch":{"label":"新名","bogus":"丢弃"},"reason":"改名"}'
        ops, errors = parse_tool_calls([_call("update_node", args)])
        self.assertEqual(errors, [])
        self.assertEqual(ops[0]["id"], "A")
        self.assertEqual(ops[0]["patch"], {"label": "新名"})

    def test_add_edge_ports_mapping(self):
        args = '{"from":"A","to":"B","relation":"依赖","from_port":"out-1","to_port":"in-0","reason":"连接"}'
        ops, errors = parse_tool_calls([_call("add_edge", args)])
        self.assertEqual(errors, [])
        self.assertEqual(ops[0]["fromPort"], "out-1")
        self.assertEqual(ops[0]["toPort"], "in-0")

    def test_eval_node_target_alias_and_priority(self):
        args = '{"temp_id":"e1","target":"A","suggestion":"补公式","priority":"高","reason":"评审"}'
        ops, errors = parse_tool_calls([_call("create_eval_node", args)])
        self.assertEqual(errors, [])
        self.assertEqual(ops[0]["target_node_id"], "A")
        self.assertNotIn("priority", ops[0])  # 非法档位丢弃

        ok = parse_tool_calls([_call("create_eval_node", args.replace('"高"', '"high"'))])[0]
        self.assertEqual(ok[0]["priority"], "high")

    def test_remove_edge_by_key(self):
        args = '{"edge_key":"A:out-0->B:in-0","reason":"断开"}'
        ops, errors = parse_tool_calls([_call("remove_edge", args)])
        self.assertEqual(errors, [])
        self.assertEqual(ops[0]["edge_key"], "A:out-0->B:in-0")

    def test_tool_to_op_covers_all_phase_tools(self):
        for names in PHASE_TOOLS.values():
            for name in names:
                self.assertIn(name, TOOL_TO_OP)


if __name__ == "__main__":
    unittest.main()
