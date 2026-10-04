// ===== 知识大陆（大陆计划 v1 投影 + v2 簇间边 + v3 边界城市 + v4 证据卫生 + v5 城市与群岛）=====
// 主图是投影层：聚簇与共享概念全部来自 GET /api/continent（服务端从 knowledge +
// sessions 现算），本文件绝不写任何 phymathia_graph_ 会话键——子图（各会话探索
// 网）是唯一事实源，主图随时可重算。
// v2 起主图拥有**自己的**簇间边（KV `continent_edges`，经 /api/kv 读写）：
// 「连接」模式点两个不同区域的概念完成落笔；端点失效的边渲染成断桥，工具条提供
// 清理入口；撤销栈只记边操作（新增/删除/清理/改备注），视口平移缩放不入栈。
// v3 给共享概念的端点卡挂 ◈ 徽标；v4 做证据卫生（弱证据不上图，只进折叠清单）。
// v5.1 共享概念从「弧线 + 浮空标签」升级为**边界城市**：城市摆在它所连的岛之间的
// 走廊里（摆不下进折叠清单，不许叠在岛上），每座岛伸一根辐条连到代表卡；点城市弹
// **重逢清单**（每座岛一行 + 「去看」），绝不替用户猜该跳哪座岛。
// v5.2 群岛布局：岛的摆放从「最近更新排网格」改为**亲缘排序**（强共享概念 + 用户
// 航线）+ 蛇形填充——讲同一主题的岛自然挨成一片，位置本身就是联系，一根线不画。
// v5.3 折叠清单「问 Φ」：机器没把握的折叠行可让 Φ 出一句人话判断；判断块里带
// 「画成航线」芯片，落笔权永远在用户（走 /api/models/chat 的 stream:false 通道）。
// v5.4 岛牌一句话 + 空态引导：岛头副行「前 3 个概念名 + 最近更新」（纯拼接）；
// 没有联运港时顶栏明示点亮机制——空态是引导，不是缺陷。
// v5.5 汇聚口径修正：① 弱证据（2 字共享串）参与**摆位**但不参与断言——梯度/散度这类
// 真关系以前既不画线也不影响摆位，地图看起来「一片孤岛」；② 证据被更具体标签完全覆盖
// 的标签（截断名，如「量守恒定律」）不再单独成城，折进清单（原因「已被更具体的城市
// 覆盖」）——地图上不再出现两座几乎重合、名字还读不懂的城。
// 交互三层口径（游戏地图模型：层级离散、整层切换，不是连续语义缩放）：
// - 下钻：点簇 / 概念节点 → 镜头向点击处推进（转场动画）→ switchToSession，
//   概念节点再经 goToKnowledgeNode 直达定位（等于点 POI 而非进城门口）；
// - 返回：探索网面包屑「‹ 大陆」→ 恢复离开时的平移缩放视口（回来还在原地）；
// - 视图自身克制编辑：只有簇间边一种写路径，Esc / 关闭按钮收起。

const CONTINENT_VIEW_KEY = 'phymathia_continent_view'; // 视口记忆（非会话键）
const CONTINENT_EDGES_API = '/api/kv/continent_edges'; // 主图簇间边的读写端点（现成 KV 通道）
const CONTINENT_REGIONS_API = '/api/kv/continent_regions'; // v7.1a 海域覆盖（改名/挪岛）的读写端点
// v8 族表编辑：合并视图走专用只读端点（内置+KV 一次拿全），增删改走既有 KV 通道
const CONTINENT_FAMILIES_API = '/api/families';
const CONTINENT_FAMILIES_KV_API = '/api/kv/continent_families';
// v10 语义找亲（补词）：建议是只读端点现算的（向量查漏），收下走族表 KV 通道，
// 拒绝记录落独立 KV——机器不自动落笔，拒绝过的不反复提（防骚扰）
const CONTINENT_FAMILY_SUGGEST_API = '/api/families/suggestions';
const CONTINENT_FAMILY_SUGGEST_KV_API = '/api/kv/continent_family_suggestions';
// v8 纠正信号（「从纠正中学习」第一期）：只采集方向计数，二期攒够数据才接自动微调
const CONTINENT_WEIGHTS_API = '/api/kv/continent_gate_weights';
// 与服务端 FAMILY_LIMIT / FAMILY_TERMS_PER_FAMILY 同口径（前端先把脏数据挡住）
const CONTINENT_FAMILY_LIMIT = 40;
const CONTINENT_FAMILY_TERMS_MAX = 40;
const CONTINENT_LINE_LIMIT = 24;      // 与服务端 SHARED_CONCEPT_LIMIT 同口径的二次保险
// v5.1 边界城市：同一对区域之间最多几座城（沿用 v4「每对上限」的精神）+ 全图总量上限。
// 城市尺寸按「摆得进两岛之间的走廊」定：CONTINENT_CLUSTER_GAP = 150，城市 112 宽
// 居中放进去两侧各余 19px，够本；再宽就必然压到岛上。
const CONTINENT_PAIR_CITY_LIMIT = 3;
const CONTINENT_CITY_LIMIT = 12;
const CONTINENT_CITY_W = 112;
const CONTINENT_CITY_H = 32;
const CONTINENT_CITY_GAP = 8;         // 联运港与岛、联运港与联运港的最小间隙
const CONTINENT_USER_EDGE_LIMIT = 120; // 与服务端 USER_EDGE_LIMIT 同口径
const CONTINENT_NODE_W = 160;
const CONTINENT_NODE_H = 46;
const CONTINENT_COLS = 3;             // 簇内概念排几列
const CONTINENT_GAP = 10;
const CONTINENT_PAD = 18;
const CONTINENT_HEADER_H = 36;
// 岛块宽度下限：岛牌头部一行固定件（▾16 + 计数 ~45 + 徽标 ~60 + 间隙）在小岛上会
// 把岛名挤到只剩十几像素，被 head 的 overflow:hidden 拦腰裁成残字（真机截图：
// 「梯度」「散度」只见半个字）。1 卡岛按卡网格只有 196px，装不下这一行
const CONTINENT_ISLAND_MIN_W = 240;
const CONTINENT_CLUSTER_GAP = 150;
const CONTINENT_WORLD_MARGIN = 60;
const CONTINENT_ZOOM_MIN = 0.15;    // v7.3：0.3 → 0.15（有 LOD 兜底才敢放）
const CONTINENT_ZOOM_MAX = 2.5;
// ---------- v9 跨层转场（warp）----------
// 大陆与会话画布是 #graphWorkspace 下同一层叠上下文的兄弟（大陆层 z-index:30 恒在上），
// 转场让两张图**同时在场**交叉缩放：会话→大陆是「拉远」（会话图缩到 0.5 淡出，
// 大陆从 0.35 倍长到 1 倍淡入），大陆→会话是严格镜像的「推近」。
//
// 取代了三段互不相同的旧常数（进入的 SURFACE_FACTOR 1.14 落定 430ms、下钻的
// DIVE_FACTOR 2.6 推镜 430ms、关闭的硬切）。两方向共用同一组参数是**刻意的**：
// 往返手感必须完全对称，用户才能建立稳定直觉，各自不同会变成「同一件事两次不一样」。
//
// **开图只有一段动画**（v9.1）：「拉远」的动势全部由会话图那一侧承担（1→0.5），
// 大陆内容在最终视口直接落位、不补间。早先一版让大陆再从 0.35 倍长到目标视口，
// 结果是两段动画背靠背（数据 ~450ms 才到、第一段 420ms 就结束了），用户真机反馈
// 「两段动画，后面一段似乎是多余的」——对，那一整段就是多余的第二段。教训：
// 「缩放配对」（0.35 配 0.5 互为反比）在纸面上漂亮，但落不了地——大陆内容第一段
// 时还没到，0.35 的长出来只能排到数据之后，于是必然成为第二段。
const CONTINENT_WARP_MS = 420;
const CONTINENT_WARP_EASE = 'cubic-bezier(.22,.75,.3,1)';
const CONTINENT_WARP_CANVAS_OUT = 0.5;  // 会话图退场缩放
// v7.1a 海域层：两级布局的块间距与海域板尺寸（板 = 块内岛矩形并集外扩，
// 顶部另留一行给海域牌）；色盘 12 格，同领域永远同色。
const CONTINENT_REGION_GAP = 230;
const CONTINENT_REGION_PAD = 26;
const CONTINENT_REGION_HEADER_H = 34;
const CONTINENT_HUE_COUNT = 12;
// 置信度三档（后端如实报概率，档位是前端消费口径）：实色 / 淡色+「?」 / 中性+待确认。
// 与服务端 GATE_CONF_SOLID / GATE_CONF_LIGHT 同数值（前端只拿 domainConf 判档）。
const CONTINENT_CONF_SOLID = 0.7;
const CONTINENT_CONF_LIGHT = 0.4;
// 每片海域的岛数容量（MoE 的 expert capacity）：超限提示拆分，不静默丢
const CONTINENT_REGION_CAPACITY = 12;
// v7.3 渐进披露：三档细节只切一个 CSS 类（挂在 #continentWorld 上，零重建 DOM）——
// 世界档只画海域板+岛牌+联运港+航线，区域档加卡片标题，细节档加公式行与锚点短接。
// 有 LOD 才敢把缩放下限放到 0.15（修「≥43 岛一屏装不下」：旧下限 0.3 会卡死适配）
//
// v8.7 世界档阈值 0.55 → 0.35（backlog T23 收口，**改的是「开图第一眼看见什么」**）：
// 真实库 13 岛 / 48 概念在 1440×900 下**适配缩放实测 0.443**，恰好卡在旧阈值 0.55
// 之下 —— 于是开图第一眼 46 张概念卡整档隐藏，满屏都是空盒子，用户要手动放大才知道
// 这片大陆上有什么。**这不是 bug，是阈值定得比真实数据大。**
// 为什么不是 T23 当初建议的 0.45：实测适配值 0.443 < 0.45，**降到 0.45 仍然看不见卡**。
// 为什么不是照搬 0.443：0.443 只是**这一个库**的适配值，会随数据量浮动（岛越多世界越大、
// 适配越小）。0.35 取「卡还各自认得出来」的下限——卡宽 160px × 0.35 = 56px，仍是明确的
// 独立芯片，不是糊成一片。实测降到 0.35 后真机开图 tier = lod-region、46 张卡全部可见，
// 读成「带标注的地图」而非空盒子，放大即读。**代价是首屏文字小**（标题 12px 在 0.443
// 缩放下实渲约 5px）——这是地图标注的正常尺寸，靠放大读，不靠首屏读。
// ⚠️ 改这条会让既有 LOD 真机旅程的时序全变（`continent_regression.mjs` 的「LOD 三档
// 双向切换」是按旧阈值写的），改完必须重跑那条。
const CONTINENT_LOD_WORLD = 0.35;
const CONTINENT_LOD_DETAIL = 1.1;
// ---------- v8.8 词流档 + 远景档：把「空盒子」填上文字 ----------
// v8.7 把世界档阈值降到 0.35 之后，缩到 0.35 以下**仍然是满屏空盒子**——T23 收口的只是
// 「开图第一眼看不见卡」，没管「主动缩远之后看见的是空地」。病根是卡片整档 `display:none`，
// 而 v8.6 刚把岛/海域板的填色加厚（读成「一片地」），于是每块地都是一片没有内容的色块。
//
// 治法不是把卡片放回来（缩远了 160px 的卡只剩 56px 宽，几十张挤成一锅粥），也不是给陆地
// 挂大字（那还是空地），而是**在岛底板内部铺词流**：把属于这座岛的概念名排成自动换行的
// 文字填满空地。选词流而不是「脱壳标注」的理由是它天然按岛分组——相邻标注互相压叠这件
// 事在词流里根本不存在，代价只是每座岛只能显示自己那几十个字。
//
// **词流必须做反向缩放补偿，否则等于没做**：缩放是给 #continentWorld 加 scale()，13px 的
// 标题在 0.35 倍下屏幕上只剩 4.5px，铺进去的是一片糊影。做法沿用本文件已有的先例
// `_continentEdgeLabelScale`（航线备注标签的反缩放）：世界层挂 --cloud-k = clamp(1/zoom)，
// 词流字号取 `calc(var(--fs-md) * var(--cloud-k))`，屏幕字号于是恒定在 ~13px 可读档。
// 反过来「岛放不下就裁掉一部分」正是地图标注的正确行为——越远看得见的字越少。
//
// **远景档阈值 0.22 是从反缩放上限反推的，不是拍的**：--cloud-k 夹在 2.5（放大补不动的
// 硬上限，再大一个字都塞不进岛），屏幕字号 = 13 × zoom × 2.5，掉到 6.5px 以下（zoom≈0.2）
// 就不再是「文字」而是「噪点」。所以 0.22 以下不再硬撑词流，收起它、只留放大的海域名/
// 岛名——一张远景地图本来就只需要大地名。
// ⚠️ 改 CONTINENT_CLOUD_SCALE_MAX 必须同步复核这条阈值：两者是同一条式子的两端
// （屏幕字号 = 13 × zoom × SCALE_MAX，掉到 6.5px 时 zoom = 6.5/(13×SCALE_MAX) ≈ 0.2），
// 各自拍脑袋就会出现「远景档里还在铺糊字」或「词流在还看得清时就提前收了」两种坏结果。
const CONTINENT_LOD_HORIZON = 0.22;
const CONTINENT_CLOUD_SCALE_MAX = 2.5;
// 词流一次最多铺多少个词：岛内空地再大也铺不满（会被裁），限个数是为了让每座岛的词流块
// 高度大致齐平、不会有一座岛拖出一长条把岛牌顶下去
const CONTINENT_CLOUD_WORD_MAX = 24;
// 岛牌头部实际占多高（px，世界单位）：词流盒的 top 由它算出来，不用 CSS 猜。
// 标题行 --fs-md(13px)×1.5 ≈ 20，副行 --fs-2xs(10px)×1.5 ≈ 15，行间 gap 2，头顶留白 9
const CONTINENT_HEAD_H_LINE = 20;
const CONTINENT_HEAD_H_SUB = 15;
const CONTINENT_HEAD_TOP = 9;
// 岛内近似卡片折叠（显示层）：岛默认画前 N 张 +「另有 k 张」——只折叠不删数据
const CONTINENT_ISLAND_CARD_MAX = 9;
// ---------- v8.1 有机抖动层（渲染层，**不进布局纯函数**）----------
// 病根：海域块 / 岛 / 岛内卡三层全是正交等距网格，视觉上是一张方格纸。
// 治法不是换力导向（那会毁掉「位置本身就是联系」与确定性两条拍板，见
// docs/dev/concept-continent.md），而是在**网格之上**叠一层有界的确定性微偏移：
// 网格拓扑与间距约束一字不动（不重叠、世界罩得住、相邻=有亲缘），只把「正交」
// 换成「有界的随机」。偏移由 ID 哈希派生，刷新页面位置不跳、两次渲染逐字节一致。
//
// **幅度是被两条硬约束夹出来的，不是随手取的审美值**，改任何一个都要重跑
// smoke 的抖动段 + 真机 continent_regression：
//   ① 必须装进布局四周已有的 CONTINENT_WORLD_MARGIN = 60 白边里。海域板自己
//      还要按 CONTINENT_JITTER_ISLAND 四周外扩（护住岛不捅出海岸线），所以真正的
//      预算是 **REGION + ISLAND ≤ 60**（卡不外扩板，不进这条）：
//      6 + 36 = 42，留 18px。**世界尺寸因此一个像素不变**，适配 zoom 与 LOD 档位
//      跟着逐字节不变（第一版四周各留 80px 把世界撑大，zoom 跌过 0.55 → 世界档把卡
//      整档隐藏 → 真机回归 10/10 掉到 8/10，教训）。
//   ② 岛不能撞岛：岛间距下限 CONTINENT_GAP_MIN = 100。位移是纯平移，任意两岛最坏
//      相向各偏满 → 100 - 2×(海域 + 岛 + 白噪声保底) = 100 - 2×44 = 12px 仍不重叠。
//      **这条和 v8.1 的预算同额**（那时是 16+28=44），只是分配变了，所以安全余量
//      一字未减。注意白保底那 2px 也算在里面——它是位移，就该占预算。
//      卡间距 CONTINENT_GAP = 10，各偏 3 仍隔 4，转 1.4° 后仍隔 ~2。
// **卡层的 3 是被 10px 卡死的**（余量 = 间距 - 2×幅度，想给 5 就得把 GAP 提上去，
// 那是另一刀）。卡的有机感改走「非均匀卡宽」，别指望在这里加大位移。
const CONTINENT_JITTER_REGION = 6;
const CONTINENT_JITTER_ISLAND = 36;
const CONTINENT_JITTER_CARD = 3;
const CONTINENT_JITTER_ROT = 1.4;   // 卡的微转角（度）——旋转只能是 CSS，数值表达不了
// 岛位移里掺的一撮白噪声：只有 2px（场的 5%），肉眼读不出来，买的是一条保证——
// 「没有哪个元素恰好停在格点上」（smoke 钉每个岛都被抖动过）。
const CONTINENT_JITTER_ISLAND_WHITE = 2;
// ---------- v8.5 低频位移场 ----------
// 病根（v8.1~v8.4 只治了表面）：**均匀间距 + 白噪声 = 歪掉的表格**，不是自然。
// 白噪声把一条直线变成一条点状虚线，眼睛检测的恰恰是「线」而不是噪声，所以前注意
// 系统把点状虚线读作**错位**——整齐的秩序感丢了，自然感没来，观感反而更差。
// 治法是**换成低频场**：位移 = 幅度 × n(世界坐标)，n 是平滑标量场，于是**相邻元素
// 一起动**，栅格的直线被弯成曲线。白噪声按 key 查哈希（每元素独立），低频场按坐标
// 采样（全局连续）——这是 v8.5 与 v8.1 唯一的本质区别。
//
// **双八度是必需的**：单八度读成规整波纹（像壁纸），粗细两层叠加才读成地貌。
// 权重和恰为 1，保证**逐轴** |分量| ≤ 幅度；二维模长靠 WARP_NORM 归一（见
// _continentWarpOffset 的注释，那里的 √2 是个真漏洞）——两条硬约束的推导靠它。
// 幅度预算与 v8.1 同额（44 = 海域 + 岛 + 白噪声保底），但**从海域挪给岛**：
// 海域板大、场在板内近似恒定，整块一起漂本来就看不太出来；岛是眼睛真正盯着读
// 整齐与否的那一层，所以 16+28 → 6+36。
//
// **粗八度波长 900 是量出来的，不是拍的**（第一版写 560，边界城市被挤没过一座）：
// 威胁「边界城市」的不是位移的**绝对值**而是**相邻岛的位移差**，而差值由波长控制、
// 绝对值由幅度控制——**两者是分开的两颗旋钮**。所以正确解法是拉长波长、保住幅度：
// 岛照样离格点 36px（岛级栅格照样被弯掉），但相邻岛几乎同步移动，走廊不受扰动。
// 真实库 13 岛实测（逐档重建 + 真机数城市数）：波长 560 → 4 座城市（多一条 `no_room`
// 折叠）；800 / 1100 / 1500 / 2200 → 全部 5 座。取 **900**：约 1.3 个岛距（岛距 ≈ 686），
// 既够长到同区岛协同移动，又够短到整图（≈3584px）仍横跨 4 个格子把栅格弯掉。
// ⚠️ 改这个数之前先跑那条真机计数，别只看位移量——位移大不等于好看，走廊被挤掉的是功能。
const CONTINENT_WARP_CELL_COARSE = 900;
const CONTINENT_WARP_CELL_FINE = 190;
const CONTINENT_WARP_W_COARSE = 0.7;
const CONTINENT_WARP_W_FINE = 0.3;
const CONTINENT_WARP_NORM = Math.SQRT1_2;   // 1/√2：把逐轴上界换算成模长上界
const CONTINENT_STYLE_KEY = 'phymathia_continent_style';  // 'organic'（默认）| 'grid'
const CONTINENT_STYLE_ORGANIC = 'organic';
const CONTINENT_STYLE_GRID = 'grid';
// ---------- v8.3 网格间距按亲缘分级 ----------
// 病根（v8.1 只治了表面）：产品的核心主张是「相邻即有关联」，但岛间距是**定值** 150
// ——强亲缘的两座岛和毫无关系的两座岛间距一模一样。地图说了真话，但说的都是同一句。
// 改成亲缘越强挨得越近，双份收益：间距参差天然比等距好看；一堆挨得紧的岛直接读成
// 「这是一伙的」。
//   KIN_FULL —— 组间**最大**亲缘到这个值就贴到最紧（权重形态：强共享 1/条、用户边 2/条）
//   MIN/MAX  —— MIN 必须 > 2×(JITTER_REGION + JITTER_ISLAND + JITTER_ISLAND_WHITE)，
//               否则位移后两座岛可能压到一起。这三项都要算：岛是**骑在自己海域上**的，
//               实际位移是三者之和（v8.5 实测幅度 6+36+2 = 44 → 2×44 = 88）。
//               所以 MIN=100 留 12px 保守余量，与 v8.1（16+28 = 44）同额。
//               位移是纯平移，这 12px 是「两岛恰好相向各偏满」的保守下界；实测低频场下
//               近邻是协同位移的，4500 对实测最坏净距 138px（smoke 逐对断言不重叠）。
// **再中心化是这条的生死线**（见 _continentKinGaps 的注释）：所有间距的均值必须
// 恰好回到 base，总宽与定值布局逐字节相等。上一轮给世界加 80px 安全边距就把真机
// 回归从 10/10 打到 8/10（zoom 跌过 0.55 → 世界档把卡整档隐藏），绝不能再犯。
const CONTINENT_GAP_KIN_FULL = 2;
const CONTINENT_GAP_MIN = 100;   // > 2×(6+36+2)=88，位移后也不压岛
const CONTINENT_GAP_MAX = 200;

let _continentOpen = false;
let _continentDrilling = false;
let _continentPan = { x: 0, y: 0 };
let _continentZoom = 1;
// v8.8：上一次写进世界层的词流反缩放系数。只为 _continentApplyTransform 的死区比对用，
// 存一份是为了不在每帧 getComputedStyle 读回自己刚写的值
let _continentCloudK = 1;
let _continentPlacements = {};  // itemId → {x,y,w,h,cx,cy}（世界坐标，布局解析算出）
let _continentClusterRects = [];
let _continentKeyHandler = null;
let _continentDragState = null;
// T136 触屏：视口上按着的指针（pointerId → 屏幕坐标）与双指捏合锚
// （{d0, k0, wx, wy}＝捏合开始时两指中点下的世界点）。Map 按落下顺序迭代，捏合取前两根
let _continentPointers = new Map();
let _continentPinch = null;
// T133 主题重涂：本帧画出的航线三件套（halo/核心线/端珠）。航线颜色渲染时按 data-theme
// 快照进 SVG 属性，开图状态切主题不会重渲——收集起来，主题一变只重涂颜色不重建 DOM
let _continentRouteEls = [];
let _continentSkipViewPersist = false;
let _continentSkipWarp = false;   // 下钻已自播退场转场时，close 只收尾不重播
// v9 跨层转场状态：{id, dir, canvasEl, finish()}。id 每次转场自增，旧 id 的收尾回调
// 在新转场开始时被直接作废——这是「转场中再按 Esc/点别处，立即跳到目标状态」的收敛保证：
// 任何时刻最多只有一段转场在跑，且一定收敛到「大陆开」或「大陆关」二选一，不会卡在半路
let _continentWarp = null;
let _continentWarpSeq = 0;
// 转场「在途」由**整段开合操作**持有一个令牌，不是每段动画各自持有。
// 一次开图由两段组成——层与画布的交叉淡化（点按钮即播）+ 大陆镜头落定（必须等数据）。
// 曾经让两段各自持有一个计数：冷启动时两段之间计数会**瞬时归零**、continent-warp
// 被摘掉，等待器正好在这个窗口采样通过，随后镜头才开始落定，于是脚本在 0.2 倍缩放下
// 去点节点（continent_regression 连挂）。计数归零的缝本身就是 bug——「转场进行中」
// 必须是整段操作一个真值，中间不许有洞。
let _continentWarpHoldTok = null;   // 在途的持有令牌（同一时刻至多一个）
let _continentOpenHold = null;     // 开图操作持有的令牌（关图时要接手释放）
let _continentData = null;         // 最近一次投影数据（边操作后就地刷新）
let _continentLinkMode = false;    // v2 连接模式
let _continentLinkSource = null;   // {itemId, sessionId}
let _continentEdgeUndo = [];       // 撤销栈：只记边操作，视口变化不入栈
let _continentPopover = null;      // 单例弹层（共享概念详情 / 我的边操作）
let _continentFolded = [];         // v4 折叠清单：[{entry, reason}]（weak=弱证据 / covered=已被更具体的联运港覆盖 / capped=超出每对上限 / map_capped=超出全图上限 / no_room=无位可放）
let _continentGuideText = '';      // v5.4 顶栏空态引导文案（空串=不该显示）
// v8 顶栏搜索 / 族表 / 纠正信号
let _continentSearchResults = [];  // 当前搜索命中（唯一命中回车直达，多命中清单逐行跳）
let _continentSearchMore = false;  // T137：命中是否被 cap 截断（脚注措辞用，重渲重放时保真）
const CONTINENT_SEARCH_LIMIT = 30; // T137：清单上限（UI 用 cap+1 探满；纯函数默认 30 不动）
let _continentSearchTimer = 0;     // 输入防抖
let _continentCorrectionCount = 0; // 归类纠正记录条数（图例脚注可见，族表弹层可清空）
const _continentPhiInflight = new Set(); // v5.3 在途「问 Φ」请求：弹层关闭时全部中止
// v7.1a 海域层状态
let _continentRegionOverrides = { renames: {}, assign: {} }; // KV continent_regions（用户覆盖）
let _continentLegendFocus = '';    // 图例聚焦的海域 key（空=不聚焦；只淡化不删不重排）
let _continentRegionInfo = null;   // 最近一次 _continentRegions 的产物（聚焦/徽标消费）
// v7.3 折叠态（岛/海域，localStorage 非会话键）：收起的岛只留岛牌，收起的海域整片
// 收成一枚印章——多枚印章叠着看全局；展开回来布局不变（布局对折叠集是确定性的）
const CONTINENT_COLLAPSED_KEY = 'phymathia_continent_collapsed';
let _continentCollapsed = { islands: [], regions: [] };
let _continentExpanded = {};       // T140：展开的岛（sessionId → true，仅显示层，内存态）

function _continentLoadCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONTINENT_COLLAPSED_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      _continentCollapsed = {
        sessions: Array.isArray(raw.sessions) ? raw.sessions.slice(0, 200).map(String) : [],
        regions: Array.isArray(raw.regions) ? raw.regions.slice(0, 40).map(String) : [],
      };
      return;
    }
  } catch (e) { /* 容忍 */ }
  _continentCollapsed = { sessions: [], regions: [] };
}

function _continentSaveCollapsed() {
  try { localStorage.setItem(CONTINENT_COLLAPSED_KEY, JSON.stringify(_continentCollapsed)); }
  catch (e) { /* 容忍 */ }
}

function _continentToggleCollapse(kind, key) {
  const list = kind === 'region' ? _continentCollapsed.regions : _continentCollapsed.sessions;
  const at = list.indexOf(key);
  if (at >= 0) list.splice(at, 1); else list.push(key);
  _continentSaveCollapsed();
  if (_continentOpen && _continentData) _continentRender(_continentData);  // 重排（确定性，展开回来布局不变）
}

function _continentEsc(text) {
  if (typeof escapeHtml === 'function') return escapeHtml(text);
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// v6：汇聚条目的三种来源各有一个前缀，一眼分得清「机器算出来的」与「领域知识认的」
// ◈ = 标题里共享了一段字；∑ = 公式共享了同一个符号/词；❖ = 概念族（内置族表 /
// 用户或 Φ 确认过的汇聚结果）。族最可信也最"粗"——联运港名是族的规范名（如「矢量分析」），
// 它连的几座岛各自可能只共享 2 字领域词（梯度/散度/旋度），字面尺子认不出这层关系。
function _continentKindPrefix(kind) {
  if (kind === 'formula') return '∑ ';
  if (kind === 'family') return '❖ ';
  return '◈ ';
}

function _continentKindClass(kind) {
  if (kind === 'formula') return ' is-formula';
  if (kind === 'family') return ' is-family';
  return '';
}

function _continentToast(msg) {
  if (typeof showToast === 'function') showToast(msg);
}

// 节点公式：渲成一行小字 KaTeX（不占地图视觉重量）；溢出交给容器裁剪，
// 库缺失/渲染失败回退纯文本。TeX 先过 _cleanFormulaLatex（剥 $ 定界符等，
// 与主渲染链路同一把尺子）。
function _continentRenderFormula(el, latex) {
  let tex = String(latex || '');
  if (typeof _cleanFormulaLatex === 'function') tex = _cleanFormulaLatex(tex);
  else tex = tex.replace(/^\$+|\$+$/g, '').trim();
  if (!tex) { if (el.textContent !== undefined) el.textContent = ''; return; }
  if (typeof katex !== 'undefined' && katex && typeof katex.render === 'function') {
    try {
      katex.render(tex, el, { throwOnError: false, displayMode: false });
      return;
    } catch (e) { /* 回退纯文本 */ }
  }
  if (el.textContent !== undefined) el.textContent = tex;
}

// ---------- v5.2 群岛布局：亲缘排序（位置本身就是联系，纯函数无 DOM） ----------
// 亲缘三个来源：① 强共享概念（≥3 字实词或公式共享）每个跨会话对记 1 分；② 弱共享
// 概念（「振动」「梯度」这类 2 字证据）每个跨会话对记 0.3 分、每对累计封顶 0.9——v5.5
// 起弱证据参与摆位：摆位**不宣称任何概念同一性**（不画线、不建城），是风险最低的表达，
// 正该承接最弱的证据；封顶保证任意多条弱证据都压不过一条强证据。③ 用户亲手画的航线
// ---------- 数据 ----------
async function _continentFetchData() {
  const resp = await fetch('/api/continent', { cache: 'no-cache' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  if (!data || !Array.isArray(data.clusters)) throw new Error('投影数据格式不符');
  return data;
}

function _continentItemIndex() {
  const d = _continentData || {};
  const items = {}, clusterTitles = {}, itemSession = {}, itemCreated = {}, itemSummary = {};
  (d.clusters || []).forEach(c => {
    clusterTitles[c.sessionId] = c.title || '未命名画布';
    (c.items || []).forEach(it => {
      items[it.itemId] = it.title || '';
      itemSession[it.itemId] = c.sessionId;
      itemCreated[it.itemId] = it.createdAt || 0;
      // v5.3「问 Φ」的判断素材（服务端只带 model/manual 的真摘要，local 模板为空串）
      itemSummary[it.itemId] = it.summary || '';
    });
  });
  return { items, clusterTitles, itemSession, itemCreated, itemSummary };
}

function _continentNodeEl(itemId) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelector) return null;
  const safe = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(itemId)) : String(itemId);
  return world.querySelector('.continent-node[data-item-id="' + safe + '"]');
}

// ---------- DOM ----------
function _continentEnsureLayer() {
  let layer = document.getElementById('continentLayer');
  if (layer) return layer;
  const ws = document.getElementById('graphWorkspace');
  if (!ws || typeof ws.appendChild !== 'function') return null;
  layer = document.createElement('div');
  layer.id = 'continentLayer';
  layer.className = 'continent-layer';
  layer.hidden = true;
  layer.innerHTML =
    '<div class="continent-topbar">' +
      '<div class="continent-brand"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><ellipse cx="12" cy="12" rx="4.5" ry="9"></ellipse></svg>' +
      '知识大陆<span class="continent-sub" id="continentStats"></span></div>' +
      '<div class="continent-tools">' +
        '<span class="continent-search-wrap">' +
          '<input class="continent-search" id="continentSearch" type="text" maxlength="40"' +
          ' placeholder="搜岛 / 概念" title="在大陆里找岛和概念卡：唯一命中回车直达，多命中点清单行跳转（跳转不猜）">' +
          '<div class="continent-search-pop" id="continentSearchPop" hidden></div>' +
        '</span>' +
        '<button class="continent-tool" id="continentLinkBtn" title="连接两座不同岛的概念（画一条航线）">连接</button>' +
        // v8.1 画风开关：有机（岛在网格里各偏一点、有厚度）↔ 网格（回到整齐的正交布局）。
        // 位置本身带信息（相邻=有亲缘），两种画风改的只是视觉密度，不改谁挨着谁。
        '<button class="continent-tool is-quiet" id="continentStyleBtn" title="画风：有机（岛与卡在网格里各偏一点，有厚度）↔ 网格（整齐正交）。两种画风的亲缘排序完全相同，只改视觉">有机</button>' +
        '<button class="continent-tool is-quiet" id="continentFitBtn" title="手动适配：把整张大陆缩放到当前窗口内并居中（打开时自动适配之外的常驻手柄）">⌂ 适配</button>' +
        '<button class="continent-tool is-quiet" id="continentFullBtn" title="浏览器全屏显示大陆（再点一次或按 Esc 退出）">⤢ 全屏</button>' +
        '<button class="continent-tool is-quiet" id="continentGateBtn" hidden title="让 Φ 读卡片内容做领域归类（词面认不出的它来补；打开大陆本身不烧调用，点了才跑）">Φ 归类</button>' +
        '<button class="continent-tool is-quiet" id="continentRouteBtn" hidden title="航线的全局显示（总开关 / 透明度）；单条样式点线本身调">航线</button>' +
        '<button class="continent-tool is-quiet" id="continentFamilyBtn" title="概念族表（❖ 联运港与海域的证据来源）：可加族、改词条、删自定义族；也管归类纠正记录">族表</button>' +
        '<button class="continent-tool is-quiet" id="continentWeakBtn" title="没画到地图上的共享点（弱证据 / 超上限 / 无位可放）：照报，可逐条确认落笔" hidden>折叠 0 条</button>' +
        '<button class="continent-tool" id="continentUndoBtn" title="撤销上一条边操作 (Ctrl+Z)" hidden>↩ 撤销</button>' +
        '<button class="continent-tool is-warn" id="continentCleanBtn" title="移除一端已不在大陆上的航线" hidden>清理断桥</button>' +
      '</div>' +
      '<span class="continent-hint" id="continentHint" hidden></span>' +
      '<span class="continent-hint" id="continentGuide" hidden></span>' +
      '<button class="continent-close" id="continentCloseBtn" title="收起大陆 (Esc)">✕</button>' +
    '</div>' +
    '<div class="continent-viewport" id="continentViewport">' +
      '<div class="continent-world" id="continentWorld"></div>' +
      '<div class="continent-empty" id="continentEmpty" hidden>大陆还在形成中——先去画布上学点什么，概念会自己长出来。</div>' +
      '<div class="continent-legend aurora-glass aurora-glass--compact" id="continentLegend" hidden></div>' +
    '</div>';
  ws.appendChild(layer);
  // v8.8：--cloud-k 是写在这个新元素上的内联变量，而 _continentCloudK 是模块级的。
  // 不在这里归零的话，关闭大陆再打开时死区会比对出「没变」而跳过首次写入，词流字号
  // 悄悄退回默认值 1（真机症状：关一次大陆，缩远时词流就糊了）
  _continentCloudK = 1;
  _continentBindViewport(document.getElementById('continentViewport'));
  // v7.1a 图例是交互控件不是地图：pointerdown 不进画布拖拽（其内部按钮各自再处理点击）
  const legend = document.getElementById('continentLegend');
  if (legend && legend.addEventListener) {
    legend.addEventListener('pointerdown', e => e.stopPropagation());
  }
  const closeBtn = document.getElementById('continentCloseBtn');
  if (closeBtn && closeBtn.addEventListener) closeBtn.addEventListener('click', () => closeContinentView());
  const linkBtn = document.getElementById('continentLinkBtn');
  if (linkBtn && linkBtn.addEventListener) linkBtn.addEventListener('click', () => _continentSetLinkMode(!_continentLinkMode));
  const undoBtn = document.getElementById('continentUndoBtn');
  if (undoBtn && undoBtn.addEventListener) undoBtn.addEventListener('click', () => { _continentUndoEdgeOp(); });
  const cleanBtn = document.getElementById('continentCleanBtn');
  if (cleanBtn && cleanBtn.addEventListener) cleanBtn.addEventListener('click', () => { _continentCleanDangling(); });
  const weakBtn = document.getElementById('continentWeakBtn');
  if (weakBtn && weakBtn.addEventListener) weakBtn.addEventListener('click', e => { _continentFoldedPopover(e); });
  // v7.1b：Φ 批量归类入口（触发不自动——打开大陆不烧调用，点了才跑）
  const gateBtn = document.getElementById('continentGateBtn');
  if (gateBtn && gateBtn.addEventListener) gateBtn.addEventListener('click', () => { _continentGateClassify(); });
  // v7.2：航线全局显示入口
  const routeBtn = document.getElementById('continentRouteBtn');
  if (routeBtn && routeBtn.addEventListener) routeBtn.addEventListener('click', e => { _continentRoutePrefsPopover(e); });
  // v8：族表编辑入口（❖ 联运港与海域证据的来源 + 纠正记录清空）
  const familyBtn = document.getElementById('continentFamilyBtn');
  if (familyBtn && familyBtn.addEventListener) familyBtn.addEventListener('click', e => { _continentFamilyPopover(e); });
  // v8.1 画风切换：只重排不改数据，切完立刻能看出「整齐 ↔ 有机」的差别
  const styleBtn = document.getElementById('continentStyleBtn');
  if (styleBtn && styleBtn.addEventListener) {
    styleBtn.addEventListener('click', e => {
      e.stopPropagation();
      _continentToggleStyleMode();
      _continentSyncStyleBtn();
      if (_continentOpen && _continentData) _continentRender(_continentData);
    });
    _continentSyncStyleBtn();
  }
  // T49：手动「适配/全屏」手柄——自动适配只发生在打开/恢复时，这里给常驻入口；
  // 适配后随手持久化，刷新恢复不弹回旧视角
  const fitBtn = document.getElementById('continentFitBtn');
  if (fitBtn && fitBtn.addEventListener) {
    fitBtn.addEventListener('click', e => {
      e.stopPropagation();
      _continentFitView();
      _continentPersistView();
    });
  }
  const fullBtn = document.getElementById('continentFullBtn');
  if (fullBtn && fullBtn.addEventListener) {
    fullBtn.addEventListener('click', e => {
      e.stopPropagation();
      _continentToggleFullscreen();
    });
    // 全屏态跟随（含用户按 Esc 退出的情形）；ensureLayer 只建一次层，监听不会重复挂
    document.addEventListener('fullscreenchange', _continentSyncFullBtn);
    document.addEventListener('webkitfullscreenchange', _continentSyncFullBtn);
    _continentSyncFullBtn();
  }
  // v8：顶栏搜索（输入防抖；唯一命中回车直达——铁律「跳转不猜」的搜索版）
  const searchInput = document.getElementById('continentSearch');
  if (searchInput && searchInput.addEventListener) {
    searchInput.addEventListener('pointerdown', e => e.stopPropagation());
    searchInput.addEventListener('input', () => {
      if (_continentSearchTimer) clearTimeout(_continentSearchTimer);
      _continentSearchTimer = setTimeout(() => {
        _continentSearchTimer = 0;
        _continentSearchUpdate();
      }, 140);
    });
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); _continentSearchGo(); }
    });
  }
  // v7.2 悬停隔离（只看这座岛的航线）：事件委托挂世界层（节点是岛的兄弟元素，
  // mouseenter 挂岛牌会在指针移上卡片时误判离开）；world 元素不随重渲更换，只绑一次
  const worldEl = document.getElementById('continentWorld');
  if (worldEl && worldEl.addEventListener && !worldEl.dataset.isoBound) {
    worldEl.dataset.isoBound = '1';
    worldEl.addEventListener('mouseover', e => {
      const el = e.target && e.target.closest
        ? e.target.closest('.continent-cluster, .continent-node') : null;
      _continentSetRouteIso(el && el.dataset ? el.dataset.sessionId : null);
    });
    worldEl.addEventListener('mouseleave', () => _continentSetRouteIso(null));
  }
  // 弹层单例的场外关闭：捕获阶段先于画布交互，点弹层内部不关
  document.addEventListener('pointerdown', e => {
    if (!_continentPopover) return;
    if (_continentPopover.contains && _continentPopover.contains(e.target)) return;
    _continentClosePopover();
  }, true);
  return layer;
}

// ---------- v4/v5.1 画什么：联运港选位 + 每对海域上限 + 折叠原因（纯函数，无 DOM 实测） ----------
// 一枚联运港 = 一条跨 ≥2 画布的共享概念（同词跨 N 会话仍是一枚，不是每条链路一枚）。
// v4 的「弧线 + 浮空标签」在 v5.1 整体退役：共享概念升级为岛与岛之间的**联运港**（时称城市节点），
// 每座岛伸一根联运线连到该岛的代表卡；摆不下（撞岛 / 撞别的港）就进折叠清单（原因
// 「无位可放」）——绝不叠在别的岛上。弱证据照旧不上图，只进清单。
function _continentRender(data) {
  const world = document.getElementById('continentWorld');
  if (!world) return null;
  world.innerHTML = '';
  // v7.1a 海域层：后端概率 + 用户覆盖（KV）→ 归属解析；有 ≥2 座岛同领域才走两级
  // 布局（海域分块），否则走 v6 旧单网格（行为不变，不引入回归）
  const regionInfo = _continentRegions(data.clusters || [], _continentRegionOverrides,
                                       data.domainList);
  _continentRegionInfo = regionInfo;
  // T140：展开态以浅拷贝带旗进布局——原 data 不动（缓存与确定性都不受扰）
  const clustersForLayout = (data.clusters || []).map(c =>
    _continentExpanded[c.sessionId] ? Object.assign({}, c, { expandAll: true }) : c);
  let layout;
  if (regionInfo.regions.length) {
    // 海域路径：亲缘矩阵由它内部算（块间排序 + 块内排序 + 间距分级三处共用那一份）
    layout = _continentRegionLayout(regionInfo.regions, regionInfo.bySid,
                                    clustersForLayout, data.shared || [], data.userEdges || [],
                                    _continentCollapsed);
  } else {
    // v8.3 无海域路径：kin 只喂给「间距按亲缘分级」。排序仍按 v5.2 原样自己算一份
    // 块内表——贪心链的并列裁决看 total[sid]，换成全局表会改掉既有岛序（冻结契约），
    // 而多算一次 O(n²)（48 岛 ≈ 2300 次）不值得拿契约去换。
    const kin = _continentKinship(
      clustersForLayout.map(c => String(c.sessionId || '')),
      data.shared || [], data.userEdges || []);
    layout = _continentLayoutClusters(
      _continentClusterOrder(clustersForLayout, data.shared || [], data.userEdges || []),
      _continentCollapsed, undefined, kin);
  }
  // v8.1：布局算完，接一层确定性抖动再渲染。这一行是「岛在板内、卡在岛内、联运港与
  // 联运线不脱节、航线仍绕开中间的岛」的唯一保证——**下游一律吃抖动后的数据**，
  // 不在这里逐个元素补偏移（补漏一处就是一处错位）。grid 态原样穿透，零开销。
  const itemSession = {};
  (data.clusters || []).forEach(c => (c.items || []).forEach(item => {
    itemSession[item.itemId] = c.sessionId || '';
  }));
  const regionOfSession = {};
  Object.keys(regionInfo.bySid || {}).forEach(sid => {
    regionOfSession[sid] = (regionInfo.bySid[sid] || {}).key || '';
  });
  layout = _continentJitter(layout, itemSession, regionOfSession);
  _continentPlacements = layout.placements;
  _continentClusterRects = layout.clusterRects;
  world.style.width = layout.worldW + 'px';
  world.style.height = layout.worldH + 'px';

  const esc = _continentEsc;
  // 联运港（v5.1 时称边界城市）：共享概念的端点条目 → 概念名 → 共享词。只认**画到地图上**的那些
  // （强证据、没超上限、有位置）——弱证据不该把节点标成联运港。
  // v7.1a：世界边界罩住海域板（联运港不许因板外扩被判「出界」）
  const plan = _continentDrawPlan(data.shared || [], layout.placements,
    layout.clusterRects, CONTINENT_PAIR_CITY_LIMIT, CONTINENT_CITY_LIMIT,
    layout.regionRects || []);
  const boundary = plan.boundary;
  _continentFolded = plan.folded;

  // 海域板（v7.1a 学科地盘 / v7.3 可折叠）：领域分块的地皮，先画＝垫在岛与卡之下。
  // 板头 = 名字 + 岛数 + 来源标记 + 折叠钮；点板头聚焦这片（再点取消），板身不拦画布
  // 拖拽。收起的海域整片收成一枚印章（岛不渲染），多枚印章叠着看全局
  (layout.regionRects || []).forEach(rect => {
    const region = regionInfo.regions.find(r => r.key === rect.key) || {};
    const el = document.createElement('div');
    el.className = 'continent-region' +
      (region.hue === null || region.hue === undefined ? ' is-gray' : '') +
      (rect.stamp ? ' is-stamp' : '');
    el.dataset.region = rect.key || '';
    if (region.hue !== null && region.hue !== undefined) {
      el.style.setProperty('--region-h', String(region.hue));
    }
    el.style.setProperty('--r-coast', _continentCoast(rect.key, 'region'));
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
    el.title = '海域：' + (region.name || rect.key) + '（' + (region.sessions || []).length +
      ' 座岛 · 点名字聚焦这片，点 ' + (rect.stamp ? '▸ 展开整片' : '▾ 收成印章') + '）';
    el.innerHTML =
      '<div class="continent-region-head">' +
        '<span class="continent-region-fold" data-region-fold="' + esc(rect.key) + '">' +
          (rect.stamp ? '▸' : '▾') + '</span>' +
        '<span class="continent-region-name">' + esc(region.name || rect.key) + '</span>' +
        '<span class="continent-region-count">' + (region.sessions || []).length + ' 座岛 · ' +
          (region.itemCount || 0) + ' 个聚落</span>' +
        (rect.stamp ? '' :
          '<span class="continent-region-src">' + esc(_continentRegionSourceLabel(region.source)) + '</span>') +
      '</div>';
    const head = el.firstChild;
    if (head && head.addEventListener) {
      head.addEventListener('pointerdown', e => {
        e.stopPropagation();  // 板头是聚焦按钮，不是画布拖拽起点
        _continentToggleLegendFocus(rect.key);
      });
      _kact(head);  // T143 键盘可达
    }
    const fold = el.querySelector ? el.querySelector('[data-region-fold]') : null;
    if (fold) {
      fold.addEventListener('pointerdown', e => {
        e.stopPropagation();
        _continentToggleCollapse('region', rect.key);
      });
      _kact(fold);  // T143 键盘可达
    }
    world.appendChild(el);
  });

  // 簇底板（区域图的地皮）。岛牌一句话（v5.4）：前 3 个概念名 + 最近更新时间——
  // 纯拼接、不调模型；看懂岛是看懂联系的前提。
  // v7.1a：岛底板跟海域走——solid 实色岛底 + 领域徽标（点开可改归类）、light 淡色 +
  // 「?」徽标、pending 中性灰 + 「?」（进图例「待确认」）、neutral 纯中性不划地盘。
  // v7.3：岛可折叠（▾ 收起只留岛牌）+ 岛内近似卡片折叠（默认画前 N 张 +「另有 k 张」）
  layout.clusterRects.forEach(rect => {
    const cluster = (data.clusters || []).find(c => c.sessionId === rect.sessionId);
    const tagline = _continentIslandTagline(cluster, _continentRelTime);
    const info = regionInfo.bySid[rect.sessionId] || {};
    const tier = info.tier || 'neutral';
    const region = info.key && tier !== 'neutral'
      ? regionInfo.regions.find(r => r.key === info.key) : null;
    const el = document.createElement('div');
    el.className = 'continent-cluster' +
      (region && region.hue != null && region.hue !== undefined ? ' has-region' : '') +
      (tier === 'solid' ? ' r-solid' : tier === 'light' ? ' r-light' : tier === 'pending' ? ' r-pending' : '') +
      (rect.collapsed ? ' is-collapsed' : '');
    el.dataset.sessionId = rect.sessionId || '';
    // T138 岛屿悬停：海域板/边界卡/联运港都有 title，唯独岛没有——补「为什么归这片海」
    // （前三个领域分布；主要领域在徽标上本就可见）。cluster 缺档时静默跳过
    if (cluster && (cluster.domains || []).length) {
      el.title = '岛：' + (rect.title || '未命名画布') + ' · ' + rect.itemCount + ' 个聚落 · 领域：' +
        cluster.domains.slice(0, 3).map(d =>
          ((d && d.name) || '?') + ' ' + Math.round((Number(d && d.p) * 100) || 0) + '%').join(' · ');
    }
    if (region && region.hue != null && region.hue !== undefined) {
      el.style.setProperty('--region-h', String(region.hue));
    }
    el.style.setProperty('--r-coast', _continentCoast(rect.sessionId, 'island'));
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
    // v7.3 岛内折叠注脚：只画了前 N 张时明示「另有 k 张」——缺失要可见，不许静默吞卡
    const hiddenCount = Math.max(0, rect.itemCount - (rect.shownCount !== undefined ? rect.shownCount : rect.itemCount));
    // T140：注脚升级成按钮——展开/收回都在原地（只报数不许动＝没牙的信息）。
    // 注脚不再过 esc：按钮是本文件拼的可信 HTML，动态片段（sid/数字）各自转义
    const moreNote = (!rect.collapsed && hiddenCount > 0)
      ? ' · <button class="continent-cluster-more" data-island-expand="' + esc(rect.sessionId) + '"' +
        ' title="点开展开这 ' + hiddenCount + ' 个聚落（再点收回）">另有 ' + hiddenCount + ' 个…</button>'
      : (!rect.collapsed && _continentExpanded[rect.sessionId]
        ? ' · <button class="continent-cluster-more" data-island-expand="' + esc(rect.sessionId) + '"' +
          ' title="收回进岛，只留前面几张">收起</button>'
        : '');
    let headHtml =
      '<div class="continent-cluster-head">' +
        '<span class="continent-cluster-headline">' +
          '<span class="continent-cluster-fold" data-island-fold="' + esc(rect.sessionId) + '">' +
            (rect.collapsed ? '▸' : '▾') + '</span>' +
          '<span class="continent-cluster-title">' + esc(rect.title) + '</span>' +
          '<span class="continent-cluster-count">' + rect.itemCount + ' 个聚落</span>' +
        '</span>' +
        (rect.collapsed || !tagline ? '' :
          '<span class="continent-cluster-sub">' + esc(tagline) + moreNote + '</span>') +
      '</div>';
    // 领域徽标（v7.1a 手动纠正入口）：点开「归到哪个领域」清单——一步落笔写 KV。
    // 徽标不在（neutral 无归属）就不占位；淡色/待确认档带「?」（不确定也要可见）。
    // 徽标旁的色点 = 次要领域（混合岛，后端 domains[1] 概率够高才显示）
    const secondaryDot = _continentSecondaryDot(cluster, data.domainList);
    if (info.key && tier !== 'neutral') {
      const region2 = regionInfo.regions.find(r => r.key === info.key);
      const badgeName = region2 ? region2.name : info.key;
      headHtml =
      '<div class="continent-cluster-head">' +
        '<span class="continent-cluster-headline">' +
          '<span class="continent-cluster-fold" data-island-fold="' + esc(rect.sessionId) + '">' +
            (rect.collapsed ? '▸' : '▾') + '</span>' +
          '<span class="continent-cluster-title">' + esc(rect.title) + '</span>' +
          '<span class="continent-cluster-count">' + rect.itemCount + ' 个聚落</span>' +
          '<button class="continent-domain-badge' + (tier === 'solid' ? '' : ' is-unsure') + '"' +
            ' data-domain-sid="' + esc(rect.sessionId) + '"' +
            ' title="这座岛归在「' + esc(badgeName) + '」——点开可改归类（写进大陆记忆，Ctrl+Z 可撤销）">' +
            esc(badgeName) + (tier === 'light' || tier === 'pending' ? ' ?' : '') +
          '</button>' + secondaryDot +
        '</span>' +
        (rect.collapsed || !tagline ? '' :
          '<span class="continent-cluster-sub">' + esc(tagline) + moreNote + '</span>') +
      '</div>';
    }
    el.innerHTML = headHtml + _continentCloudHtml(cluster, rect, tagline, esc);
    const badge = el.querySelector ? el.querySelector('.continent-domain-badge') : null;
    if (badge) {
      badge.addEventListener('pointerdown', e => {
        e.stopPropagation();  // 徽标是归类菜单入口，不进画布拖拽/下钻
        _continentDomainMenu(e, rect.sessionId);
      });
      _kact(badge);  // T143 键盘可达
    }
    const foldBtn = el.querySelector ? el.querySelector('[data-island-fold]') : null;
    if (foldBtn) {
      foldBtn.addEventListener('pointerdown', e => {
        e.stopPropagation();
        _continentToggleCollapse('island', rect.sessionId);
      });
      _kact(foldBtn);  // T143 键盘可达
    }
    // T140：展开/收回钮——布局要重算（岛会长高），走本地重渲（_continentData 现成，无网络）
    const moreBtn = el.querySelector ? el.querySelector('[data-island-expand]') : null;
    if (moreBtn) {
      moreBtn.addEventListener('pointerdown', e => {
        e.stopPropagation();  // 与折叠钮同规：不进画布拖拽/下钻
        const sid = moreBtn.getAttribute('data-island-expand');
        if (_continentExpanded[sid]) delete _continentExpanded[sid];
        else _continentExpanded[sid] = true;
        if (_continentOpen && _continentData) _continentRender(_continentData);
      });
      _kact(moreBtn);  // T143 键盘可达
    }
    world.appendChild(el);
  });

  // 概念节点（POI）：标题一行 + 公式渲成一行小字 KaTeX（简略口径，容器裁剪）
  (data.clusters || []).forEach(c => (c.items || []).forEach(item => {
    const p = layout.placements[item.itemId];
    if (!p) return;
    const el = document.createElement('div');
    el.className = 'continent-node' + (boundary[item.itemId] ? ' continent-node--boundary' : '');
    el.dataset.sessionId = c.sessionId || '';
    el.dataset.itemId = item.itemId;
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    // v8.1 微转角走 CSS 变量而不是内联 transform：hover 抬升要在 CSS 里与它叠加
    // （transform: rotate(var(--jr)) translateY(-2px)），写死内联 transform 会把
    // hover 的那层覆盖掉。grid 态不写 --jr，rotate(0deg) 与不转等价。
    el.style.setProperty('--jr', (layout.cardRot[item.itemId] || 0) + 'deg');
    if (boundary[item.itemId]) {
      el.title = '联运港：其他岛也学过（共享「' + boundary[item.itemId] + '」）';
    }
    let html = '<div class="continent-node-title">' + esc(item.title) + '</div>';
    if (item.formula || item.formulaPreview) {
      html += '<div class="continent-node-formula"></div>';
    }
    if (boundary[item.itemId]) {
      html += '<span class="continent-node-badge" aria-hidden="true">◈</span>';
    }
    el.innerHTML = html;
    const fEl = el.querySelector ? el.querySelector('.continent-node-formula') : null;
    if (fEl) _continentRenderFormula(fEl, item.formula || item.formulaPreview);
    world.appendChild(el);
  }));

  // 边界城市（v5.1）：共享概念的「地点」——摆在它所连的岛之间的走廊里，每座岛一根
  // 联运线连到代表聚落。点开是**重逢清单**（每座岛学过的那些卡 + 「去看」）：绝不替你猜
  // 跳哪座岛，机器猜「最近学的」总有一半时候不是你想去的。
  plan.cities.forEach(city => {
    const s = city.entry || {};
    const el = document.createElement('div');
    el.className = 'continent-city' + _continentKindClass(s.kind);
    el.dataset.cityLabel = s.label || '';
    el.dataset.citySids = city.reps.map(r => r.sessionId).join(',');  // v7.1a 图例聚焦判定用
    el.style.left = city.box.x + 'px';
    el.style.top = city.box.y + 'px';
    el.title = '联运港：' + city.reps.length + ' 座岛都学过——点开看重逢清单';
    el.innerHTML = '<span class="continent-city-name">' +
      _continentKindPrefix(s.kind) + esc(s.label || '') + '</span>';
    el.addEventListener('pointerdown', e => {
      e.stopPropagation();  // 标签/用户边同规：不让城市点击进画布拖拽态
      _continentCityPopover(city, e);
    });
    _kact(el);  // T143 键盘可达：城市是大陆的核心交互件之一
    const ends = city.reps.map(r => r.itemId);
    el.addEventListener('mouseenter', () => _continentHighlightNodes(ends, true));
    el.addEventListener('mouseleave', () => _continentHighlightNodes(ends, false));
    world.appendChild(el);
  });

  // ---------- 连线层：联运线（联运港→岛）+ 航线（岛框→岛框，v7.2）+ 断桥 ----------
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'continent-links');
  svg.setAttribute('width', String(layout.worldW));
  svg.setAttribute('height', String(layout.worldH));

  // 联运线：联运港 → 该岛代表聚落。两端都被节点盖住（SVG 是世界层首个子元素，节点画在它
  // 上面），所以露出来的正好是走廊那一段——「城市连着哪几座岛」一眼可见。
  plan.cities.forEach(city => {
    city.reps.forEach(r => {
      const p = layout.placements[r.itemId];
      if (!p) return;
      const spoke = document.createElementNS(svgNS, 'line');
      spoke.setAttribute('class', 'continent-spoke');
      spoke.setAttribute('x1', String(city.box.cx));
      spoke.setAttribute('y1', String(city.box.cy));
      spoke.setAttribute('x2', String(p.cx));
      spoke.setAttribute('y2', String(p.cy));
      spoke.setAttribute('data-sids', city.reps.map(x => x.sessionId).join(','));
      svg.appendChild(spoke);
    });
  });
  const cityCount = plan.cityCount;

  // T144：边层（用户航线 + 断桥 + 标签/断桥标记）收进独立 <g> 与标签 wrap——
  // _continentRedrawEdges 只清这两处重建，辐条/岛卡/公式 KaTeX 全不动。
  // 绘制逻辑在 _continentDrawEdgeLayer（与局部重画共用同一份，产出一致）
  const edgeLayer = document.createElementNS(svgNS, 'g');
  edgeLayer.setAttribute('class', 'continent-edge-layer');
  svg.appendChild(edgeLayer);
  const labelWrap = document.createElement('div');
  labelWrap.className = 'continent-edge-labels';
  _continentDrawEdgeLayer(data, layout, edgeLayer, labelWrap);
  _continentEdgeLayerEl = edgeLayer;
  _continentEdgeLabelWrap = labelWrap;
  _continentLayoutCache = layout;

  world.appendChild(labelWrap);
  world.insertBefore(svg, world.firstChild);

  const mineCount = (data.userEdges || []).length;
  _continentStatsBase = data.clusterCount + ' 座岛 · ' + data.itemCount + ' 个聚落' +
    (regionInfo.regions.length ? ' · ' + regionInfo.regions.length + ' 片海域' : '') +
    (cityCount ? ' · ' + cityCount + ' 座联运港' : '') +
    (plan.folded.length ? ' · 折叠 ' + plan.folded.length + ' 条' : '');
  const stats = document.getElementById('continentStats');
  if (stats) stats.textContent = _continentStatsBase + (mineCount ? ' · 我的航线 ' + mineCount : '');
  const empty = document.getElementById('continentEmpty');
  if (empty) empty.hidden = (data.itemCount || 0) > 0;
  // 空态引导（v5.4）：「暂无联运港」管「有岛但 0 港」，教的是共享概念怎么长成联运港。
  // 与连接模式提示互斥的约定不变（见 _continentSetLinkMode）。
  // 「空画布计数」那句引导已按用户要求删除（2026-09-27）：它统计的是本地会话清单里
  // 有几个画布没上图，用户看到的是一句关于自己数据的统计而不是可操作的引导。
  const guide = document.getElementById('continentGuide');
  if (guide) {
    _continentGuideText = (cityCount === 0 && (data.itemCount || 0) > 0)
      ? '暂无联运港——当同一个概念在第二座岛也出现时，这里会自动长出一座联运港'
      : '';
    guide.hidden = !_continentGuideText;
    guide.textContent = _continentGuideText;
  }
  // v7.1a 图例（左下角，不与顶栏争位）+ 聚焦态恢复 + 归类入口
  _continentRenderLegend(regionInfo, data);
  _continentApplyFocus();
  // v8.1 噪点层：整块大陆覆一层极淡的颗粒，给渐变/阴影一个「纸面」的质地，
  // 消掉大面积半透明色块那种塑料感。**一个元素顶一片**——不给每张卡挂滤镜，
  // 几十张卡的混合模式会把重绘成本翻几倍。挂 **viewport 不挂 world**：挂 world
  // 会随缩放一起缩放，缩到 0.15 时 180px 的颗粒在屏上只剩 27px，近看一片大噪点。
  // 插在 world 之后、图例之前，图例与空态提示仍盖在它上面。
  const viewport = document.getElementById('continentViewport');
  if (viewport && !viewport.querySelector('.continent-grain')) {
    const grain = document.createElement('div');
    grain.className = 'continent-grain';
    grain.setAttribute('aria-hidden', 'true');
    viewport.insertBefore(grain, viewport.children[1] || null);
  }
  // v8：重渲会换掉世界层全部 DOM——搜索命中高亮按既有结果重放（搜索态跨重渲存活）
  if (_continentSearchResults.length) _continentApplySearchHit(_continentSearchResults);
  // v5.6：备注标签挂在世界层里，会随地图缩放一起变形——渲染完成后按当前倍率抵消一次
  // （必须是渲染的最后一步：新画的边出生时不带同步，结尾这一次是它们的出生校正）
  _continentSyncEdgeLabels();
  return layout;
}

function _continentHighlightNodes(ids, on) {
  (ids || []).forEach(id => {
    const el = _continentNodeEl(id);
    if (el && el.classList) el.classList.toggle('is-hot', !!on);
  });
}

// ---------- 弹层（单例）：共享概念详情 / 我的边操作 ----------
function _continentClosePopover() {
  // v5.3：在途的「问 Φ」判断没处落了，随弹层关闭一并中止
  if (_continentPhiInflight.size) {
    _continentPhiInflight.forEach(c => { try { c.abort(); } catch (e) { /* 容忍 */ } });
    _continentPhiInflight.clear();
  }
  if (_continentPopover && _continentPopover.remove) _continentPopover.remove();
  _continentPopover = null;
}

function _continentOpenPopover(html, x, y) {
  _continentClosePopover();
  const layer = document.getElementById('continentLayer');
  if (!layer) return null;
  const el = document.createElement('div');
  el.className = 'continent-popover aurora-glass aurora-glass--dialog';
  el.innerHTML = html;
  el.addEventListener('pointerdown', e => e.stopPropagation());  // 场外关闭靠 document 捕获
  layer.appendChild(el);
  const vw = layer.clientWidth || 900, vh = layer.clientHeight || 600;
  const w = el.offsetWidth || 220, h = el.offsetHeight || 120;
  el.style.left = Math.max(8, Math.min(x + 12, vw - w - 8)) + 'px';
  el.style.top = Math.max(64, Math.min(y - h / 2, vh - h - 8)) + 'px';
  _continentPopover = el;
  return el;
}

// v3 确认落笔口：Φ 只会口头建议「去大陆连接」；真正写边在这里，用户亲手点按钮。
// v4：一枚标签可能对应多条链路（同词跨 N 会话），所以按链路逐行列出、逐行落笔。
function _continentSharedPopover(s, ev) {
  const idx = _continentItemIndex();
  const links = (s.links || []).slice(0, 6);
  const userEdges = (_continentData && _continentData.userEdges) || [];
  const rows = links.map((link, i) => {
    const fromTitle = idx.items[link.from] || '（概念已不在）';
    const toTitle = idx.items[link.to] || '（概念已不在）';
    const fromCluster = idx.clusterTitles[link.fromSession] || '已删除的画布';
    const toCluster = idx.clusterTitles[link.toSession] || '已删除的画布';
    const already = userEdges.some(e =>
      (e.fromItem === link.from && e.toItem === link.to) ||
      (e.fromItem === link.to && e.toItem === link.from));
    return '<div class="continent-pop-row">' +
      '<span class="continent-pop-row-text">「' + _continentEsc(fromCluster) + '」的 ' + _continentEsc(fromTitle) +
      ' ↔ 「' + _continentEsc(toCluster) + '」的 ' + _continentEsc(toTitle) + '</span>' +
      (already
        ? '<span class="continent-pop-note-inline">已连线</span>'
        : '<button class="continent-pop-btn" data-link="' + i + '">画成航线</button>') +
      '</div>';
  }).join('');
  const kindText = s.kind === 'formula'
    ? '两边画布的公式共享结构「' + _continentEsc(s.label) + '」'
    : (s.kind === 'family'
      ? '两边画布同属概念族「' + _continentEsc(s.label) + '」（族表给的领域关系，不靠字面撞车）'
      : '两边画布的概念标题共享「' + _continentEsc(s.label) + '」');
  const html =
    '<div class="continent-pop-title">' + _continentKindPrefix(s.kind) + _continentEsc(s.label) +
    (links.length > 1 ? ' <span class="continent-pop-count">×' + links.length + '</span>' : '') + '</div>' +
    rows +
    '<div class="continent-pop-desc">' + kindText + '——自动检出的共享点不会自动连线，要不要由你落笔。</div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-link]').forEach(btn => btn.addEventListener('click', async () => {
    const link = links[Number(btn.getAttribute('data-link'))];
    if (!link) return;
    try {
      const ok = await _continentAddUserEdge(link.from, link.to, s.label);
      if (ok) { _continentClosePopover(); _continentToast('已画上这条航线'); }
    } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  }));
}

// ---------- v5.1 重逢清单：点城市选去哪儿 ----------
// 铁律「跳转不猜」：一座城市连着 N 座岛就有 N 个目标，绝不替用户猜「最近学的」。
// 一岛一行（画布名 + 卡片名 + 学的时间 + 「去看」）；同一座岛有多张卡命中同一概念时
// 全部列出来（缩进次行、各带自己的「去看」）——词面命中是事实，不该被代表卡口径吞掉。
function _continentRelTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  if (typeof formatRelativeTime === 'function') {
    try { return formatRelativeTime(t); } catch (e) { /* 兜底空串 */ }
  }
  return '';
}

// ---------- 岛牌一句话：真摘要优先，没有才回退「前 3 个概念名 + 最近更新时间」 ----------
// v8 接上 descriptor 槽位（docs/大陆计划.md v5.4 留的口）：投影条目的 summary 只带
// model/manual 的真摘要（local 模板是空串），最早学的一条最能代表「这座岛在讲什么」。
// 库里还没有真摘要时行为与 v5.4 逐字一致（不引入回归）。rel 注入是为了 smoke 可测
// （formatRelativeTime 依赖当前时钟）。
function _continentClipText(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length <= n ? t : t.slice(0, n);
}

function _continentIslandTagline(cluster, rel) {
  const items = (cluster && cluster.items) || [];
  let latest = 0;
  let summary = '';
  (items || []).forEach(it => {
    const ts = Number(it && it.createdAt) || 0;
    if (ts > latest) latest = ts;
    if (!summary) {
      const s = String((it && it.summary) || '').trim();
      if (s) summary = s;
    }
  });
  const when = latest ? (rel || _continentRelTime)(latest) : '';
  if (summary) return _continentClipText(summary, 48) + (when ? ' · ' + when : '');
  const names = [];
  (items || []).forEach(it => {
    const t = String((it && it.title) || '').trim();
    if (t && names.length < 3) names.push(t);
  });
  if (when) names.push(when);
  return names.join(' · ');
}

// ---------- v8.8 岛内词流：世界档把空地填上这座岛的概念名 ----------
// **一次渲染写死，缩放全程不碰**：和 v7.3 的 LOD 一样，档位切换只切 CSS 类，词流既不在
// 缩放回调里重算也不重建 DOM。词流盒的 top 是算出来的而不是 CSS 猜的——岛牌有没有副行
// 会差一整行高度（15px），猜错就压到词，或者词离岛牌老远悬在半空。
// 收起的岛不生成词流：那块地只剩一枚岛牌，铺字是铺到空气上。
// 词取**全部** items 的标题而不是只取画出来的前 N 张：卡在岛内被折了（>9 张），但岛没折，
// 词流是「这座岛里有什么」的说明，少给几个字反而是隐瞒。多的部分由岛牌「另有 k 张」申明。
function _continentCloudHtml(cluster, rect, tagline, esc) {
  if (rect && rect.collapsed) return '';
  const words = ((cluster && cluster.items) || [])
    .map(it => String((it && it.title) || '').trim())
    .filter(Boolean)
    .slice(0, CONTINENT_CLOUD_WORD_MAX);
  if (!words.length) return '';
  const hasSub = !!(tagline && !(rect && rect.collapsed));
  const top = CONTINENT_HEAD_TOP + CONTINENT_HEAD_H_LINE + (hasSub ? 2 + CONTINENT_HEAD_H_SUB : 0) + 6;
  return '<div class="continent-cloud" style="top:' + top + 'px">' +
    words.map(w => '<span class="continent-cloud-word">' + esc(w) + '</span>').join('') +
    '</div>';
}

// ---------- v7.1a 海域层：图例 / 聚焦 / 手动纠正（改海域名 / 挪岛） ----------
// 图例回答「这块颜色是什么意思、谁说的」；聚焦只淡化不删不重排（地图的空间记忆是
// 资产）；纠正写 KV continent_regions（与 continent_edges 同通道），撤销栈兼容。

