#!/usr/bin/env node
// 前端冒烟入口（T66 拆分，2026-10-08）：用例分域放在 scripts/frontend_smoke/ 下，
// 本入口按下方调用序列逐个执行——这就是全局单一执行顺序契约（原单文件的段顺序
// 逐段保留，一段不挪）；「串行边界」段拆在各 serial-*.mjs，段内靠 drain() 收口。
// 带 await 的段＝段内有收口线（async run）；不带 await 的段＝纯同步注册
// （不能加 await，否则多让出的微任务会让沙箱内异步断言的打印漂进别的段）。
// 新增用例：找对域文件直接加（跑 node scripts/frontend_smoke.mjs 验证）；
// 新增域：在 scripts/frontend_smoke/ 建文件，并在下方按语义位置插入 import 与调用。
// 分域路由表：
//   recipes                节点配方 P0–P3（开头两条：harness 快照基建回归＋配方注册表）
//   phi                    Φ 基础修复 / 纯问答分类边界 / 评审路线第二档
//   contextmenu            右键菜单（graph-contextmenu）＋导出概览图/海报
//   viewer-utopia          utopia 查看器 / .pmu 快照 / 节点皮肤 / 打包注册
//   knowledge-summary      知识点摘要契约＋存量摘要优化（方案 B）
//   models-viz             M1 可视化数值实验校验＋模型分组/组级更新模型列表
//   quiz                   M2 检测闭环收口（quiz-relearn）；M2 夹具在 _runner.mjs
//   phi-tiers              Φ 第一档七件套＋第三档体验级
//   continent-core         知识大陆主契约（六文件组拼接源）
//   serial-quiz-retest     串行边界：重测同类题/定位到画布全链路（用 _runner 的 M2 夹具）
//   memory-v2              记忆功能 v2 可感知性＋确定性信号采集
//   design-ruler           设计尺子＋横屏视觉打磨（尾部含一条收口线）
//   serial-utopia          串行边界：utopia 快照导入（写共享 phymathia_sessions 键）
//   continent-v8           大陆 v8.1–v8.12 几何/海岸线/海域换色系列
//   serial-canvas-answer   串行边界：发送排队（T42）＋画布多选批量删除＋answer 节点预览公式定界（尾部含收口线；answer 段与队列收口共用了 sq/ms 句柄，故同文件）
//   serial-quiz-opt        串行边界：知识检测出题优化
//   demo-tuning            演示前两批（T45/T49/T52/T60/T70＋T69/T68 画布渲染性能）
//   theme-wallpaper        壁纸库＋风格家族＋壁纸遮罩分档
//   serial-draft           串行边界：追问草稿卡重渲保字（T152）
//   notes-export           学习笔记导出纯函数
//   profile-implicit       隐式行为画像（纯同步段＋尾部「出题吃画像」串行段）
//   accounts-trash         本地多账号＋只读查阅＋悬空自愈（T185–T187）＋回收站防误删面板（尾部含收口线；回收站用例复用账号夹具 _accountPanelContext，故同文件）
//   token-usage            Token 用量统计面板（纯函数图表＋行为垫片＋源码契约，2026-10-08）
//   load-order             首屏脚本加载契约（T208：app.js defer 与 appVersion 内联脚本时序的静态守卫）
import { finish } from './frontend_smoke/_runner.mjs';
import { run as _recipes } from './frontend_smoke/recipes.mjs';
import { run as _phi } from './frontend_smoke/phi.mjs';
import { run as _contextmenu } from './frontend_smoke/contextmenu.mjs';
import { run as _viewer_utopia } from './frontend_smoke/viewer-utopia.mjs';
import { run as _knowledge_summary } from './frontend_smoke/knowledge-summary.mjs';
import { run as _models_viz } from './frontend_smoke/models-viz.mjs';
import { run as _quiz } from './frontend_smoke/quiz.mjs';
import { run as _phi_tiers } from './frontend_smoke/phi-tiers.mjs';
import { run as _continent_core } from './frontend_smoke/continent-core.mjs';
import { run as _serial_quiz_retest } from './frontend_smoke/serial-quiz-retest.mjs';
import { run as _memory_v2 } from './frontend_smoke/memory-v2.mjs';
import { run as _design_ruler } from './frontend_smoke/design-ruler.mjs';
import { run as _serial_utopia } from './frontend_smoke/serial-utopia.mjs';
import { run as _continent_v8 } from './frontend_smoke/continent-v8.mjs';
import { run as _serial_canvas_answer } from './frontend_smoke/serial-canvas-answer.mjs';
import { run as _serial_quiz_opt } from './frontend_smoke/serial-quiz-opt.mjs';
import { run as _demo_tuning } from './frontend_smoke/demo-tuning.mjs';
import { run as _theme_wallpaper } from './frontend_smoke/theme-wallpaper.mjs';
import { run as _serial_draft } from './frontend_smoke/serial-draft.mjs';
import { run as _notes_export } from './frontend_smoke/notes-export.mjs';
import { run as _profile_implicit } from './frontend_smoke/profile-implicit.mjs';
import { run as _accounts_trash } from './frontend_smoke/accounts-trash.mjs';
import { run as _token_usage } from './frontend_smoke/token-usage.mjs';
import { run as _load_order } from './frontend_smoke/load-order.mjs';

_recipes();
_phi();
_contextmenu();
_viewer_utopia();
_knowledge_summary();
_models_viz();
_quiz();
_phi_tiers();
await _continent_core();
_serial_quiz_retest();
_memory_v2();
await _design_ruler();
_serial_utopia();
_continent_v8();
await _serial_canvas_answer();
await _serial_quiz_opt();
_demo_tuning();
_theme_wallpaper();
_serial_draft();
_notes_export();
await _profile_implicit();
await _accounts_trash();
await _token_usage();
_load_order();
await finish();
