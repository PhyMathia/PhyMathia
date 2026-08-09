# Φ（Phi）桌宠

Φ 是 PhyMathia 的桌面宠物，也是 AI 网络助手（harness）的化身。

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

待机时随机眨眼，并会随机轻微看向 8 个方向（上/下/左/右 + 4 个斜向，斜向位移落在椭圆轨迹上，非 x+y 简单叠加；位移后随机停留 0.4~1.2s）；小手随呼吸（3.2s 同频）轻微摆动。

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
