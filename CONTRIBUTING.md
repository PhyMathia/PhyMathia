# 参与 PhyMathia 开发

这份文档写给要动手改代码的人，只放每个改动都适用的通则。各领域的设计手册
正在整理中，将在下个版本随仓库发布。

## 硬规则

1. **启动**：`python3 src/main.py -p 5050`（Windows 上若提示找不到命令，改用 `python`）。
   服务**不带 `--reload`**，改完 `src/main.py` 或 `src/system prompt.md` 要杀掉旧进程重启。
   冒烟：`curl -s localhost:5050/health`。
2. **前端是打包产物**：页面只加载 `/js/app.js`。改 `src/static/js/*.js` 后
   `npm install && npm run build:js` 再刷新页面（服务端已发 no-cache + ETag，普通刷新即得新 JS，
   硬刷新兜底）；只改查看器子集（`viewer-*.js` 及其 entries）另跑 `npm run build:viewer`。
   **改 CSS 或 `/phi/phi-pet.*` 后同样要跑一次 `npm run build:js`**——页面实际加载的是构建压出的
   `*.min.css`（`index.html` / `viewer.html` 的链接由构建改写指向 min 版），源 CSS 的注释是设计文档，
   **绝不原地压缩**；`?v=` 缓存版本号由构建按压缩产物内容哈希自动刷新。
   `app.js` / `viewer.js` / `*.min.css` 都是产物，**不要手改**；
   `scripts/build_frontend.mjs` 里的文件顺序 = 脚本加载顺序，改组必改它。
3. **localStorage 键统一 `phymathia_` 前缀**（常量集中在 `config.js`）。带会话后缀的键
   （`msgs_` / `graph_` / `graph_history_` / `harness_history_` + sid）按会话隔离，切会话时别混用。
   前端是原生 JS 顶层脚本，全局函数与 `window.*` 跨模块可调；写共享工具前先看 `utils.js` 里有没有。
4. **拆通道 / 删入口 / 改发送链的改动，收尾必须真发一次**：在配置了可用模型（mock 上游也行）的状态下，
   把每条幸存通道都真跑通并逐条记录——工作流首问、节点追问、没看懂、苏格拉底回答、进阶支线、重试。
   静态检查全绿不等于真机能发，回归沙箱没配模型是走不到发送段的。

## 验证

```bash
python3 -m pytest tests/ -q          # 后端单测
node scripts/frontend_smoke.mjs      # 前端冒烟（需先 npm install）
```

**基线数字以最近一次全量实跑为准，勿照抄旧值。**

下面是隔离回归脚本，改到对应领域时一起跑：

| 脚本 | 覆盖 |
|---|---|
| `scripts/review_stage0_frontend.mjs` | 冻结契约（改预期前先确认契约意图） |
| `scripts/review_stage1_clear.mjs` | 清空画布 |
| `scripts/review_stage1_undo.mjs` | 撤销 |
| `scripts/review_stage2_frontend.mjs` | 阶段 2 交互 |
| `scripts/review_f3b_frontend.mjs` | Φ 改图的应用判定 |
| `scripts/review_badge_frontend.mjs` | 画像角标快照 |
| `scripts/review_tasks_frontend.mjs` / `review_tasks_e2e.mjs` | 任务列表 |
| `scripts/review_viewer_readonly.mjs` | 查看器只读模式 |
| `scripts/continent_regression.mjs` | 知识大陆 |

性能数字用 `python3 scripts/perf_profile_baseline.py` 现测。

给 `frontend_smoke.mjs` 加用例时，共享 localStorage 键且会 `await` 的用例必须放在文件末尾的
「串行边界」段，否则会与在途的异步用例互踩。改完跑全量再收尾。

## 结构速览

- `harness/` Φ 助手后端 Python 包，路由挂 `/api/harness`。**它有自己的 `prompts.py`，
  与 `src/server/prompts.py` 是两份，别改混。**
- `src/server/` 后端模块包；`src/static/js/` 前端模块；`src/static/vendor/` 是
  KaTeX / Marked / Mermaid / DOMPurify 的本地副本（零 CDN 依赖，别换成线上引用）。
- `data/` 运行时 JSON（服务首次启动自动创建：`sessions/`、`knowledge/`、`formulas/`、
  `kv_store/`、`messages/` 等），已在 `.gitignore` 里。
- `scripts/` 构建与测试；`tests/` 后端单测。

## 常见问题

- **公式速查没内容？** 公式由对话自动收集（AI 输出 `<formula>` 标签）。旧库脏数据
  （单字符 / 无效 LaTeX）会被过滤不显示。
- **改难度等级？** `LEVEL_PROMPTS` 在 `src/server/config.py`，改后重启。
- **搜索前端代码时注意**：`app.js` / `viewer.js` / `*.min.css` 是压缩产物，
  `grep` 搜它们会刷出海量无关输出，记得排除。
