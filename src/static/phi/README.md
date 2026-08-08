# Φ（Phi）桌宠

Φ 是 PhyMathia 的桌面宠物，也是 AI 网络助手（harness）的化身。

## 命名规范
- 目录：`src/static/phi/`（由 FastAPI 静态服务托管）
- CSS 类：`.phi-*`（`.phi-pet` / `.phi-character` / `.phi-body` / `.phi-eyes` …）
- data 属性：`data-phi-pet` / `data-phi-mode`
- JS API：`window.PhiPet.init(root)` / `window.PhiPet.setMode(root, mode)`
- 素材：英文小写连字符（`phi/body.png`、`phi/hand-right.png`、`phi/eyes/eyes-normal.png`、`phi/lamp/lamp-on.png` …）

## 四状态
`idle`（待机）/ `working`（工作）/ `celebrate`（庆祝）/ `error`（报错）

## 与 harness 的绑定（harness.js）
- `.phi-pet-root` 常驻右下角，点击开关 harness 窗口、可拖拽；
- 审阅/解析/生成中（busy 或 status=running）→ `working`；
- 应用/保留/撤销成功 → `celebrate`（2.6s 后回落）；
- 失败/图太大 → `error`（持续到下次操作）；
- harness 窗口打开 → `active` 高亮。

## 独立预览
原始通用版仍在 `D:\PhyMathia\桌宠\`（未改动），可直接打开 `index.html` 预览。
