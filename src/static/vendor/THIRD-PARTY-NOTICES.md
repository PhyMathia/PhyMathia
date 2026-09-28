# 第三方组件与许可

PhyMathia 坚持**零 CDN 依赖**：`src/static/vendor/` 下的四个前端库全部是随仓库分发的
本地副本，断网也能正常渲染公式、Markdown 与流程图。

| 库 | 目录 | 版本 | 许可证 | 版权归属 |
|---|---|---|---|---|
| KaTeX | `katex/` | 0.16.9 | MIT | Khan Academy and other contributors |
| Marked | `marked/` | 15.0.12 | MIT | Christopher Jeffrey (及贡献者) |
| Mermaid | `mermaid/` | 10.9.8 | MIT | Knut Sveidqvist (及贡献者) |
| DOMPurify | `dompurify/` | 3.1.6 | MPL-2.0 **或** Apache-2.0（任选其一） | Dr.-Ing. Mario Heiderich, Cure53 |

各库的许可证原文已随代码放在**同目录的 `LICENSE` 文件**中：

- `katex/LICENSE`、`marked/LICENSE`、`mermaid/LICENSE` —— MIT 全文
- `dompurify/LICENSE` —— MPL-2.0 与 Apache-2.0 两份全文（上游双许可，摘录任一即可）

## 维护须知

**升级任何一个库时，请连同它的 `LICENSE` 文件一起替换。** 这不是形式主义：MIT 明确要求
「所有副本都要包含版权声明和许可声明」，删掉 `LICENSE` 等于违反这四个库给我们的许可条件。
DOMPurify 的双许可声明也必须完整保留——它靠这段文字让使用者自行选择适用哪一份许可证。

版本号以 `git ls-files src/static/vendor` 记录的文件为准。若要核对某个库的确切版本，
比对文件哈希是最可靠的办法（`mermaid` 的版本号无法从压缩产物里读出，压缩会把版本常量一并去掉）。
