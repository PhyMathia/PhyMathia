# Graph Harness

独立的图编辑 harness。它只负责：

- 把知识网络快照发给模型。
- 让模型返回受控的图操作。
- 校验操作合法性。
- 计算修改后的快照和 diff。

它不依赖 PhyMathia 的 UI 状态，也不直接保存或渲染节点图。

## API

### POST /api/harness/graph/review

```json
{
  "snapshot": {
    "nodes": [
      {"id": "A", "kind": "knowledge", "label": "导数", "content": "", "formula": ""}
    ],
    "edges": []
  },
  "instruction": "补全缺失概念并纠正错误连线",
  "model": {
    "provider": "deepseek",
    "api_key": "",
    "model": "deepseek-chat",
    "base_url": "https://api.deepseek.com"
  }
}
```

响应包含 `summary`、`operations`、`next_snapshot`、`diff` 和 `errors`。

### POST /api/harness/graph/apply

纯函数接口，不调用模型。输入 `snapshot` 和 `operations`，返回校验后的 `next_snapshot` 与 `diff`。

## 操作类型

- `create_node`
- `update_node`
- `delete_node`
- `add_edge`
- `remove_edge`
- `update_edge`

每个操作都必须有 `reason`。新节点只接受 `temp_id`，最终 ID 由 harness 分配。模型不能输出坐标。
