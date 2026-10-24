# 《一个问题的两种语言》· 科幻版 · Remotion 实现说明

> 成片：`remotion/out/PhyMathia-80s-1080p.mp4` · 80 秒 · 1920×1080 · 30 fps · 有配乐
> 依据：`09-剧本v5-一个问题的两种语言.md`（叙事与文案），按「科幻风格 / 节奏感强」重做视觉与剪辑
> 每一帧画面、每一个音符都由代码生成，无素材、无录屏、无采样

---

## 一、这一版和剧本 v5 的关系

剧本 v5 是 96 秒、一个连续长镜头、克制安静的写法。这一版把同一套叙事压到 **80 秒**，换成科幻界面语言与节拍剪辑：

| | 剧本 v5 | 本版 |
|---|---|---|
| 时长 | 96 s / 2880 帧 | **80 s / 2400 帧** |
| 节奏 | 一个长镜头推拉 | **7 个段落硬切 + 120 BPM 节拍网格** |
| 视觉 | 极简、留白、暗场 | **HUD、扫描线、透视网格、霓虹辉光、色差、颗粒** |
| 音乐 | 另一套音效设计 | **程序生成的 120 BPM 原创配乐**（D 小调，8 小节循环） |
| 文案 | C01–C19 共 19 句 | **13 句**（按 80 秒重排，保留原句） |

**没有改的**：那道题（为什么一个音，听起来是一个音？）、开场那个行列式（`det A = ad − bc`）、双域逐帧对齐（同一个 `n` 在两边同时亮）、卡片→邻居→大陆、Φ 拖一张卡连一半、回到最初那张卡。

---

## 二、时间线（帧号即事实）

120 BPM ⇒ 1 拍 = 15 帧，1 小节 = 60 帧。所有切换都落在小节线上。

| 段 | 帧 | 秒 | 画面 | 节拍动作 |
|---|---|---|---|---|
| ① SIGNAL | 0–300 | 0–10 | `det A = ad − bc` 从乱码里逐字锁定，扫光掠过，随即炸成粒子；网格地平线升起 | 0 帧重击；每 2 拍一次扫描 |
| ② PROTOCOL | 300–540 | 10–18 | 启动日志逐行打印，问题逐字打入，输入条上的声压条跟着光标走 | 每字一次脉冲 |
| ③ DUAL DOMAIN | 540–1020 | 18–34 | 左：8 条驻波逐条亮起，合成弦随之变形；右：8 根振幅条 `aₙ = 1/n`；中间一条数据总线 | **每 1 秒点亮一个 n**（n=1…8） |
| ④ NETWORK | 1020–1380 | 34–46 | 卡片展开，10 个邻居按 16 分音符弹出、连线生长，微型节点铺开 | 每 11 帧一个邻居 |
| ⑤ CONTINENT | 1380–1860 | 46–62 | 拉远成群岛，海岸线发光，城市点呼吸；Φ 拖一张卡过来，连到 62% 停住、退开 | 进场重击 |
| ⑥ RETURN | 1860–2220 | 62–74 | 穿越光条，俯冲回那张卡：两面都在，卡片底栏写着 `PHYSICS ≡ MATH` | 三次心跳 |
| ⑦ DESIGNATION | 2220–2400 | 74–80 | 片名逐字落定，副题浮现 | 每字 1/4 拍 |

字幕全文见 `src/theme.ts` 的 `subtitles`（改文案只改这一处）。

---

## 三、代码结构

```
remotion/
├── scripts/make_score.py       配乐生成器（numpy 加法合成 + FFT 混响），写 public/score.wav
├── public/score.wav            80.0 s / 44.1 kHz / 立体声
└── src/
    ├── index.ts                入口
    ├── Root.tsx                合成注册（PhyMathia, 2400 帧）
    ├── Video.tsx               总装：段落挂载、HUD、字幕、配乐轨道、切点闪白
    ├── theme.ts                色板、字体、时间常量、字幕表、段落表
    ├── lib.ts                  缓动、弹簧、伪随机、波形/海岸线路径生成
    ├── components/
    │   ├── Stage.tsx           背景：星野、透视网格、扫描线、颗粒、暗角、拍点呼吸
    │   ├── Hud.tsx             常驻界面：角标、时码、节点计数、音量条、刻度尺
    │   └── ui.tsx              玻璃卡、标签、括号、字幕条
    └── scenes/                 Cold / Boot / Dual / Graph / Land / Back / Name
```

**关键约定**

- 所有动画只依赖 `useCurrentFrame()`，不用 `Date`、不用 `Math.random()`（随机一律走 `lib.ts` 的 `hash(seed)`）——所以**任意一帧都能离线复现**，可以并行渲染。
- 场景用「按帧号判定挂载」而不是 `Sequence`，因为它们共享全局帧号；切点处同时叠一层 2 帧青色闪光 + 3 px 位移（`Video.tsx` 的 `tear`）。
- 配乐与画面共用同一张节拍表：120 BPM / 1 拍 15 帧。改 BPM 要同时改 `theme.ts` 与 `make_score.py`。

---

## 四、怎么预览 / 怎么重出片

**预览（会开浏览器，能逐帧拖）**

```bash
cd film/remotion
npm run studio
```

**重新渲染**

```bash
cd film/remotion
npm run render
```

**重新生成配乐**（改完 `scripts/make_score.py` 后）

```bash
cd film/remotion
npm run score
```

> 本机没有系统 Chrome，渲染时用的是 Playwright 自带的 headless shell：
> `~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`。
> 机器换了就改 `--browser-executable`。软件渲染用 `--gl=swangle`。

---

## 五、想改什么，改哪里

| 想改 | 改这里 |
|---|---|
| 字幕文案 / 时间 | `src/theme.ts` → `subtitles` |
| 段落时长 | `src/theme.ts` → `T`；`Video.tsx` → `CUTS`；`Root.tsx` → `durationInFrames` |
| 配色 | `src/theme.ts` → `C` |
| 主问题那句话 | `src/scenes/Boot.tsx` 的 `Q`（字幕 C03 不受影响） |
| 双域用几条模态 | `src/scenes/Dual.tsx` 的 `ROWS` / `MODES` |
| 大陆上有哪些岛 | `src/scenes/Land.tsx` 的 `ISLES`（`x/y/r/seed/name/cn`） |
| 邻居卡的名称 | `src/scenes/Graph.tsx` 的 `NODES` |
| 配乐能量曲线 | `scripts/make_score.py` 的 `DRUMS` / `ARP` / `ACCENTS` |
