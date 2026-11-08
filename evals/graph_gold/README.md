# 改图金样集 —— Φ 改图模式的「质量尺子」

## 这是什么

Φ 助手的「改图模式」是你说一句自然语言（例如「把导数节点的公式改成 F=ma」），
模型给出一串改图操作，前端预览后应用到探索网画布上。以前只有两类检查：

- `scripts/harness_battery.mjs`：检查模型吐出来的「操作清单」**形状**对不对；
- `evals/`：检查主聊天的**问答**质量。

两者都没回答最要紧的问题：**改完之后，那张图到底变成我说的样子了吗？**
一串操作可能条条合法，但合起来改错了节点、漏了连线、或者顺手动了不该动的节点——
旧检查全绿，用户看到的却是错的。

这套「金样集」补的正是这一环：30 道固定的「指令 → 期望结果图」题目，跑完直接对
**结果图**打分，并告诉你错在哪一类。

一句话用途：

- 你改了 Φ 的提示词、换了模型、动了改图校验规则 → 跑一遍，分数掉没掉一眼看出；
- 想知道模型「到底听没听懂」→ 看四桶归因，不用自己翻日志。

## 三分钟上手

本机需要有 `node`、`python3`、`curl`（项目本来就在用）。

```bash
# 1. 先确认尺子本身没坏（纯本地，秒级，零服务）
node evals/graph_gold/run.mjs --selftest
#    → 评分器自检：47/47 通过

# 2. 跑一遍全套（自带假模型 + 隔离出来的临时服务，不碰你日常的数据、不花钱）
node evals/graph_gold/run.mjs --mock
#    → 改图金样集：30/30（100.0%）

# 3. 证明这把尺子真的能分辨好坏（每 2 题故意注入一次坏答案）
node evals/graph_gold/run.mjs --mock --degrade 2
#    → 改图金样集：17/30（56.7%），与基线对比：退步 13
```

第 3 步分数应该明显变红；再跑一次第 2 步应该回到 30/30。
**「好状态满分 → 故意变差就掉分 → 恢复又满分」这三步走通，尺子才算装好。**

报告自动写到 `evals/reports/graph-gold-<时间>.md`（人读）和 `.json`（机器读），
每次 run 都会打印路径；该目录已被 `.gitignore` 忽略，不会进版本库。

## 怎么读报告

报告有四块：总分、四桶失败归因、按题目类别、逐条明细。

「四桶」是给失败分类的，优先级从高到低：

| 桶 | 含义 | 典型原因 |
|---|---|---|
| 协议丢字段 | 回包缺 `operations` / `next_snapshot` | 模型没按格式回、发送失败 |
| 范围过大 | 动了不该动的节点 | 让它只改一个，它顺手改了三个 |
| 动作选错 | 该加连线却删了节点 | 操作类型选错 |
| 目标选错 | 改了别的节点 | 把「导数」当成了「极限」 |

每条失败只归到**优先级最高的那一桶**，方便先看最要紧的问题。

## 常见工作流

### A. 改提示词 / 换模型前后对比（真机，会花模型调用）

```bash
# 改动前：跑一次并留标签
node evals/graph_gold/run.mjs --server --model-file my-model.json --label before

# 改完 harness/prompts.py，按 AGENTS.md 重启服务后再跑一次
node evals/graph_gold/run.mjs --server --model-file my-model.json --label after

# 不跑评测，直接对比两次
node evals/graph_gold/run.mjs --compare before after
```

`my-model.json` 的内容是
`{"provider":"deepseek","api_key":"...","model":"...","base_url":"..."}`。
脚本**不会**自己读你账号里的模型配置，必须显式给这个文件，避免误用或误烧调用。

### B. 把当前好状态存成基线

```bash
node evals/graph_gold/run.mjs --mock --save-baseline
# 真机同理，但先确认分数真的是改善了再覆盖基线
```

基线存在 `evals/graph_gold/baseline.json`。存了以后每次 run 会自动列出
「退步题 / 进步题」；**有基线且出现退步时命令返回非零**，可以接进回归闸门。
降级自检轮（`--degrade`）不会拦，因为它本来就该红。

### C. 只跑几题调试

```bash
node evals/graph_gold/run.mjs --mock --only gg-021,gg-030
```

### D. 完整参数

```bash
node evals/graph_gold/run.mjs --help
```

## 加新题目

题库是 `cases.jsonl`，一行一道题（`#` 开头是注释）。字段：

| 字段 | 说明 |
|---|---|
| `id` | 唯一编号，如 `gg-031` |
| `graph` | 起始图夹具：`G1` / `G2` / `G3`（见 `scripts/harness_graphs.mjs`） |
| `bucket` | 题目类别，用于报告分组：update/delete/edge/create/chat/scope/evaluate/expand/cross/compound |
| `instruction` | 用户说的那句话 |
| `focus` | 聚焦的节点 id 列表（可空） |
| `mock_ops` | **必填**：假模型应当回放的正确工具调用；空数组表示「不该改图」 |
| `expect` | 期望的结果图断言 |
| `phase` / `level` | 可选，默认 `normal` / `university` |

`expect` 支持的断言（实现见 `grader.mjs`）：
`status` / `field_equals` / `field_contains` / `field_unchanged` / `node_exists` /
`node_absent` / `edge_exists` / `edge_absent` / `edge_relation_equals` / `edge_count` /
`node_connected` / `scope_allow` / `op_types` / `ops_count`。

**加题三条纪律**：

1. 一定要写 `mock_ops`，否则 `--mock` 建不起满分基线；
2. 断言尽量写「结果图」（改完该是什么样），别只写「操作是什么样」——那正是本集要补的空白；
3. 加完先跑 `--selftest`（若改了评分器）再跑 `--mock`，最后跑一次 `--degrade 2` 确认新题也能被判错。

## 安全与边界

- **绝不连你日常的服务**：脚本默认自己起一个「临时数据目录第二实例」（端口 5090）
  和一个专用假模型（5091），真实 `data/` 零写入；`--base-url` 指向 5050/5051 会直接拒跑。
- **不并进 `npm run verify`**：真机模式每次要跑 30 次模型往返，太贵；只在改了改图相关代码时手动跑。
- **测什么、不测什么**：测「主模型出方案 → 结果图」这一段，运行时把质检器关掉
  （`self_check: 'off'`），不把质检器的能力混进这把尺子；也不测前端预览 / 勾选 / 撤销的交互。
- 技术细节、环境踩坑与端口表见 `docs/dev/graph-gold.md`。
