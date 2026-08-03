# PhyMathia 项目文档

## 1. 项目简介

PhyMathia 是一个基于 Web 的物理数学 AI 助手，用聊天方式同时从「物理直觉」和「数学本质」解释问题，并生成交互式 HTML 可视化。

核心能力：

- 双域解释：同一问题同时输出物理直觉、数学本质、知识图谱和延伸思考
- 思维导图画布：默认以可拖拽/缩放/平移的探索网呈现问答与模块气泡
- 交互式可视化：AI 生成独立 HTML 演示，前端以 sandbox iframe 展示
- 多会话管理：创建、切换、删除会话，本地与服务端 JSON 同步
- 难度等级：初高中、大学、科研三档
- 知识总览：自动提取知识点与公式，支持收藏、搜索、按会话定位
- 苏格拉底追问：延伸思考以支线形式展开，不污染普通问答上下文
- 主题切换：深色/浅色模式，可视化 iframe 同步主题

## 2. 技术栈

- 后端：Python + FastAPI + Uvicorn
- AI 代理：httpx，OpenAI 兼容接口，支持 DeepSeek、OpenAI、自定义 Base URL
- 前端：原生 HTML/CSS/JavaScript，无构建步骤
- 前端库：KaTeX、Marked、Mermaid、DOMPurify，通过 CDN 加载
- 数据：本地 JSON 文件，无数据库依赖
- 离线模式：内置 mock SSE 流，可在无 API Key 时测试前端

## 3. 目录结构

```text
D:\PhyMathia前端\
├── AGENTS.md              # Agent 开发说明
├── DESIGN.md              # 视觉设计说明
├── requirements.txt
├── data/                  # 服务运行数据
│   ├── sessions.json
│   ├── knowledge.json
│   ├── formulas.json
│   ├── kv_store.json
│   └── messages/{sid}.json
└── src/
    ├── main.py            # FastAPI 后端，含 mock、代理、提取、去重
    ├── system prompt.md   # AI 系统提示词
    ├── PROJECT.md         # 本文档
    └── static/
        ├── index.html
        ├── css/styles.css
        └── js/
            ├── config.js      # 常量与 localStorage key
            ├── session.js     # 会话/同步/消息恢复
            ├── render.js      # Markdown/KaTeX/Mermaid/可视化渲染
            ├── chat.js        # 对话、流式接收、苏格拉底回答
            ├── knowledge.js   # 知识面板、公式库、去重
            ├── models.js      # 模型配置
            └── ui.js          # 主题、粒子、引导
```

## 4. 核心数据流

### 4.1 完整探索

用户提问后，后端构建：

```text
system prompt
+ 最近会话上下文
+ 当前用户消息 + 难度后缀
```

模型按约定输出 `<physics>`、`<math>`、`<graph>`、`<extend>` 和 `<summary>`。前端解析 XML 区块，渲染成可折叠学习卡片。

### 4.2 苏格拉底追问支线

延伸思考中的问题会渲染为两个入口：

- `我来回答`：打开专用小输入框，提交后组装 `[苏格拉底回答]` 消息
- `直接问AI`：把问题当作普通提问发送

苏格拉底消息会带 `branch: "socratic"` 标记。后端加载上下文时：

- 普通问答：过滤 `branch="socratic"` 消息，只保留主线
- 苏格拉底支线：主线 + 支线一起提供给模型

兼容旧数据：消息以 `[苏格拉底回答]` 或 `我的回答：` 开头，或包含 `<socratic_meta>` 且不是完整学习卡片时，也会被识别为苏格拉底支线。

苏格拉底状态保存在 KV：

```text
socratic:{session_id}
```

字段：

```json
{
  "active": true,
  "level": "basic",
  "question": "当前追问问题",
  "correctStreak": 0,
  "answeredCount": 0,
  "updatedAt": 0
}
```

模型在苏格拉底后续回复中输出隐藏标签：

```html
<socratic_meta correct="correct|partial|wrong" done="true|false" />
```

后端根据该标签更新答对次数；答对 2 次或 `done=true` 后结束支线并删除状态。

### 4.3 会话上下文

`_load_session_context(session_id, max_rounds=3, include_socratic=False)` 从最新消息往回保留最近 3 轮用户消息，以及这些用户消息之间的 AI 回复。

`session_id` 有两种形式：

- 本地会话 key：如 `sess_xxx`
- 服务端 sessionId：如 `phymathia_xxx`

后端会通过 `_resolve_messages_path` 在 `sessions.json` 中反查，确保两种标识都能找到消息文件。

### 4.4 公式与知识提取

完整学习卡片中的 `<formula>LaTeX</formula>` 会被收集：

1. 前端本地先提取并展示
2. 异步调用 `POST /api/extract_knowledge`
3. 后端优先提取 `<formula>`，无标签时回退 `$...$`、`\(...\)`
4. 标准化后过滤单字符、纯命令、纯单位
5. 配置 descriptor 模型时，为公式生成说明

前端渲染 `<formula>` 时兼容两种写法：

```text
<formula>F=-kx</formula>
$$<formula>F=-kx</formula>$$
```

后者会先去掉外层 `$`/`$$`，避免生成 `$$$$...$$$$` 导致 KaTeX 失败。

### 4.5 知识去重

- 知识点：同一会话内按规范化标题精确合并，保留摘要更长、公式更全、时间更新的条目
- 公式：同一会话内按 `sessionId + formula key` 去重
- 苏格拉底追问轮次不会自动生成知识条目或公式

### 4.6 探索网分支

AI 完整回答渲染为“回答簇”：核心摘要节点 + 物理、数学、知识图谱、交互可视化、延伸思考模块气泡。
用户可以从任意气泡发起分支：

- `followup`：对当前气泡继续追问
- `confused`：没看懂当前气泡，要求换一种方式重讲
- `socratic`：回答延伸思考中的苏格拉底问题
- `learn`：选择进阶学习方向，生成新的完整探索回答簇
- `continue`：在当前气泡上自由续问，问题无关时可切回新主线

分支消息记录 `branchType / branchId / parentId / sourceModule / branchLabel`。
后端上下文加载优先使用分支链 + 父回答聚焦模块，普通问答继续过滤苏格拉底支线。
苏格拉底状态从会话级改为分支级，键为 `socratic:{branch_id}`。
模块气泡的折叠/隐藏状态按 `messageId + module` 保存在 `phymathia_graph_{sid}`。

## 5. 数据契约

### 会话

```json
{
  "id": "sess_xxx",
  "title": "会话标题",
  "icon": "wave",
  "sessionId": "phymathia_xxx",
  "createdAt": 0,
  "updatedAt": 0
}
```

### 消息

```json
{
  "role": "user",
  "content": "消息内容",
  "timestamp": 0,
  "branch": "socratic",
  "branchType": "followup|confused|socratic|learn|continue",
  "branchId": "br_sess_xxx_abc",
  "parentId": "1710000000000",
  "sourceModule": "physics|math|graph|viz|extend",
  "branchLabel": "追问：物理视角"
}
```

`branch` 为苏格拉底兼容字段；普通主线消息没有这些字段。

### 知识点

```json
{
  "id": "ki_xxx",
  "title": "知识点名称",
  "category": "physics|math|other",
  "tags": ["物理"],
  "summary": "摘要",
  "formulas": ["$F=-kx$"],
  "source": "ai_extract|manual",
  "sessionId": "sess_xxx",
  "messageId": "0",
  "createdAt": 0
}
```

### 公式

```json
{
  "id": "f_xxx",
  "latex": "$F=-kx$",
  "concept": "胡克定律",
  "meaning": "说明",
  "topic": "",
  "related": ["物理"],
  "sessionId": "sess_xxx",
  "createdAt": 0
}
```

## 6. API

| 接口 | 方法 | 说明 |
|---|---|---|
| `/` | GET | 首页 |
| `/chat` | GET | 聊天页 |
| `/health` | GET | 健康检查 |
| `/v1/chat/completions` | POST | OpenAI 兼容 mock |
| `/stream_run` | POST | 内部 mock SSE |
| `/api/models/chat` | POST | AI 模型代理 |
| `/api/sessions` | GET/POST/DELETE | 会话读写/清空全部 |
| `/api/sessions/{id}` | PUT/DELETE | 更新/删除会话 |
| `/api/sessions/{id}/messages` | GET/POST/DELETE | 消息读写/清空 |
| `/api/knowledge` | GET/POST | 知识点读取/写入 |
| `/api/knowledge/{item_id}` | DELETE | 删除知识点 |
| `/api/formulas` | GET/POST/DELETE | 公式读取/写入/按会话删除 |
| `/api/formulas/{formula_id}` | DELETE | 删除公式 |
| `/api/extract_knowledge` | POST | 知识提取 + 公式入库 |
| `/api/kv/{key}` | GET/POST/DELETE | 键值存储 |

## 7. 模型槽位

- `agent`：主模型，负责对话与知识提取
- `html`：可选，负责补充生成交互式 HTML
- `descriptor`：可选，负责为公式生成简短说明

模型配置保存在 localStorage，通过 `/api/models/chat` 转发请求。

## 8. 前端模块

前端为原生 JS 顶层脚本，全局函数和 `window.*` 暴露均可用于模块间调用。

关键全局入口：

- `sendQuick(text)`
- `startSocraticAnswer(question, level)`
- `submitSocraticAnswer()`
- `switchToSession(id)`
- `getSessionById(id)`
- `invalidateKnowledgeCache()`
- `syncFromServer()`

localStorage key：

```text
phymathia_sessions
phymathia_current_session
phymathia_level
phymathia_knowledge
phymathia_formulas
phymathia_msgs_{sid}
phymathia_theme
phymathia_user_models
phymathia_active_models
phymathia_graph_{sid}
phymathia_onboarding_done
```

## 9. 开发与测试

启动服务：

```bash
cd D:\PhyMathia前端
python src/main.py -p 5000
```

服务不带 `--reload`。修改 `main.py` 或 `system prompt.md` 后需要重启；修改 `static/**` 后需要硬刷新浏览器。

健康检查：

```bash
curl http://localhost:5000/health
```

知识提取：

```bash
curl -X POST http://localhost:5000/api/extract_knowledge \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role":"user","content":"解释简谐运动"}], "sessionId":"test"}'
```

常用验证：

- `python -m py_compile src/main.py`
- `node --check src/static/js/*.js`
- 打开知识面板确认知识点和公式数量
- 点击苏格拉底追问「我来回答」，确认专用输入框打开并进入支线

## 10. 常见问题

### 公式没有渲染

检查公式是否被外层 `$` 重复包裹。当前渲染层已兼容 `$$<formula>...</formula>$$`，如仍失败，优先确认 KaTeX CDN 是否可访问。

### 知识总览为空

完整学习卡片才会自动入库。苏格拉底追问轮次被设计为不写入知识总览。

### 普通问答还能看到苏格拉底支线

确认消息带 `branch: "socratic"`，或后端能通过内容识别旧苏格拉底消息。新版普通问答上下文会过滤支线。

### 改了代码没有效果

前端需要硬刷新；后端 `main.py` 与 `system prompt.md` 需要重启服务。
