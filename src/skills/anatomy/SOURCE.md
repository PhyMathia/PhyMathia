# 来源与改编说明

本目录的 `phymathia.md` 是 **Anatomy** 的本地适配版，不是原版。

- 上游：`F:\skill\anatomy`（Anatomy，MIT 许可，作者见其 `LICENSE` 与 `README.md`）
- 原版入口：`SKILL.md`（33,589 字符，英文，写给具备文件读取与脚本执行能力的宿主）
- 本适配版：`phymathia.md`（中文，约 4,200 字符）

## 为什么不能直接用原版

PhyMathia 的 skill 是把正文拼进模型提示词，模型没有读文件、跑脚本、开浏览器的能力。
原版里这些指令在本项目里无法执行，注进去只会让模型**编造已执行的步骤**：

| 原版内容 | 在 PhyMathia 里的处理 |
|---|---|
| `node build.mjs --audit` 几何自检 | 删除，改成「交付前肉眼自检八条」 |
| `kit/*.mjs`（`lathe.mjs`、`tube.mjs`、`audit.mjs`） | 删除，改成手写参数化 path 的部件词典 |
| `examples/*/` 参考实现 | 删除（模型读不到文件） |
| `references/*.md`（34 万字符） | 浓缩成五档明暗、画家顺序、运动三节 |
| 按 Figure/Hero/Epic 估工时、报进度 | 全部删除（不适用） |
| three.js / WebGL 着色器 | 删除，本项目产物必须零外部依赖、纯 SVG |
| React / Next.js 版本 | 删除，本项目产物是单文件 HTML |
| A4 PDF 打印、发布到 gallery | 删除 |

## 保留了什么

原版真正值钱的部分被完整保留：**「物体即解释」的铁律、部件词典、五档明暗、
画家顺序（含切分包裹件）、相机参数、反模式清单、运动与读数的真实性要求**。
这些是模型可以照着执行的，与有没有脚本无关。

## 怎么改

直接编辑 `phymathia.md` 的正文。front-matter 的 `scope` 决定它挂给哪个节点
（当前 `viz`）。改完存盘即生效，不需要重启服务（注册表按文件指纹自动失效）。

若把上游原版整个移入 `data/users/<账号>/skills/anatomy/`，请同时放一份
`phymathia.md` 进去——只有 `SKILL.md` 的目录会被标成「待适配」，不会注入。
