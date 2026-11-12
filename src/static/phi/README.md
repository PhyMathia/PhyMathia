# Φ（Phi）桌宠

Φ 是 PhyMathia 的桌面宠物，也是 Φ 网络助手（harness）的化身。

## 命名规范
- 目录：`src/static/phi/`（由 FastAPI 静态服务托管）
- CSS 类：`.phi-*`（`.phi-pet` / `.phi-character` / `.phi-body` / `.phi-eyes` …）
- data 属性：`data-phi-pet` / `data-phi-mode`
- JS API：`window.PhiPet.init(root)` / `window.PhiPet.setMode(root, mode)`
- 主体图形：`harness.js` 内联 SVG（7 个部件：body / hand-left / hand-right / eyes / lamp-on / lamp-off / eyes-x），配色由本目录 `phi-pet.css` 的 `--phi-*` 变量控制，不再依赖 PNG 素材。

## 配色
- 深色：深蓝主体 `#1d4ed8` + 高光 `#60a5fa` + 浅蓝半透明描边 `rgba(147,197,253,.85)`；
- 浅色：暖橘主体 `#ea580c` + 浅橙描边 `#fdba74`；灯亮更亮（嫩黄 `#fef08a` + 柔光），灯灭浅蓝（`#93c5fd` / `#60a5fa`）。
- 深色沿用 2026-08 朋友修改版配色（仅调色，像素形状未变）。

## 主题渐变
- 配色变量通过 `@property` 注册 + `.phi-pet` 变量级 `0.35s ease` 过渡，接入全局主题切换系统（`applyTheme` 切 `data-theme` 时，桌宠颜色平滑渐变，与页面其他元素同步）。

## 四状态
`idle`（待机）/ `working`（工作，显示敲击键盘）/ `celebrate`（庆祝）/ `error`（报错）

待机动效分三层（2026-11-11 灵动化）：
- **常驻层**：整只漂浮 4.6s、身体起伏 3.2s、左右手 3.9s/4.3s、头顶灯 4.9s——周期刻意错开，不再「整只同时呼吸」；
- **视线层**：鼠标进入约 560px 就看向鼠标（位移落在椭圆上，横向 ≈2.6px、纵向 ≈1.8px，随字号缩放）；鼠标不动时每 1.5–4.9s 随机扫视一次；
- **微行为层**：每 4–12s 随机歪头 / 蹦一下 / 招手 / 连眨两下（`is-tilting` / `is-hopping` / `is-waving` / `is-double-blink`）。

交互反应：悬停轻跳（`is-perking`）、点击压扁＋弯眼（`is-poked`）、拖拽时按方向倾斜＋松手落地压一下（`is-dragging` / `is-landing`）。另有落地投影 `.phi-shadow`（随漂浮高度缩放变淡）。
眼睛拆成两层：外层 `.phi-eyes-wrap` 只负责视线位移（消费 `--phi-gaze-x/y`），内层 `.phi-eyes` 保留眨眼/眯眼；外层与投影由 `phi-pet.js` 在 `init()` 时插入，不改 `harness.js` 的内联 SVG 模板。
`prefers-reduced-motion: reduce` 下上述微行为/视线全部关闭，只留静态姿态。

## 与 harness 的绑定（harness.js）
- `.phi-pet-root` 常驻右下角，点击开关 harness 窗口、可拖拽；
- 审阅/解析/生成中（busy 或 status=running）→ `working`；
- 应用/保留/撤销成功 → `celebrate`（2.6s 后回落）；
- 失败/图太大 → `error`（持续到下次操作）；
- harness 窗口打开 → `active` 高亮。

## 分享/预览文件
- `phi-share-dark.svg` / `phi-share-light.svg`：独立 SVG（深/浅色各一版），浏览器打开即可看；
- `phi-share-dark.png` / `phi-share-light.png`：同款 PNG，聊天里直接发图用；
- `phi-preview.html`：自包含预览页（内嵌全部 CSS/JS），可切换主题与 idle/working/celebrate/error 状态。
  **改了 `phi-pet.css` / `phi-pet.js` 后跑一次 `node scripts/sync_phi_preview.mjs`** 把两份内联副本刷成与源文件逐字一致（不跑就会出现「预览是新的、真机是旧的」）。
