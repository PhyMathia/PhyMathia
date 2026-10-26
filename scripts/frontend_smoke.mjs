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
//   serial-models-sync     串行边界：模型配置服务端同步（T284；model-update 用例含 await fetchModels 自 models-viz 挪来）
//   model-mode-slider      模型面板简略/详细模式＋思考强度滑块（统一写入/快照/档位序/DOM·CSS·构建契约）
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
//   storage-fetch           会话存储层 fetch 超时契约（T237：session.js 每处 fetch 必带 AbortSignal.timeout 的静态守卫）
//   storage-lru             本机会话缓存 LRU（T348：保留窗口＝当前＋最近 N；T342 删除回收 history 键）
//   graph-busy-sweep        生成中断电清扫（T275：busy/running 残留的启动清扫＋历史回放清洗）
//   graph-mirror-slim       服务端镜像体量治理（T212：只减重不删条目＋读回水合丢弃）
//   graph-edit-history      人工编辑节点内容进撤销历史＋viz/mermaid 围栏编辑态往返（2026-10-16）
//   graph-human-finalize    人工定稿防工作流重生成（T355：humanDone 标记＋判定跳过＋链上护栏＋版本生命周期，2026-10-17）
//   graph-draft-recover     生成中断后的草稿回收（T359：水合结算＋module 周期落盘＋流式读帧看门狗，2026-10-17）
//   graph-sync-merge        画布图状态跨设备节点级合并（T360：内容签名/删除墓碑/随包 base 版本，2026-10-17）
//   graph-history-batch4    修改历史批次 4（T389：合并连续编辑/起名收藏/单节点恢复/容量提示/恢复排版/另开探索线）
//   graph-branch-workflow   分支拓展单链路化（T361/T362/T363：三入口落工作流＋删除范围真值，2026-10-17）
//   graph-scope-confirm     Φ 阶段1 先对齐再动手（2026-10-19：复述确认卡＋选中即范围警告行＋大批拆段渲染）
//   harness-health          Φ 主动体检芯片（2026-10-26：开面板零模型体检→顶部芯片→点击预填不发送→同画布同问题只提示一次；行为链独占 fetch/getElementById 桩，域尾收口）
import { finish } from './frontend_smoke/_runner.mjs';
import { run as _recipes } from './frontend_smoke/recipes.mjs';
import { run as _phi } from './frontend_smoke/phi.mjs';
import { run as _contextmenu } from './frontend_smoke/contextmenu.mjs';
import { run as _node_fs_toolbar } from './frontend_smoke/node-fs-toolbar.mjs';
import { run as _viewer_utopia } from './frontend_smoke/viewer-utopia.mjs';
import { run as _knowledge_summary } from './frontend_smoke/knowledge-summary.mjs';
import { run as _formula_repair } from './frontend_smoke/formula-repair.mjs';
import { run as _models_viz } from './frontend_smoke/models-viz.mjs';
import { run as _serial_models_sync } from './frontend_smoke/serial-models-sync.mjs';
import { run as _model_mode_slider } from './frontend_smoke/model-mode-slider.mjs';
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
import { run as _storage_fetch } from './frontend_smoke/storage-fetch.mjs';
import { run as _storage_lru } from './frontend_smoke/storage-lru.mjs';
import { run as _graph_busy_sweep } from './frontend_smoke/graph-busy-sweep.mjs';
import { run as _graph_mirror_slim } from './frontend_smoke/graph-mirror-slim.mjs';
import { run as _graph_edit_history } from './frontend_smoke/graph-edit-history.mjs';
import { run as _graph_history_cursor } from './frontend_smoke/graph-history-cursor.mjs';
import { run as _graph_history_diff } from './frontend_smoke/graph-history-diff.mjs';
import { run as _graph_history_ai_steps } from './frontend_smoke/graph-history-ai-steps.mjs';
import { run as _graph_history_batch4 } from './frontend_smoke/graph-history-batch4.mjs';
import { run as _graph_human_finalize } from './frontend_smoke/graph-human-finalize.mjs';
import { run as _graph_draft_recover } from './frontend_smoke/graph-draft-recover.mjs';
import { run as _graph_sync_merge } from './frontend_smoke/graph-sync-merge.mjs';
import { run as _graph_branch_workflow } from './frontend_smoke/graph-branch-workflow.mjs';
import { run as _graph_scope_confirm } from './frontend_smoke/graph-scope-confirm.mjs';
import { run as _graph_cv_lazy } from './frontend_smoke/graph-cv-lazy.mjs';
import { run as _graph_reflow_guards } from './frontend_smoke/graph-reflow-guards.mjs';
import { run as _harness_health } from './frontend_smoke/harness-health.mjs';
import { run as _workshop } from './frontend_smoke/workshop.mjs';
import { run as _serial_source_input } from './frontend_smoke/serial-source-input.mjs';

_recipes();
_phi();
_contextmenu();
_node_fs_toolbar(); // 划词快捷工具（2026-10-25）：按语义插在 contextmenu 之后，纯同步静态契约
_viewer_utopia();
_knowledge_summary();
_formula_repair();
_models_viz();
await _serial_models_sync();
_model_mode_slider(); // 模型面板简略/详细模式＋思考滑块（2026-10-25）：纯同步，接 models 域之后
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
await _serial_source_input();
_notes_export();
await _profile_implicit();
await _accounts_trash();
await _token_usage();
_load_order();
_storage_fetch();
await _storage_lru();
await _graph_busy_sweep();
await _graph_mirror_slim();
await _graph_edit_history();
await _graph_history_cursor();
await _graph_history_diff();
await _graph_history_ai_steps();
await _graph_history_batch4();
await _graph_human_finalize();
await _graph_draft_recover();
await _graph_sync_merge();
await _graph_branch_workflow();
_graph_scope_confirm();
await _graph_cv_lazy();
await _graph_reflow_guards();
// Φ 主动体检芯片（2026-10-26）：自带收口线（行为链用例换 fetch/getElementById 桩、
// 用毕即还原），紧挨 workshop 之前——workshop 也换全局桩，两域整体 await 不交叠。
await _harness_health();
// 节点工坊（2026-10-20 创造模式重做 P0–P4）：自带收口线（补丁往返用例是异步的），
// 放在最后——它会临时替换 fetch/getActiveModelForRole 两个全局桩，用完立刻还原。
await _workshop();
await finish();
