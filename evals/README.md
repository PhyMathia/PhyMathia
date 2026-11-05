# PhyMathia 物理数学评测集

给「改提示词 / 换模型 / 改发送链」提供可回归的质量标准：同一套题反复跑、同一把尺子评分，把「体感变好/变差」变成数字。本目录自包含（题库＋评分器＋判卷器＋运行器＋报告）；口径、踩坑与路线图见 `docs/dev/eval-harness.md`。

## 目录

| 文件 | 说明 |
|---|---|
| `questions/*.jsonl` | 题库 200 题：按域 5 个文件（高数/线代/概率/力学/电磁各 40） |
| `graders.py` | 规则评分器（被 run_eval.py 调用） |
| `judge.py` | model-judge 语义判卷（`--judge` 开启；五维度＋磁盘缓存） |
| `run_eval.py` | 运行器 CLI |
| `check_questions.py` | 题库红线检查器（写题/改题必跑；`--two-way --verify --final`） |
| `reports/` | 评测报告与判卷缓存（已 gitignore，不入库） |

## 跑法

```bash
python3 evals/run_eval.py --selftest        # 评分器自检（不联网）
python3 evals/run_eval.py --adapter mock    # 离线演示：假学生作答，验证管道与报告
python3 evals/run_eval.py --adapter mock --only calculus,mechanics   # 按域/按 id 过滤

python3 evals/check_questions.py --two-way --verify --final  # 题库红线全检

# 真机（工作流 direct 通道，模型三来源任选其一）：
python3 evals/run_eval.py --adapter server                       # ①服务端已配 agent 槽
python3 evals/run_eval.py --adapter server --model deepseek-chat # ②按 id/模型名直取（A/B 用）
python3 evals/run_eval.py --adapter server \                     # ③手动直连（mock 上游口径）
    --provider opencode-go --model-name mock-1 --api-key mock \
    --upstream-base-url http://127.0.0.1:5065/v1
```

真机口径与验收记录见手册「接入真机」节；题库结构、verify 红线与抽查方法见「题库 v1」节（docs/dev/eval-harness.md）。

## 题目 schema（每行一个 JSON）

| 字段 | 说明 |
|---|---|
| `id` | 全局唯一，`<域缩写>-<三位序号>` |
| `domain` | calculus / linear_algebra / probability / mechanics / electromagnetism |
| `kind` | solve（求解）/ error_catch（判断给定解法或说法的破绽）/ concept（幻觉概念探针，前提是错的，正确行为是纠正） |
| `difficulty` | basic / medium / hard |
| `topic` | 考点一句话 |
| `question` | 题干（error_catch/concept 的题干内嵌待判断的解法/说法） |
| `expected_answer` | 标准答案；symbolic 题该列表同时是 accept 匹配串 |
| `answer_check` | `{type:"numeric", value, tol, alt_values?}`（一组答案用 `mode:"all"`＋`values`）或 `{type:"symbolic"}`；缺省不评 |
| `solution_path` | 解法路径（参考答案的叙述） |
| `key_steps` | 关键步骤数组，每步 `point`＋`evidence`（作答需命中的证据 token，任一即可） |
| `common_errors` | 常见错误数组：`wrong`（用于复述警示的式子/说法）＋`desc` |
| `notes` | 出题备注（可省） |

## 评分维度（v0 口径）

- **final_answer**：数值题从作答原文抽取数字（裸数字、`a/b`、`\frac{a}{b}` 求值）与标准值比容差；符号题把作答与 accept 串都规范化后做子串匹配。
- **key_steps**：每步 evidence 任一 token 在规范化作答文本中命中；全部命中才 pass（部分命中标 partial）。
- **error_catch / concept**：这两类题的 gate 就是 key_steps（题目把「必须指出的点」写进步骤），全命中才算 caught / corrected。
- **known_wrong_echo**：作答复述了 `common_errors.wrong` 里的典型错误式子——**仅警示，不参与判分**（模型可能是在对比提醒，如 prob-002 的 0.95 在贝叶斯分母里合法出现）。
- 幻觉概念扫描、自相矛盾检测：v0 未接入（需 model-judge，见路线图）。

## v0 已知限制（别拿它当真判官）

- 数值题默认「任一数字命中即算对」：题干数字会在作答回显中造成假阳性；答案含多个数时用 `mode:"all"` 并保证数值不出现在题干（la-004 / mech-004 是范例）。
- evidence / accept 是规范化后的子串匹配：措辞差异会漏判（假阴性）；上标 `²` 与 `^2` 是两种文本，两变体都要写。
- mock 适配器是「演示管道」的假学生（每 3 题故意答错 1 题），不代表任何模型水平。

## 路线图

1. server 适配器接工作流首问通道（配 mock 上游 5065 验证，遵守 AGENTS.md 硬规则 6）。
2. model-judge 维度：幻觉概念、自相矛盾、中间推导语义完整性。
3. 题量 20 → 200+；按域拆分 JSONL；报告加「与上次 run 的基线 diff」。
4. 错误解法覆盖（error_catch + concept）占比不低于 1/3，持续扩充。
