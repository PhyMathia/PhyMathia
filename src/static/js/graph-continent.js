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
// 「画成大陆边」芯片，落笔权永远在用户（走 /api/models/chat 的 stream:false 通道）。
// v5.4 岛牌一句话 + 空态引导：岛头副行「前 3 个概念名 + 最近更新」（纯拼接）；
// 没有共享连线时顶栏明示点亮机制——空态是引导，不是缺陷。
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
const CONTINENT_CITY_GAP = 8;         // 城市与岛、城市与城市的最小间隙
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
// 世界档只画海域板+岛牌+城市+航线，区域档加卡片标题，细节档加公式行与锚点短接。
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
// **粗八度波长 900 是量出来的，不是拍的**（第一版写 560，把第 5 座边界城市挤没了）：
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
let _continentFolded = [];         // v4 折叠清单：[{entry, reason}]（weak=弱证据 / covered=已被更具体的城市覆盖 / capped=超出每对上限 / map_capped=超出全图上限 / no_room=无位可放）
let _continentGuideText = '';      // v5.4 顶栏空态引导文案（空串=不该显示）
// v8 顶栏搜索 / 族表 / 纠正信号
let _continentSearchResults = [];  // 当前搜索命中（唯一命中回车直达，多命中清单逐行跳）
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
// 用户或 Φ 确认过的汇聚结果）。族最可信也最"粗"——城市名是族的规范名（如「矢量分析」），
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
// 正该承接最弱的证据；封顶保证任意多条弱证据都压不过一条强证据。③ 用户亲手画的大陆边
// 记 2 分（人的认定是最强证据）。主题层面的亲近用布局表达，一根线都不用画。
const CONTINENT_KIN_STRONG = 1;
const CONTINENT_KIN_WEAK = 0.3;
const CONTINENT_KIN_WEAK_CAP = 0.9;
const CONTINENT_KIN_EDGE = 2;

function _continentKinshipKey(a, b) {
  return String(a) < String(b) ? a + '|' + b : b + '|' + a;
}

// 亲缘矩阵：只统计画布上真实存在的会话对；返回 { 'a|b': 权重 }。
function _continentKinship(sessionIds, shared, userEdges) {
  const kin = {}, weak = {};
  const known = new Set(sessionIds || []);
  const add = (a, b, w) => {
    if (!a || !b || a === b || !known.has(a) || !known.has(b)) return;
    const key = _continentKinshipKey(a, b);
    kin[key] = (kin[key] || 0) + w;
  };
  const addWeak = (a, b) => {
    if (!a || !b || a === b || !known.has(a) || !known.has(b)) return;
    const key = _continentKinshipKey(a, b);
    weak[key] = Math.min(CONTINENT_KIN_WEAK_CAP, (weak[key] || 0) + CONTINENT_KIN_WEAK);
  };
  (shared || []).forEach(s => {
    if (!s) return;
    const sids = (s.sessions || []).filter(sid => known.has(sid));
    const strong = s.strength === 'strong';
    for (let i = 0; i < sids.length; i++) {
      for (let j = i + 1; j < sids.length; j++) {
        if (strong) add(sids[i], sids[j], CONTINENT_KIN_STRONG);
        else addWeak(sids[i], sids[j]);
      }
    }
  });
  // 弱证据封顶后合入（封顶按「对」算，与强证据/用户边的量纲分开）
  Object.keys(weak).forEach(key => { kin[key] = (kin[key] || 0) + weak[key]; });
  (userEdges || []).forEach(e => add(e.fromSession, e.toSession, CONTINENT_KIN_EDGE));
  return kin;
}

// 贪心链式排序：从亲缘总数最多的岛出发，每步走向与当前岛亲缘最高的下一座
// （并列看全局亲缘总数，再并列保持原序＝服务端最近更新序）。链 A→B→C→D 折进
// 网格时配合蛇形填充，行末与下一行行首上下相邻——亲缘链不会在对角线上断开。
// 无亲缘时每步并列都走原序：输出与输入同序，行为与 v5.1 完全一致（不引入回归）。
function _continentClusterOrder(clusters, shared, userEdges) {
  const list = (clusters || []).slice();
  if (list.length < 3) return list;  // 0–2 座岛怎么排都相邻，不必排
  const sids = list.map(c => String(c.sessionId || ''));
  // 刻意不接受外部传入的 kin：贪心链的并列裁决看 total[sid]，换一份作用域不同的表
  // 会改掉既有岛序，而 v5.2 的排序是冻结契约。v8.3 的间距分级另有自己的一份。
  const kin = _continentKinship(sids, shared, userEdges);
  const total = {};
  Object.keys(kin).forEach(key => {
    const pair = key.split('|');
    total[pair[0]] = (total[pair[0]] || 0) + kin[key];
    total[pair[1]] = (total[pair[1]] || 0) + kin[key];
  });
  const kinOf = (a, b) => kin[_continentKinshipKey(a, b)] || 0;
  const remaining = list.slice();
  let startIdx = 0;
  for (let i = 1; i < remaining.length; i++) {
    if ((total[sids[i]] || 0) > (total[sids[startIdx]] || 0)) startIdx = i;
  }
  const ordered = [remaining.splice(startIdx, 1)[0]];
  while (remaining.length) {
    const cur = ordered[ordered.length - 1];
    let bestIdx = 0, bestKin = -1, bestTotal = -1;
    remaining.forEach((c, i) => {
      const k = kinOf(cur.sessionId, c.sessionId);
      const t = total[c.sessionId] || 0;
      if (k > bestKin || (k === bestKin && t > bestTotal)) {
        bestIdx = i; bestKin = k; bestTotal = t;
      }
    });
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return ordered;
}

// ---------- v7.1a 海域层：把已有的领域归属画出来（纯函数，无 DOM） ----------
// 后端早就算得出每座岛属于哪个领域（v6 族表 + v7 softmax 评分核心），v7 之前这份归属
// 只用于「跨 ≥2 岛建一座城」——分类结果画不出来，用户看到的就只是 6 个同色等权方块。
// 这一层只做三件事：按领域分组（≥2 座岛才画板）、配色（同领域永远同色）、可纠正（KV）。

// 领域名 → 稳定色相。铁律②的视觉面：专家名单固定 → 色槽确定——内置名单先分配
// （表序固定，槽位永不动），自定义领域按 domainList 里的稳定顺序排在后面，新增
// 自定义只会影响排在其后的自定义项。>12 个活跃领域由 _continentRegions 并「其他」，
// 所以色槽永远够用。
function _continentStrHash(s) {
  let h = 5381;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function _continentRegionHue(name, universe) {
  const names = (universe && universe.length ? universe.slice() : [name]);
  if (names.indexOf(name) < 0) names.push(name);
  const taken = new Array(CONTINENT_HUE_COUNT).fill(false);
  for (let i = 0; i < names.length; i++) {
    let slot = _continentStrHash(names[i]) % CONTINENT_HUE_COUNT;
    let probe = 0;
    while (probe < CONTINENT_HUE_COUNT && taken[slot]) {
      slot = (slot + 1) % CONTINENT_HUE_COUNT;
      probe++;
    }
    if (names[i] === name) return Math.round(slot * (360 / CONTINENT_HUE_COUNT)) % 360;
    taken[slot] = true;
  }
  return 0;
}

// 归属解析：后端概率 + 用户覆盖（KV continent_regions，优先级①）→ 每座岛的
// {key, tier, source}。tier 三档：solid（p≥0.7）/ light（0.4–0.7，「?」徽标）/
// pending（<0.4，中性灰不上地盘，进「待确认」）——「不确定也要可见」。
// 用户指派永远 solid（人说了算，conf=1）。查空是正常路径：没证据 → neutral。
function _continentRegions(clusters, overrides, domainList) {
  const assign = (overrides && overrides.assign) || {};
  const renames = (overrides && overrides.renames) || {};
  const bySid = {};
  const groups = {};
  const pending = [];
  const neutral = [];
  (clusters || []).forEach(c => {
    const sid = String(c.sessionId || '');
    if (Object.prototype.hasOwnProperty.call(assign, sid)) {
      const key = assign[sid] || null;
      if (!key) { bySid[sid] = { key: null, tier: 'neutral', source: 'user' }; neutral.push(sid); return; }
      bySid[sid] = { key: key, tier: 'solid', conf: 1, source: 'user' };
      (groups[key] = groups[key] || []).push(sid);
      return;
    }
    const key = c.domain || null;
    const conf = Number(c.domainConf) || 0;
    if (!key) { bySid[sid] = { key: null, tier: 'neutral', source: '' }; neutral.push(sid); return; }
    if (conf < CONTINENT_CONF_LIGHT) {
      bySid[sid] = { key: key, tier: 'pending', conf: conf, source: c.domainSource || '' };
      pending.push({ sid: sid, domain: key, conf: conf, title: c.title || '' });
      return;
    }
    bySid[sid] = { key: key, tier: conf >= CONTINENT_CONF_SOLID ? 'solid' : 'light',
                   conf: conf, source: c.domainSource || '' };
    (groups[key] = groups[key] || []).push(sid);
  });
  // ≥2 座岛同领域才画海域板（单岛自成一国＝没有分组）；>12 片按岛数升序并「其他」
  let regions = [];
  const singles = [];
  Object.keys(groups).forEach(key => {
    if (groups[key].length >= 2) regions.push({ key: key });
    else singles.push.apply(singles, groups[key]);
  });
  regions.forEach(r => { r.sessions = groups[r.key].slice(); });
  if (regions.length > CONTINENT_HUE_COUNT) {
    const sorted = regions.slice().sort((a, b) => a.sessions.length - b.sessions.length);
    const tail = sorted.slice(0, regions.length - CONTINENT_HUE_COUNT + 1);
    const tailKeys = new Set(tail.map(r => r.key));
    const merged = [];
    tail.forEach(r => merged.push.apply(merged, r.sessions));
    regions = regions.filter(r => !tailKeys.has(r.key));
    if (merged.length >= 2) regions.push({ key: '其他', sessions: merged, merged: true });
    else singles.push.apply(singles, merged);
  }
  const itemCountOf = sid => {
    const c = (clusters || []).find(x => String(x.sessionId) === sid);
    return (c && c.itemCount) || 0;
  };
  regions.forEach(r => {
    r.name = r.merged ? '其他' : (renames[r.key] || r.key);
    r.hue = r.merged ? null : _continentRegionHue(r.key, domainList);
    r.itemCount = r.sessions.reduce((acc, sid) => acc + itemCountOf(sid), 0);
    const srcs = r.sessions.map(sid => bySid[sid].source);
    r.source = srcs.indexOf('user') >= 0 ? 'user'
      : srcs.indexOf('gate') >= 0 ? 'gate' : 'family';
    r.userNamed = !r.merged && Object.prototype.hasOwnProperty.call(renames, r.key);
  });
  return { regions: regions, singles: singles, neutral: neutral, pending: pending, bySid: bySid };
}

// ---------- 纯布局：簇网格摆放，簇内概念流式网格；坐标全部解析算出，无需 DOM 实测 ----------
// v7.1a 起拆两层：_continentLayoutGrid 管一块内怎么摆（蛇形网格，块=海域或散岛群），
// _continentRegionLayout 管块与块怎么摆（跨海域亲缘排序）。无海域时走旧单网格路径
// （行为与 v6 完全一致，不引入回归）。
// 测量一座岛的占地：v7.3 起吃两个折叠口径——collapsed（整岛收起只留岛牌）与
// cardCap（岛内只画前 N 张 +「另有 k 张」，显示层折叠、不删数据）
function _continentMeasure(c, collapsed, cardCap) {
  if (collapsed) {
    return {
      cluster: c, cols: 0, rows: 0, collapsed: true, shown: 0,
      w: CONTINENT_PAD * 2 + 300,
      h: 14 + CONTINENT_HEADER_H + 10,
    };
  }
  const all = (c.items || []);
  const shown = cardCap ? Math.min(all.length, cardCap) : all.length;
  const n = Math.max(1, shown);
  const cols = Math.min(CONTINENT_COLS, n);
  const rows = Math.ceil(n / cols);
  return {
    cluster: c, cols: cols, rows: rows, collapsed: false, shown: shown,
    w: Math.max(
      CONTINENT_PAD * 2 + cols * CONTINENT_NODE_W + (cols - 1) * CONTINENT_GAP,
      CONTINENT_ISLAND_MIN_W),
    h: CONTINENT_PAD * 2 + CONTINENT_HEADER_H + rows * CONTINENT_NODE_H + (rows - 1) * CONTINENT_GAP,
  };
}

// v8.3：相邻两组（列与列、行与行）之间的间距，按跨组岛对的亲缘强度分级。
// 返回长度 = 组数-1 的间距数组；组数 <2（单列/单行）或没有亲缘数据 → null，
// 调用方回落定值 CONTINENT_CLUSTER_GAP，**逐字节旧行为**。
//
// **取最大值而不是平均值**（试过平均，被数据教育了）：一条 3 列的边界上跨列岛对是
// 3×3 = 9 对，而贪心链式排序只保证**链上相邻**的两座岛亲缘——落到这条边界上的往往
// 只有 1 对。取平均等于把这个信号摊薄 9 倍，raw 只差 2px，肉眼根本看不出来（实测：
// 强亲缘 3 分的边界算出来 150 vs 150，等于没分级）。取最大值读作「这条边界上存在
// 跨组联系 → 两组是一个邻域 → 拉近」，语义也更贴产品主张。代价是列里混进一座无关岛
// 也会被带着靠拢——但列本来就是布局产物，链式排序已经把它们归堆了，可以接受。
//
// **再中心化是这条的生死线**：raw 的均值不一定是 base，直接用会让总宽时大时小——
// 世界一变大，适配 zoom 就被压小，跌过世界档阈值（v8.1 时是 0.55，v8.7 已降到 0.35）
// 会把所有概念卡整档 display:none，真机旅程当场断（v8.1 踩过一次，10/10 → 8/10）。
// 这里把每段间距减去「相对均值的偏移」，均值恰回 base：
// Σ间距 = (组数-1) × base，与定值布局**逐字节相等**，zoom/LOD/适配全部不受影响。
// 钳位只是防御：raw ∈ [100,150]、base=150，|偏移| ≤ 50 → final ∈ [100,200]，
// 实际永不触发（全体同值时偏移恒为 0），所以钳了也不破坏均值守恒。
function _continentKinGaps(groups, kin, base, min, max) {
  const n = (groups || []).length;
  if (n < 2 || !kin) return null;
  const lo = min === undefined ? CONTINENT_GAP_MIN : min;
  const hi = max === undefined ? CONTINENT_GAP_MAX : max;
  const raw = [];
  for (let b = 0; b < n - 1; b++) {
    let peak = 0;
    for (const sa of groups[b] || []) {
      for (const sb of groups[b + 1] || []) {
        const w = kin[_continentKinshipKey(sa, sb)] || 0;
        if (w > peak) peak = w;
      }
    }
    raw.push(base - (base - lo) * Math.min(1, peak / CONTINENT_GAP_KIN_FULL));
  }
  const mean = raw.reduce((s, g) => s + g, 0) / raw.length;
  return raw.map(g => Math.max(lo, Math.min(hi, base + (g - mean))));
}

// 一块内的岛摆进蛇形网格（列宽/行高统计与落位共用同一个 gridPos 映射——两处各写
// 一份会出现「岛摆进没按它撑宽的列」）。origin 是这块在世界里的左上角；items 按
// 测量时的折叠口径裁剪（岛内只画前 cardCap 张——显示层折叠，锚点卡是最早学的、必在前 N 张内）
// kin（v8.3，可选）：亲缘矩阵。给了就按亲缘强度给列间距/行间距分级（见
// _continentKinGaps）；不给、或亲缘表为空 → **定值 CONTINENT_CLUSTER_GAP，逐字节旧行为**。
// v5.2 那条拍板在这里**升级**了：共享的不再只是 gridPos 映射，还有 colGap/rowGap
// 两个数组——统计（colX/rowY/innerW）与落位（x/y）都只准读它们，否则会复现 v5.2 那个
// 「岛摆进没按它撑宽的列」的老 bug 变体。
function _continentLayoutGrid(measured, originX, originY, kin) {
  const placements = {};
  const clusterRects = [];
  const cols = Math.max(1, Math.ceil(Math.sqrt(measured.length)));
  const gridPos = i => {
    const ri = Math.floor(i / cols), posInRow = i % cols;
    return { ci: ri % 2 === 1 ? cols - 1 - posInRow : posInRow, ri: ri };
  };
  const colW = [], rowH = [];
  const colSids = [], rowSids = [];
  measured.forEach((m, i) => {
    const g = gridPos(i);
    colW[g.ci] = Math.max(colW[g.ci] || 0, m.w);
    rowH[g.ri] = Math.max(rowH[g.ri] || 0, m.h);
    const sid = String((m.cluster && m.cluster.sessionId) || '');
    (colSids[g.ci] = colSids[g.ci] || []).push(sid);
    (rowSids[g.ri] = rowSids[g.ri] || []).push(sid);
  });
  // 列间距/行间距（v8.3）：长度 = 列数-1 / 行数-1。拿不到分级时**显式填回定值数组**
  // （不能只填空数组——innerW 靠 sum(间距) 算，漏掉定值会让世界算小、罩不住岛）
  const fixedGaps = n => { const a = []; for (let i = 0; i < n - 1; i++) a.push(CONTINENT_CLUSTER_GAP); return a; };
  const colGap = _continentKinGaps(colSids, kin, CONTINENT_CLUSTER_GAP) || fixedGaps(colW.length);
  const rowGap = _continentKinGaps(rowSids, kin, CONTINENT_CLUSTER_GAP) || fixedGaps(rowH.length);
  // 两个累加器必须分开：以前列、行共用同一个 acc，worldW 实际拿到的是**行**的累加值
  // （worldW === worldH），多列布局下世界宽度被算小 → 适配画布按假宽度算，地图一开
  // 就被裁掉右半边（真机截图才发现：岛排到 x=1628，世界却声明 674 宽）
  // 间距改数组后不能再用「accX 减一个定值 GAP」——直接按内容宽求和，最不容易错
  const colX = [], rowY = [];
  let accX = 0;
  for (let i = 0; i < colW.length; i++) { colX.push(accX); accX += colW[i] + colGap[i]; }
  let accY = 0;
  for (let i = 0; i < rowH.length; i++) { rowY.push(accY); accY += rowH[i] + rowGap[i]; }
  const innerW = Math.max(0, colW.reduce((s, w) => s + w, 0) + colGap.reduce((s, g) => s + g, 0));
  const innerH = Math.max(0, rowH.reduce((s, h) => s + h, 0) + rowGap.reduce((s, g) => s + g, 0));
  measured.forEach((m, i) => {
    const g = gridPos(i);
    const x = originX + colX[g.ci] + (colW[g.ci] - m.w) / 2;
    const y = originY + rowY[g.ri] + (rowH[g.ri] - m.h) / 2;
    clusterRects.push({
      sessionId: m.cluster.sessionId, title: m.cluster.title || '',
      x: x, y: y, w: m.w, h: m.h, cx: x + m.w / 2, cy: y + m.h / 2,
      itemCount: (m.cluster.items || []).length,
      shownCount: m.shown !== undefined ? m.shown : (m.cluster.items || []).length,
      collapsed: !!m.collapsed,
    });
    if (!m.collapsed) {
      // 卡网格在块内水平居中：块宽被岛牌下限撑宽时卡不歪在一边。
      // **按行各自居中**（v8.2）：末行不满时按整列宽左对齐会在岛牌右侧空出一大块
      // 缺角（5 卡岛空 206px），岛是矩形、内容却缺角，一眼就是「摆出来的」。
      // 块宽仍按满列算，**岛宽/世界尺寸/海域板/zoom 一律不动**。
      // 满行时 rowCols === cols，rowW === gridW，与旧公式逐字节一致。
      const shown = m.shown !== undefined ? m.shown : (m.cluster.items || []).length;
      const rowW = rowCols => rowCols * CONTINENT_NODE_W + (rowCols - 1) * CONTINENT_GAP;
      (m.cluster.items || []).slice(0, shown).forEach((item, j) => {
        const icol = j % m.cols, irow = Math.floor(j / m.cols);
        const inRow = Math.min(m.cols, shown - irow * m.cols);
        const nx = x + (m.w - rowW(inRow)) / 2 + icol * (CONTINENT_NODE_W + CONTINENT_GAP);
        const ny = y + CONTINENT_PAD + CONTINENT_HEADER_H + irow * (CONTINENT_NODE_H + CONTINENT_GAP);
        placements[item.itemId] = {
          x: nx, y: ny, w: CONTINENT_NODE_W, h: CONTINENT_NODE_H,
          cx: nx + CONTINENT_NODE_W / 2, cy: ny + CONTINENT_NODE_H / 2,
        };
      });
    }
  });
  return { placements: placements, clusterRects: clusterRects, w: innerW, h: innerH };
}

function _continentLayoutClusters(clusters, collapsed, cardCap, kin) {
  const collapsedSet = new Set((collapsed && collapsed.sessions) || []);
  const cap = cardCap === undefined ? CONTINENT_ISLAND_CARD_MAX : cardCap;
  const measured = (clusters || []).map(c => _continentMeasure(c, collapsedSet.has(c.sessionId), cap));
  const grid = _continentLayoutGrid(measured, CONTINENT_WORLD_MARGIN, CONTINENT_WORLD_MARGIN, kin);
  const worldW = Math.max(400, grid.w + CONTINENT_WORLD_MARGIN * 2);
  const worldH = Math.max(300, grid.h + CONTINENT_WORLD_MARGIN * 2);
  return { placements: grid.placements, clusterRects: grid.clusterRects,
           regionRects: [], worldW: worldW, worldH: worldH };
}

// 两级布局（v7.1a）：先按海域分块——块内岛走既有亲缘排序 + 蛇形填充；块间按
// 「跨海域亲缘总和」降序（并列按海域名稳定序，散岛块永居末位）排进块级网格，
// 间距用更大的 REGION_GAP。海域板 = 块内岛矩形并集外扩（顶部多留一行给海域牌）。
// worldW/H 必须罩住**海域板**（板比岛并集大一圈）——否则边缘板上的城市会被
// 判「出界」折叠。
function _continentRegionLayout(regions, bySid, clusters, shared, userEdges, collapsed) {
  const collapsedSet = new Set((collapsed && collapsed.sessions) || []);
  const collapsedRegions = new Set((collapsed && collapsed.regions) || []);
  const cap = CONTINENT_ISLAND_CARD_MAX;
  const byKey = {};
  (clusters || []).forEach(c => {
    const sid = String(c.sessionId || '');
    const info = bySid[sid] || {};
    const key = info.key || '';
    (byKey[key] = byKey[key] || []).push(c);
  });
  // 块定义：每片海域一块（板），单岛领域 + 中性 + 待确认合成一块「散岛」（无板）；
  // 收起的海域整块收成一枚印章（岛不占位不渲染），展开回来布局不变（确定性）
  const blocks = [];
  regions.forEach(r => blocks.push({ key: r.key, name: r.name, plate: true,
    stamp: collapsedRegions.has(r.key), clusters: byKey[r.key] || [] }));
  const loose = [];
  Object.keys(byKey).forEach(key => {
    if (!key) { loose.push.apply(loose, byKey[key]); return; }
    const inRegion = regions.some(r => r.key === key);
    if (!inRegion) loose.push.apply(loose, byKey[key]); // 单岛领域：不上板，进散岛块
  });
  if (loose.length) blocks.push({ key: '', name: '', plate: false, stamp: false, clusters: loose });

  // 块内亲缘排序（复用 v5.2 的贪心链式）；块间按跨块亲缘总和排序。
  // 收起的海域整块收成**一枚**印章（岛不占位不渲染）——多枚印章叠着看全局
  const laid = blocks.map(b => {
    // 排序**刻意不共用**下面的全局 kin：贪心链的并列裁决看 total[sid]，块内表只含
    // 同块权重、全局表还含跨海域权重，换成全局会改掉既有的岛序（v5.2 冻结契约）。
    // 间距分级用全局表没问题——它对同块内的取值与块内表逐字节相同。
    const ordered = _continentClusterOrder(b.clusters, shared, userEdges);
    const measured = b.stamp
      ? [{ cluster: ordered[0] || { sessionId: '', items: [] }, stamp: true,
          w: 190, h: 48, shown: 0, collapsed: true }]
      : ordered.map(c => _continentMeasure(c, collapsedSet.has(c.sessionId), cap));
    return { block: b, measured: measured, sids: ordered.map(c => String(c.sessionId || '')) };
  });
  const allSids = (clusters || []).map(c => String(c.sessionId || ''));
  const kin = _continentKinship(allSids, shared, userEdges);
  const crossKin = {};
  laid.forEach(a => laid.forEach(b => {
    if (a === b) return;
    a.sids.forEach(sa => b.sids.forEach(sb => {
      const w = kin[_continentKinshipKey(sa, sb)] || 0;
      if (w) crossKin[a.block.key + '\u0000' + b.block.key] =
        (crossKin[a.block.key + '\u0000' + b.block.key] || 0) + w;
    }));
  }));
  const blockWeight = key => {
    let sum = 0;
    Object.keys(crossKin).forEach(pairKey => {
      const parts = pairKey.split('\u0000');
      if (parts[0] === key || parts[1] === key) sum += crossKin[pairKey];
    });
    return sum;
  };
  laid.sort((a, b) => {
    const ka = a.block.plate ? blockWeight(a.block.key) : -1;
    const kb = b.block.plate ? blockWeight(b.block.key) : -1;
    if (ka !== kb) return kb - ka;
    if (a.block.plate && b.block.plate) return String(a.block.name).localeCompare(String(b.block.name), 'zh');
    return a.block.plate ? -1 : 1;  // 散岛块永居末位（无板无名，不参与海域排序）
  });

  // 块级网格：与岛级同一套 colW/rowH 逻辑，间距换 REGION_GAP；先按内容尺寸摆好块，
  // 再在块内部按「板框 = 内容外扩」重排——板的 padding 计入块尺寸，岛内相对坐标不变
  const cols = Math.max(1, Math.ceil(Math.sqrt(laid.length)));
  const blockW = [], blockH = [];
  laid.forEach(l => {
    // 探针与落位（下面 :590 那次）**必须喂同一份 kin**，否则板尺寸按一套间距算、
    // 岛坐标按另一套摆，岛会捅出板。v8.3 的间距分级让这条从「无所谓」变成硬约束。
    const grid = _continentLayoutGrid(l.measured, 0, 0, kin);
    l.grid = grid;
    l.paddedW = grid.w + (l.block.plate ? CONTINENT_REGION_PAD * 2 : 0);
    l.paddedH = grid.h + (l.block.plate ? CONTINENT_REGION_PAD * 2 + CONTINENT_REGION_HEADER_H : 0);
  });
  const gridPos = i => {
    const ri = Math.floor(i / cols), posInRow = i % cols;
    return { ci: ri % 2 === 1 ? cols - 1 - posInRow : posInRow, ri: ri };
  };
  laid.forEach((l, i) => {
    const g = gridPos(i);
    blockW[g.ci] = Math.max(blockW[g.ci] || 0, l.paddedW);
    blockH[g.ri] = Math.max(blockH[g.ri] || 0, l.paddedH);
  });
  const colX = [], rowY = [];
  let accX = CONTINENT_WORLD_MARGIN;
  for (let i = 0; i < blockW.length; i++) { colX.push(accX); accX += blockW[i] + CONTINENT_REGION_GAP; }
  let accY = CONTINENT_WORLD_MARGIN;
  for (let i = 0; i < blockH.length; i++) { rowY.push(accY); accY += blockH[i] + CONTINENT_REGION_GAP; }

  const placements = {};
  const clusterRects = [];
  const regionRects = [];
  laid.forEach((l, i) => {
    const g = gridPos(i);
    const bx = colX[g.ci] + (blockW[g.ci] - l.paddedW) / 2;
    const by = rowY[g.ri] + (blockH[g.ri] - l.paddedH) / 2;
    const originX = bx + (l.block.plate ? CONTINENT_REGION_PAD : 0);
    const originY = by + (l.block.plate ? CONTINENT_REGION_PAD + CONTINENT_REGION_HEADER_H : 0);
    const grid = _continentLayoutGrid(l.measured, originX, originY, kin);
    Object.assign(placements, grid.placements);
    // 收起成印章的海域：岛不渲染（clusterRects 不进），板自己就是那枚印章
    if (!l.block.stamp) clusterRects.push.apply(clusterRects, grid.clusterRects);
    if (l.block.plate) {
      regionRects.push({
        key: l.block.key, x: bx, y: by, w: l.paddedW, h: l.paddedH,
        cx: bx + l.paddedW / 2, cy: by + l.paddedH / 2,
        stamp: !!l.block.stamp,
      });
    }
  });
  const worldW = Math.max(400, accX - CONTINENT_REGION_GAP + CONTINENT_WORLD_MARGIN);
  const worldH = Math.max(300, accY - CONTINENT_REGION_GAP + CONTINENT_WORLD_MARGIN);
  return { placements: placements, clusterRects: clusterRects,
           regionRects: regionRects, worldW: worldW, worldH: worldH };
}

// ---------- v8.1 有机抖动层 ----------
// 铁律：**只从 _continentRender 调用，绝不塞进 _continentLayoutClusters /
// _continentRegionLayout**。那两个纯函数是 smoke 直接调、逐字节断言返回值的冻结
// 契约（3 卡岛宽 === 536、1 卡岛宽 >= 240、卡在块内居中、世界罩住岛、两次输出
// 逐字节一致）。抖动一旦混进去，上述断言当场红——这条不许回退。
//
// 偏移按层级**复合**：卡的世界坐标 = 原坐标 + 海域偏移 + 岛偏移 + 卡偏移。
// 所以板跟着岛一起平移、岛带着卡一起平移，板内岛、岛内卡永远不会错位。
// 海域板另外按 CONTINENT_JITTER_ISLAND 四周外扩——板比它的岛大一圈，岛不会
// 捅出海岸线（smoke「岛完整落在板内」这条就是钉这个的）。
//
// **世界尺寸一个像素都不许长**（v8.1 的第二版口径，踩过坑）：布局四周本来就留了
// CONTINENT_WORLD_MARGIN = 60 的白边，抖动的最大外伸必须**装进这 60px 里**，所以
// worldW/worldH 原样透传。注意海域板自己还要按 CONTINENT_JITTER_ISLAND 外扩，
// 所以预算是 **JITTER_REGION + JITTER_ISLAND ≤ 60**（v8.5：12 + 40 = 52），
// 不是三段相加——卡不外扩板，不进这条。
// 为什么这么较真：世界一大，适配画布的 zoom 就被压小，一压小就跌过世界档阈值
// （v8.5 时是 0.55，v8.7 已降到 0.35），世界档会把所有概念卡整档 display:none——
// 「开图点得到卡」的真机旅程当场断（第一版给四周各留 80px，continent_regression
// 从 10/10 掉到 8/10 就是这么掉的）。世界尺寸不变 = zoom、LOD、适配全部逐字节不变。

// 确定性伪随机源：FNV-1a 32 位哈希 → [-1,1]。绝不用 Math.random()——那会让位置
// 每次刷新都跳，也直接违反布局确定性契约。同一 ID 永远得到同一偏移。
function _continentJitter1(key, salt) {
  const s = String(key == null ? '' : key) + '' + salt;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h / 4294967296) * 2 - 1;
}

// 取某个 key 的两轴偏移：盐不同 → 同一个 key 的 x/y 互不相关，不会走出对角线
// **盐必须把差异放在靠前的位置、后面还跟几个字符**（v8.5 踩过的坑，v8.4 已记过一次）：
// 盐是拼在 key **末尾**的，而 FNV-1a 是逐字节左到右推进的 —— 两个盐若只差末字符
// （'x' vs 'y'、'wx' vs 'wy'），差异之后只再乘一轮素数，输出几乎不动。
// 实测现役盐 'x'/'y' 的 x、y 分量**相关系数 0.97**：位移几乎全部沿 45° 对角线走，
// 整张图读成「整体往右下斜滑了一截」，而不是各向散开。smoke 原来那条
// 「两轴同值（会走对角线）」只查了 x !== y 这种精确不等，**根本没测出这件事**。
// 换成差异在第 0 位、后面跟 3 个字符的 'x-off'/'y-off' 后降到 0.07。
function _continentJitterOffset(key, amp) {
  if (!amp) return { x: 0, y: 0 };
  return { x: _continentJitter1(key, 'x-off') * amp, y: _continentJitter1(key, 'y-off') * amp };
}

// ---------- v8.5 低频位移场：世界坐标 → 平滑标量场 ----------
// 确定性 value noise：把世界切成 cell 大小的格，格点值用**同一个** FNV-1a 哈希派生
// （确定性白拿，格点值域 [-1,1]），格内双线性插值并对插值系数过 smoothstep。
//
// **为什么是 smoothstep 而不是线性插值**：线性插值在格边处一阶导数跳变，位移场会
// 在每条格线上留下一道折痕（放大看是规则斜纹，正是要消灭的「整齐」）。smoothstep
// 3t²-2t³ 的导数在两端归零，场处处 C¹，弯出来的曲线才真的没有折角。
//
// **梯度上界（可证的，不是调出来的）**：∂f/∂x 只经由 smoothstep 的导数 6t(1-t)
// （t=0.5 处取 1.5）进入，而格点值域是 [-1,1]、**差值可到 2**，所以
// 单八度 |∇n| ≤ 2×1.5/cell = **3/cell**。
// （第一版这里写成 1.5/cell，是把「值域半幅 1」当成了「差值上界」——实测最坏
// 0.00486 vs 该式的 0.00268，正好差 2 倍。数字是量出来的，别再手推。）
function _continentWarp1(x, y, cell, salt) {
  const gx = x / cell, gy = y / cell;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const fx = gx - ix, fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const v00 = _continentJitter1(ix + ',' + iy, salt);
  const v10 = _continentJitter1((ix + 1) + ',' + iy, salt);
  const v01 = _continentJitter1(ix + ',' + (iy + 1), salt);
  const v11 = _continentJitter1((ix + 1) + ',' + (iy + 1), salt);
  return (v00 + (v10 - v00) * sx) * (1 - sy) + (v01 + (v11 - v01) * sx) * sy;
}

// 两轴位移。x/y 用互不相干的盐（'x-warp'/'y-warp'、'x-warp2'/'y-warp2'），**盐的差异
// 必须在靠前位置**——见 _continentJitterOffset 上方那段：第一版用 'wx'/'wy'（只差末字符），
// 实测两轴相关系数 0.98，场整体沿对角线推，等于白费。改成 0.036。
//
// **WARP_NORM 这个 1/√2 不是凑的，是补一个真实的漏洞**：两个八度权重和为 1，所以
// **逐轴** |分量| ≤ amp，但 x 与 y 是两个独立场，二维模长的上界是逐轴的 √2 倍。
// 不归一化就会实测到 max|offset| = 1.26×amp——而上面「间距 100 - 2×44 仍隔 12px」
// 与「外伸装进 60px 白边」两条硬约束全是按 2×amp 推的，不归一化等于**按错的数
// 算预算**。除掉 √2 之后 |offset| ≤ amp 严格成立（无 clamp、不引入折角），
// 两条约束的推导才站得住。实测复核：max|offset|/amp ≤ 1。
function _continentWarpOffset(x, y, amp) {
  if (!amp) return { x: 0, y: 0 };
  const n = CONTINENT_WARP_NORM;
  return {
    x: amp * n * (CONTINENT_WARP_W_COARSE * _continentWarp1(x, y, CONTINENT_WARP_CELL_COARSE, 'x-warp')
                + CONTINENT_WARP_W_FINE * _continentWarp1(x, y, CONTINENT_WARP_CELL_FINE, 'x-warp2')),
    y: amp * n * (CONTINENT_WARP_W_COARSE * _continentWarp1(x, y, CONTINENT_WARP_CELL_COARSE, 'y-warp')
                + CONTINENT_WARP_W_FINE * _continentWarp1(x, y, CONTINENT_WARP_CELL_FINE, 'y-warp2')),
  };
}

// ---------- v8.4 海岸线：每块地自己的圆角 ----------
// 动的是 **border-radius 一个属性**，位置/尺寸/worldW/worldH 一个像素都不碰——所以
// 下面所有冻结布局断言（3 卡岛宽===536、世界罩住、两次逐字节一致）全都不受影响。
// 写法：8 值椭圆角（4 个横半径 / 4 个竖半径，序 左上·右上·右下·左下），
// 每个都是 calc(var(--r-xl) * 系数) 而不是裸 px——基准圆角仍走令牌，将来改
// --r-xl 时海岸线跟着一起变，不会漂成一个写死的数字。CSS 变量名带 --r- 前缀是因为
// smoke 的设计尺子只放行 var(--r-*) 开头的圆角值。
// 为什么顶角小于底角：板头文字在 top:8（海域）/top:9（岛）、left:22/10，顶角太大
// 曲线会啃到第一个字；底角没有文字，让它放开才像岸、不像被啃过的方块。
const CONTINENT_COAST_TOP_LO = 0.5;
const CONTINENT_COAST_TOP_HI_ISLAND = 1.35;   // 顶角封顶：护住岛牌那行字
const CONTINENT_COAST_TOP_HI_REGION = 1.7;    // 海域板头 left:22，可以宽松些
const CONTINENT_COAST_BOT_LO = 0.8;
const CONTINENT_COAST_BOT_HI_ISLAND = 2.2;
const CONTINENT_COAST_BOT_HI_REGION = 2.6;
const CONTINENT_COAST_ASPECT = 0.42;          // 竖半径 = 横半径 × [0.58, 1]：斜角才不像同一个模子

// 盐必须是**词**、不能是 'ch0'/'ch1' 这种只差末字符的编号：FNV-1a 是逐字节左到右
// 推进的，末字节差 1 之后只再乘一轮素数，输出几乎不动。实测 400 个真实 sessionId：
// 编号盐下相邻两角系数平均只差 0.013（满量程 2.0，四角等于没抖、还是左右对称），
// 换成 coast-tl/tr/br/bl + h/v 词盐后是 0.66。这条不许回退成编号盐。
const CONTINENT_COAST_CORNER = ['coast-tl', 'coast-tr', 'coast-br', 'coast-bl'];

// 短边装不下的角**不用自己夹**：CSS 规范规定同一盒子上所有圆角在超出边长时按同一
// 系数等比缩小，所以「收成印章的小方块」和 3×3 大岛都自动收敛，不会切出方块。
function _continentCoast(key, kind) {
  if (_continentStyleMode() === CONTINENT_STYLE_GRID) return '';   // 网格态回落到 --r-xl，逐像素等于今天
  const isRegion = kind === 'region';
  const k = String(key == null ? '' : key) + '|' + kind;  // key 也进哈希：两座岛不会长成一个形状
  const hs = [], vs = [];
  for (let i = 0; i < 4; i++) {
    const top = i < 2;
    const lo = top ? CONTINENT_COAST_TOP_LO : CONTINENT_COAST_BOT_LO;
    const hi = top
      ? (isRegion ? CONTINENT_COAST_TOP_HI_REGION : CONTINENT_COAST_TOP_HI_ISLAND)
      : (isRegion ? CONTINENT_COAST_BOT_HI_REGION : CONTINENT_COAST_BOT_HI_ISLAND);
    const m = lo + (hi - lo) * (_continentJitter1(k, CONTINENT_COAST_CORNER[i] + '-h') * 0.5 + 0.5);
    const v = m * (1 - CONTINENT_COAST_ASPECT * (_continentJitter1(k, CONTINENT_COAST_CORNER[i] + '-v') * 0.5 + 0.5));
    hs.push('calc(var(--r-xl) * ' + m.toFixed(2) + ')');
    vs.push('calc(var(--r-xl) * ' + v.toFixed(2) + ')');
  }
  return hs.join(' ') + ' / ' + vs.join(' ');
}

// 有机/网格开关（渲染层偏好，非会话键：换会话不该换画风）
function _continentStyleMode() {
  try {
    const v = localStorage.getItem(CONTINENT_STYLE_KEY);
    return v === CONTINENT_STYLE_GRID ? CONTINENT_STYLE_GRID : CONTINENT_STYLE_ORGANIC;
  } catch (e) { return CONTINENT_STYLE_ORGANIC; }
}

function _continentToggleStyleMode() {
  const next = _continentStyleMode() === CONTINENT_STYLE_ORGANIC
    ? CONTINENT_STYLE_GRID : CONTINENT_STYLE_ORGANIC;
  try { localStorage.setItem(CONTINENT_STYLE_KEY, next); } catch (e) { /* 容忍 */ }
  return next;
}

// 按钮文案显示**切过去会变成什么**，不是当前是什么——和「主题」钮一个口径
function _continentSyncStyleBtn() {
  const btn = document.getElementById('continentStyleBtn');
  if (!btn) return;
  const organic = _continentStyleMode() === CONTINENT_STYLE_ORGANIC;
  btn.textContent = organic ? '网格' : '有机';
  btn.classList.toggle('is-on', !organic);
  btn.title = (organic
    ? '当前：有机——岛与卡在网格里各偏一点、带厚度。点此切回整齐网格'
    : '当前：网格——整齐正交。点此切到有机画风');
}

// 有机化的纯函数：吃一份布局结果，吐一份视觉坐标全部就位的布局结果。
// grid 态原样返回输入（零偏移、零旋转、worldW/H 不变）——「关掉 = 今天的字节」。
//   layout            —— _continentLayoutClusters / _continentRegionLayout 的返回值
//   itemSession       —— {itemId: sessionId}，卡归属哪座岛（placements 里没有这字段）
//   regionOfSession   —— {sessionId: regionKey}，岛归属哪片海域
function _continentJitter(layout, itemSession, regionOfSession) {
  if (_continentStyleMode() === CONTINENT_STYLE_GRID) {
    return {
      placements: layout.placements, clusterRects: layout.clusterRects,
      regionRects: layout.regionRects || [], worldW: layout.worldW, worldH: layout.worldH,
      cardRot: {}, organic: false,
    };
  }
  // 板偏移按 key 缓存：同一片海域的所有岛必须挂在同一个 (jx,jy) 上
  // v8.5：板按**自己的板心**采样位移场。板比场粗（560）小得多，板内场近似恒定，
  // 整块一起漂——读起来像一整块地层，而不是板内每座岛各漂各的。
  const regionOff = {};
  const regionOf = regionOfSession || {};
  const regionByKey = {};
  (layout.regionRects || []).forEach(r => { regionByKey[r.key] = r; });
  const offOfRegion = key => {
    if (!regionOff[key]) {
      const r = regionByKey[key];
      // 无板的散岛块（key ''）没有板心可采，沿用白噪声：整块给一个固定偏移，
      // 反而把它和别片海域拉开距离，是想要的效果
      regionOff[key] = r
        ? _continentWarpOffset(r.cx, r.cy, CONTINENT_JITTER_REGION)
        : _continentJitterOffset('r:' + key, CONTINENT_JITTER_REGION);
    }
    return regionOff[key];
  };
  // 岛偏移按 sessionId 缓存：同一座岛的所有卡必须挂在同一个 (ix,iy) 上
  // **v8.5 的核心改动就在这一行**：偏移来自「按岛心世界坐标采样位移场」，不再是
  // 「按 sessionId 查哈希」。因为场是坐标的连续函数，相邻两座岛采样到几乎相同的
  // 值 → 它们**一起动** → 岛的栅格直线被弯成曲线（白噪声做不到这点，它让每座岛
  // 各偏各的，只把直线变成点状虚线，仍然是线）。
  // 副作用是好的：近邻位移差 ≈ 幅度×梯度×距离 很小，所以「近亲的两岛挨得近」被
  // 破坏得更少，而每座岛离自己的格点可以走得更远（40 > 旧的 28）——幅度更大的
  // 位移反而比旧的更安全。
  const islandOff = {};
  const rectBySid = {};
  (layout.clusterRects || []).forEach(r => { rectBySid[r.sessionId] = r; });
  const offOfIsland = sid => {
    if (!islandOff[sid]) {
      const ro = offOfRegion(regionOf[sid] || '');
      const r = rectBySid[sid];
      const w = r
        ? _continentWarpOffset(r.cx, r.cy, CONTINENT_JITTER_ISLAND)
        : _continentJitterOffset('i:' + sid, CONTINENT_JITTER_ISLAND);
      // 掺 2px 白噪声：保证没有哪座岛恰好停在格点上（smoke 钉「每个岛都被抖动」）
      const io = _continentJitterOffset('i:' + sid, CONTINENT_JITTER_ISLAND_WHITE);
      islandOff[sid] = { x: ro.x + w.x + io.x, y: ro.y + w.y + io.y };
    }
    return islandOff[sid];
  };

  const clusterRects = (layout.clusterRects || []).map(r => {
    const o = offOfIsland(r.sessionId);
    return Object.assign({}, r, {
      x: r.x + o.x, y: r.y + o.y, cx: r.cx + o.x, cy: r.cy + o.y,
    });
  });
  // 板：平移自己的偏移，再按岛幅度四周外扩（印章态是单枚徽标，同样外扩不亏）
  const regionRects = (layout.regionRects || []).map(r => {
    const o = offOfRegion(r.key);
    const pad = CONTINENT_JITTER_ISLAND;
    return Object.assign({}, r, {
      x: r.x + o.x - pad, y: r.y + o.y - pad,
      w: r.w + pad * 2, h: r.h + pad * 2,
      cx: r.cx + o.x, cy: r.cy + o.y,
    });
  });
  // 卡：板 + 岛 + 自己的微偏移；旋转角另外走 CSS（--jr），数值里表达不了
  const placements = {};
  const cardRot = {};
  const owner = itemSession || {};
  Object.keys(layout.placements || {}).forEach(itemId => {
    const p = layout.placements[itemId];
    const io = offOfIsland(owner[itemId] || '');
    const co = _continentJitterOffset('c:' + itemId, CONTINENT_JITTER_CARD);
    placements[itemId] = {
      x: p.x + io.x + co.x, y: p.y + io.y + co.y,
      w: p.w, h: p.h,
      cx: p.cx + io.x + co.x, cy: p.cy + io.y + co.y,
    };
    cardRot[itemId] = _continentJitter1('c:' + itemId, 'rot-2') * CONTINENT_JITTER_ROT;
  });
  return {
    placements: placements, clusterRects: clusterRects, regionRects: regionRects,
    worldW: layout.worldW, worldH: layout.worldH,   // 见上：世界不许长大
    cardRot: cardRot, organic: true,
  };
}

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
        '<button class="continent-tool" id="continentLinkBtn" title="连接两个不同区域的概念（画一条大陆边）">连接</button>' +
        // v8.1 画风开关：有机（岛在网格里各偏一点、有厚度）↔ 网格（回到整齐的正交布局）。
        // 位置本身带信息（相邻=有亲缘），两种画风改的只是视觉密度，不改谁挨着谁。
        '<button class="continent-tool is-quiet" id="continentStyleBtn" title="画风：有机（岛与卡在网格里各偏一点，有厚度）↔ 网格（整齐正交）。两种画风的亲缘排序完全相同，只改视觉">有机</button>' +
        '<button class="continent-tool is-quiet" id="continentGateBtn" hidden title="让 Φ 读卡片内容做领域归类（词面认不出的它来补；打开大陆本身不烧调用，点了才跑）">Φ 归类</button>' +
        '<button class="continent-tool is-quiet" id="continentRouteBtn" hidden title="航线的全局显示（总开关 / 透明度）；单条样式点线本身调">航线</button>' +
        '<button class="continent-tool is-quiet" id="continentFamilyBtn" title="概念族表（❖ 城市与海域的证据来源）：可加族、改词条、删自定义族；也管归类纠正记录">族表</button>' +
        '<button class="continent-tool is-quiet" id="continentWeakBtn" title="没画到地图上的共享点（弱证据 / 超上限 / 无位可放）：照报，可逐条确认落笔" hidden>折叠 0 条</button>' +
        '<button class="continent-tool" id="continentUndoBtn" title="撤销上一条边操作 (Ctrl+Z)" hidden>↩ 撤销</button>' +
        '<button class="continent-tool is-warn" id="continentCleanBtn" title="移除一端已不在大陆上的连线" hidden>清理断线</button>' +
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
  // v8：族表编辑入口（❖ 城市与海域证据的来源 + 纠正记录清空）
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

// ---------- v4/v5.1 画什么：城市选位 + 每对区域上限 + 折叠原因（纯函数，无 DOM 实测） ----------
// 一枚城市 = 一条跨 ≥2 画布的共享概念（同词跨 N 会话仍是一枚，不是每条链路一枚）。
// v4 的「弧线 + 浮空标签」在 v5.1 整体退役：共享概念升级为岛与岛之间的**城市节点**，
// 每座岛伸一根辐条连到该岛的代表卡；摆不下（撞岛 / 撞别的城）就进折叠清单（原因
// 「无位可放」）——绝不叠在别的岛上。弱证据照旧不上图，只进清单。
function _continentLinkMid(a, b) {
  // 二次贝塞尔（控制点上抬 lift）上 t=0.5 的点：与连线绘制同一公式，标签才落在弧上
  const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  const len = Math.max(1, Math.hypot(dx, dy));
  const lift = Math.min(60, len * 0.14);
  const qx = mx + (-dy / len) * lift, qy = my + (dx / len) * lift;
  return { x: (a.cx + 2 * qx + b.cx) / 4, y: (a.cy + 2 * qy + b.cy) / 4, qx, qy };
}

// ---------- v7.2 航线走线（纯函数，无 DOM）：端点从岛框出发，永不穿过岛内部 ----------
// 旧版大陆边直接连两张卡的**中心**（二次贝塞尔），线必然穿过岛内部与中间的岛
// （岛底色 7% 透明度，线全透出来）——几何上的必然，不是审美问题。v7.2 起端点升级
// 为岛框边缘，走线三档：straight 直连 / detour 绕行（默认：撞岛就把控制点垂直推开，
// 最多 3 次，取首个不撞）/ lane 沿世界边缘车道（逃生档）。

// 从 rect 边缘朝目标方向出框的点（线从岛「边上」走，不从岛「心里」穿）
function _continentBorderPoint(rect, towardX, towardY) {
  const cx = Number(rect.cx), cy = Number(rect.cy);
  const dx = Number(towardX) - cx, dy = Number(towardY) - cy;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return { x: cx, y: cy };
  }
  const scaleX = dx !== 0 ? (rect.w / 2) / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? (rect.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(scaleX, scaleY);
  return { x: cx + dx * t, y: cy + dy * t };
}

// 二次贝塞尔采样撞岛检测（端点在岛框上、不算撞自己；采样点在矩形内即撞）
function _continentBezierHits(p0, q, p2, rects, samples) {
  return _continentBezierHitCount(p0, q, p2, rects, samples) > 0;
}

// 撞点计数（绕行两侧都撞时，取撞得最少的那条兜底）
function _continentBezierHitCount(p0, q, p2, rects, samples) {
  const n = samples || 14;
  let hits = 0;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * q.x + t * t * p2.x;
    const y = (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * q.y + t * t * p2.y;
    for (let k = 0; k < (rects || []).length; k++) {
      const r = rects[k];
      if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hits++; break; }
    }
  }
  return hits;
}

// 车道走线（沿世界边缘）：四个方向的车道 × 两种入线（从端点直插车道 / 先出岛框再
// 上车道），采样数撞点取最优——单条固定车道会被「入线段横穿同排岛」坑（真机验收
// 抓过：恒定 y 的水平段连穿 4 座岛）
function _continentLaneRoute(a, b, pA, pB, rects, world) {
  const segHits = (from, to) => {
    let hits = 0;
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      for (let k = 0; k < (rects || []).length; k++) {
        const r = rects[k];
        if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hits++; break; }
      }
    }
    return hits;
  };
  const aRect = { x: a.x, y: a.y, w: a.w, h: a.h, cx: a.cx, cy: a.cy };
  const bRect = { x: b.x, y: b.y, w: b.w, h: b.h, cx: b.cx, cy: b.cy };
  const margin = 26;
  const lanes = [
    { vertical: true, coord: world.x + margin },
    { vertical: true, coord: world.x + world.w - margin },
    { vertical: false, coord: world.y + margin },
    { vertical: false, coord: world.y + world.h - margin },
  ];
  let best = null, bestHits = Infinity;
  lanes.forEach(lane => {
    const candidates = [];
    const entryA = lane.vertical ? { x: lane.coord, y: pA.y } : { x: pA.x, y: lane.coord };
    const entryB = lane.vertical ? { x: lane.coord, y: pB.y } : { x: pB.x, y: lane.coord };
    candidates.push([pA, entryA, entryB, pB]);
    // 先出岛框再上车道：入线沿车道法线方向，避开从岛间走廊斜插
    const exitA = lane.vertical
      ? _continentBorderPoint(aRect, lane.coord, aRect.cy)
      : _continentBorderPoint(aRect, aRect.cx, lane.coord);
    const exitB = lane.vertical
      ? _continentBorderPoint(bRect, lane.coord, bRect.cy)
      : _continentBorderPoint(bRect, bRect.cx, lane.coord);
    const entryA2 = lane.vertical ? { x: lane.coord, y: exitA.y } : { x: exitA.x, y: lane.coord };
    const entryB2 = lane.vertical ? { x: lane.coord, y: exitB.y } : { x: exitB.x, y: lane.coord };
    candidates.push([exitA, entryA2, entryB2, exitB]);
    candidates.forEach(pts => {
      const hits = segHits(pts[0], pts[1]) + segHits(pts[1], pts[2]) + segHits(pts[2], pts[3]);
      if (hits < bestHits) { bestHits = hits; best = pts; }
    });
  });
  if (!best) return null;
  return {
    d: 'M ' + best[0].x + ' ' + best[0].y + ' L ' + best[1].x + ' ' + best[1].y +
       ' L ' + best[2].x + ' ' + best[2].y + ' L ' + best[3].x + ' ' + best[3].y,
    mid: { x: (best[1].x + best[2].x) / 2, y: (best[1].y + best[2].y) / 2 },
    mode: 'lane', p0: best[0], p1: best[1], p2: best[2], p3: best[3],
    hits: bestHits,
  };
}

// 主走线函数：返回 {d, mid, mode, p0, p1, p2, q}。mid 是标签落点（贝塞尔 t=0.5 或
// 车道中点），带 finite 兜底——给 DOM 写 'px' 的落点必须是有限数，NaN 是静默失败
// （v2 的老账：arc.qx undefined → NaNpx → 标签飘到世界层左上角）。
function _continentRoute(a, b, obstacles, mode, world) {
  const rects = (obstacles || []).filter(r => r && r !== a && r !== b);
  const ax = Number.isFinite(a.cx) ? a.cx : 0, ay = Number.isFinite(a.cy) ? a.cy : 0;
  const bx = Number.isFinite(b.cx) ? b.cx : 0, by = Number.isFinite(b.cy) ? b.cy : 0;
  const aRect = { x: a.x, y: a.y, w: a.w, h: a.h, cx: ax, cy: ay };
  const bRect = { x: b.x, y: b.y, w: b.w, h: b.h, cx: bx, cy: by };
  const pA = _continentBorderPoint(aRect, bx, by);
  const pB = _continentBorderPoint(bRect, ax, ay);
  const modeN = mode === 'straight' || mode === 'lane' ? mode : 'detour';
  if (modeN === 'lane' && world && Number.isFinite(world.w)) {
    const lane = _continentLaneRoute(aRect, bRect, pA, pB, rects, world);
    if (lane) return lane;
  }
  const mx = (pA.x + pB.x) / 2, my = (pA.y + pB.y) / 2;
  const dx = pB.x - pA.x, dy = pB.y - pA.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = -dy / len, uy = dx / len;
  let q = { x: mx, y: my };
  if (modeN === 'detour') {
    // 绕行：垂直推开控制点——**两侧都试**（只推一侧时，另一侧恰好挡着就永远绕不
    // 出去；真机验收抓过：5 个采样点穿岛），每侧最多 3 档抬升，取首个不撞的；
    // 两侧全撞（走廊真被堵死）→ 升级沿边车道（「直达路堵了走环线」，仍不穿岛）
    const lift0 = Math.min(110, 46 + len * 0.18);
    let best = null, bestHits = Infinity;
    for (let side = 1; side >= -1; side -= 2) {
      for (let k = 1; k <= 3; k++) {
        const lift = lift0 * k * side;
        const cand = { x: mx + ux * lift, y: my + uy * lift };
        if (!_continentBezierHits(pA, cand, pB, rects)) { best = cand; bestHits = 0; break; }
        const hits = _continentBezierHitCount(pA, cand, pB, rects);
        if (hits < bestHits) { bestHits = hits; best = cand; }
      }
      if (bestHits === 0) break;
    }
    if (bestHits === 0) {
      q = best;
    } else if (world && Number.isFinite(world.w)) {
      const lane = _continentLaneRoute(aRect, bRect, pA, pB, rects, world);
      if (lane) return lane;
      q = best || { x: mx, y: my };   // world 都没有就退而求其次：撞得最少的那条弧
    } else {
      q = best || { x: mx, y: my };
    }
  }
  const fin = v => Number.isFinite(v) ? v : 0;
  const qx = (pA.x + 2 * q.x + pB.x) / 4, qy = (pA.y + 2 * q.y + pB.y) / 4;
  const mid = {
    x: Number.isFinite(qx) ? qx : fin(mx),
    y: Number.isFinite(qy) ? qy : fin(my),
  };
  return {
    d: 'M ' + pA.x + ' ' + pA.y + ' Q ' + q.x + ' ' + q.y + ' ' + pB.x + ' ' + pB.y,
    mid: mid, mode: modeN, p0: pA, q: q, p2: pB,
  };
}

function _continentCityBox(cx, cy) {
  return {
    x: cx - CONTINENT_CITY_W / 2, y: cy - CONTINENT_CITY_H / 2,
    w: CONTINENT_CITY_W, h: CONTINENT_CITY_H, cx: cx, cy: cy,
  };
}

// 城市候选落点：所连岛群的质心 + 每对岛的中点（两岛之间的走廊 = 首选），各带一圈
// 小偏移——走廊被占时挤一挤（同一条走廊竖着摆得下 3 座城），别动不动判「无位可放」。
function _continentCitySpots(targets) {
  const pts = (targets || []).filter(t => t && isFinite(t.cx) && isFinite(t.cy));
  if (pts.length < 2) return [];
  const seeds = [];
  let sx = 0, sy = 0;
  pts.forEach(t => { sx += t.cx; sy += t.cy; });
  seeds.push({ x: sx / pts.length, y: sy / pts.length });
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      seeds.push({ x: (pts[i].cx + pts[j].cx) / 2, y: (pts[i].cy + pts[j].cy) / 2 });
    }
  }
  const stepX = CONTINENT_CITY_W + CONTINENT_CITY_GAP;
  const stepY = CONTINENT_CITY_H + CONTINENT_CITY_GAP;
  const ring = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
                [2, 0], [-2, 0], [0, 2], [0, -2],
                [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const out = [];
  seeds.forEach(s => ring.forEach(r => {
    out.push({ x: s.x + r[0] * stepX, y: s.y + r[1] * stepY });
  }));
  return out;
}

// 世界边界（岛群包围盒 + 一个走廊宽）：城市属于「岛之间」，不许飘到地图外的荒野
function _continentWorldBounds(rects) {
  const list = (rects || []).filter(r => r && isFinite(r.x) && isFinite(r.y) && r.w > 0 && r.h > 0);
  if (!list.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  list.forEach(r => {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  });
  const pad = CONTINENT_CLUSTER_GAP;
  return { x: minX - pad, y: minY - pad,
           w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}

function _continentFits(box, obstacles, margin) {
  const m = margin || 0;
  return !(obstacles || []).some(o => o &&
    box.x - m < o.x + o.w && box.x + box.w + m > o.x &&
    box.y - m < o.y + o.h && box.y + box.h + m > o.y);
}

function _continentInside(box, bounds) {
  return box.x >= bounds.x && box.y >= bounds.y &&
    box.x + box.w <= bounds.x + bounds.w && box.y + box.h <= bounds.y + bounds.h;
}

// 城市选位：候选里挑「不撞岛、不撞别的城、留在世界内」且**离它所连的岛总距离最短**
// 的那个（辐条最短最好读）。一个都放不下 → null（调用方折叠，原因「无位可放」）。
function _continentPlaceCity(targets, obstacles, bounds) {
  const pts = (targets || []).filter(t => t && isFinite(t.cx) && isFinite(t.cy));
  if (pts.length < 2) return null;
  let best = null, bestCost = Infinity;
  _continentCitySpots(pts).forEach(spot => {
    const box = _continentCityBox(spot.x, spot.y);
    if (bounds && !_continentInside(box, bounds)) return;
    if (!_continentFits(box, obstacles, CONTINENT_CITY_GAP)) return;
    const cost = pts.reduce((acc, t) => acc + Math.hypot(t.cx - spot.x, t.cy - spot.y), 0);
    if (cost < bestCost - 1e-6) { bestCost = cost; best = box; }
  });
  return best;
}

// 折叠原因：四种都要能分辨，用户才知道该不该管它（弱证据要修标题 / 无位可放是地图太挤）
const CONTINENT_FOLD_REASON = {
  weak: '弱证据',
  covered: '已被更具体的城市覆盖',
  capped: '超出每对上限',
  map_capped: '超出全图上限',
  no_room: '无位可放',
};

function _continentDrawPlan(shared, placements, clusterRects, pairLimit, cityLimit, extraBounds) {
  const rects = clusterRects || [];
  const pairLimitN = pairLimit || CONTINENT_PAIR_CITY_LIMIT;
  const cityLimitN = cityLimit || CONTINENT_CITY_LIMIT;
  const cities = [], boundary = {}, folded = [];
  const obstacles = rects.slice();
  // v7.1a：世界边界罩住海域板（板比岛并集大一圈）——否则边缘板上的城市会被判
  // 「出界」折叠。板只进边界、不进障碍（城市可以落在板上，那本来就是它的地盘）
  const bounds = _continentWorldBounds((extraBounds && extraBounds.length ? extraBounds : []).concat(rects));
  const pairs = {};
  let spokes = 0;
  (shared || []).slice(0, CONTINENT_LINE_LIMIT).forEach(s => {
    if (s.strength === 'weak') { folded.push({ entry: s, reason: 'weak' }); return; }
    // v5.5：证据被更具体的标签完全覆盖（服务端 covered 字段）——比如 8 座岛的「能量
    // 守恒定律」+ 2 座岛的「角动量守恒定律」旁边的那个 10 岛「量守恒定律」（截断名）。
    // 它不单独成城（名字读不懂、城与城几乎重合），但照进折叠清单，也要参与摆位亲缘
    if (s.covered) { folded.push({ entry: s, reason: 'covered' }); return; }
    if (cities.length >= cityLimitN) { folded.push({ entry: s, reason: 'map_capped' }); return; }
    // 每会话一张代表卡：服务端 _links_for 已按「岛内最早学的」取端点，这里按会话去重。
    // placements 里找不到的条目跳过——投影与布局不同步时宁可不画，也不画到错地方。
    const reps = [], seen = {};
    (s.links || []).forEach(l => {
      [[l.fromSession, l.from], [l.toSession, l.to]].forEach(pair => {
        const sid = pair[0], iid = pair[1];
        if (!sid || !iid || seen[sid] || !placements[iid]) return;
        seen[sid] = true;
        reps.push({ sessionId: sid, itemId: iid });
      });
    });
    // 一栋楼要有两座以上的岛才叫边界城市（单岛共享是同岛词面重叠，服务端已经不算）
    if (reps.length < 2) { folded.push({ entry: s, reason: 'no_room' }); return; }
    const sids = reps.map(r => r.sessionId).slice().sort();
    let blocked = false;
    for (let i = 0; i < sids.length && !blocked; i++) {
      for (let j = i + 1; j < sids.length; j++) {
        if ((pairs[sids[i] + '|' + sids[j]] || 0) >= pairLimitN) { blocked = true; break; }
      }
    }
    if (blocked) { folded.push({ entry: s, reason: 'capped' }); return; }
    const targets = reps.map(r => {
      const rect = rects.find(x => x && x.sessionId === r.sessionId);
      const p = placements[r.itemId];
      return { cx: rect ? rect.cx : p.cx, cy: rect ? rect.cy : p.cy };
    });
    const box = _continentPlaceCity(targets, obstacles, bounds);
    if (!box) { folded.push({ entry: s, reason: 'no_room' }); return; }
    obstacles.push(box);
    for (let i = 0; i < sids.length; i++) {
      for (let j = i + 1; j < sids.length; j++) {
        const key = sids[i] + '|' + sids[j];
        pairs[key] = (pairs[key] || 0) + 1;
      }
    }
    spokes += reps.length;
    // 代表卡挂 ◈ 徽标（辐条一眼看得到头）；同岛的其他命中卡不挂徽标，但进重逢清单
    reps.forEach(r => { boundary[r.itemId] = s.label; });
    cities.push({ entry: s, reps: reps, total: reps.length,
                  x: box.cx, y: box.cy, box: box });
  });
  return { cities: cities, boundary: boundary, cityCount: cities.length,
           spokeCount: spokes, folded: folded };
}

function _continentRender(data) {
  const world = document.getElementById('continentWorld');
  if (!world) return null;
  world.innerHTML = '';
  // v7.1a 海域层：后端概率 + 用户覆盖（KV）→ 归属解析；有 ≥2 座岛同领域才走两级
  // 布局（海域分块），否则走 v6 旧单网格（行为不变，不引入回归）
  const regionInfo = _continentRegions(data.clusters || [], _continentRegionOverrides,
                                       data.domainList);
  _continentRegionInfo = regionInfo;
  let layout;
  if (regionInfo.regions.length) {
    // 海域路径：亲缘矩阵由它内部算（块间排序 + 块内排序 + 间距分级三处共用那一份）
    layout = _continentRegionLayout(regionInfo.regions, regionInfo.bySid,
                                    data.clusters || [], data.shared || [], data.userEdges || [],
                                    _continentCollapsed);
  } else {
    // v8.3 无海域路径：kin 只喂给「间距按亲缘分级」。排序仍按 v5.2 原样自己算一份
    // 块内表——贪心链的并列裁决看 total[sid]，换成全局表会改掉既有岛序（冻结契约），
    // 而多算一次 O(n²)（48 岛 ≈ 2300 次）不值得拿契约去换。
    const kin = _continentKinship(
      (data.clusters || []).map(c => String(c.sessionId || '')),
      data.shared || [], data.userEdges || []);
    layout = _continentLayoutClusters(
      _continentClusterOrder(data.clusters || [], data.shared || [], data.userEdges || []),
      _continentCollapsed, undefined, kin);
  }
  // v8.1：布局算完，接一层确定性抖动再渲染。这一行是「岛在板内、卡在岛内、城市与
  // 辐条不脱节、航线仍绕开中间的岛」的唯一保证——**下游一律吃抖动后的数据**，
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
  // 边界城市（v5.1）：共享概念的端点条目 → 概念名 → 共享词。只认**画到地图上**的那些
  // （强证据、没超上限、有位置）——弱证据不该把节点标成边界城市。
  // v7.1a：世界边界罩住海域板（城市不许因板外扩被判「出界」）
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
          (region.itemCount || 0) + ' 张卡</span>' +
        (rect.stamp ? '' :
          '<span class="continent-region-src">' + esc(_continentRegionSourceLabel(region.source)) + '</span>') +
      '</div>';
    const head = el.firstChild;
    if (head && head.addEventListener) {
      head.addEventListener('pointerdown', e => {
        e.stopPropagation();  // 板头是聚焦按钮，不是画布拖拽起点
        _continentToggleLegendFocus(rect.key);
      });
    }
    const fold = el.querySelector ? el.querySelector('[data-region-fold]') : null;
    if (fold) {
      fold.addEventListener('pointerdown', e => {
        e.stopPropagation();
        _continentToggleCollapse('region', rect.key);
      });
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
    const moreNote = (!rect.collapsed && hiddenCount > 0)
      ? ' · 另有 ' + hiddenCount + ' 张（收进岛里）' : '';
    let headHtml =
      '<div class="continent-cluster-head">' +
        '<span class="continent-cluster-headline">' +
          '<span class="continent-cluster-fold" data-island-fold="' + esc(rect.sessionId) + '">' +
            (rect.collapsed ? '▸' : '▾') + '</span>' +
          '<span class="continent-cluster-title">' + esc(rect.title) + '</span>' +
          '<span class="continent-cluster-count">' + rect.itemCount + ' 个概念</span>' +
        '</span>' +
        (rect.collapsed || !tagline ? '' :
          '<span class="continent-cluster-sub">' + esc(tagline) + esc(moreNote) + '</span>') +
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
          '<span class="continent-cluster-count">' + rect.itemCount + ' 个概念</span>' +
          '<button class="continent-domain-badge' + (tier === 'solid' ? '' : ' is-unsure') + '"' +
            ' data-domain-sid="' + esc(rect.sessionId) + '"' +
            ' title="这座岛归在「' + esc(badgeName) + '」——点开可改归类（写进大陆记忆，Ctrl+Z 可撤销）">' +
            esc(badgeName) + (tier === 'light' || tier === 'pending' ? ' ?' : '') +
          '</button>' + secondaryDot +
        '</span>' +
        (rect.collapsed || !tagline ? '' :
          '<span class="continent-cluster-sub">' + esc(tagline) + esc(moreNote) + '</span>') +
      '</div>';
    }
    el.innerHTML = headHtml + _continentCloudHtml(cluster, rect, tagline, esc);
    const badge = el.querySelector ? el.querySelector('.continent-domain-badge') : null;
    if (badge) {
      badge.addEventListener('pointerdown', e => {
        e.stopPropagation();  // 徽标是归类菜单入口，不进画布拖拽/下钻
        _continentDomainMenu(e, rect.sessionId);
      });
    }
    const foldBtn = el.querySelector ? el.querySelector('[data-island-fold]') : null;
    if (foldBtn) {
      foldBtn.addEventListener('pointerdown', e => {
        e.stopPropagation();
        _continentToggleCollapse('island', rect.sessionId);
      });
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
      el.title = '边界城市：其他画布也学过（共享「' + boundary[item.itemId] + '」）';
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
  // 辐条连到代表卡。点开是**重逢清单**（每座岛学过的那些卡 + 「去看」）：绝不替你猜
  // 跳哪座岛，机器猜「最近学的」总有一半时候不是你想去的。
  plan.cities.forEach(city => {
    const s = city.entry || {};
    const el = document.createElement('div');
    el.className = 'continent-city' + _continentKindClass(s.kind);
    el.dataset.cityLabel = s.label || '';
    el.dataset.citySids = city.reps.map(r => r.sessionId).join(',');  // v7.1a 图例聚焦判定用
    el.style.left = city.box.x + 'px';
    el.style.top = city.box.y + 'px';
    el.title = '边界城市：' + city.reps.length + ' 块画布都学过——点开看重逢清单';
    el.innerHTML = '<span class="continent-city-name">' +
      _continentKindPrefix(s.kind) + esc(s.label || '') + '</span>';
    el.addEventListener('pointerdown', e => {
      e.stopPropagation();  // 标签/用户边同规：不让城市点击进画布拖拽态
      _continentCityPopover(city, e);
    });
    const ends = city.reps.map(r => r.itemId);
    el.addEventListener('mouseenter', () => _continentHighlightNodes(ends, true));
    el.addEventListener('mouseleave', () => _continentHighlightNodes(ends, false));
    world.appendChild(el);
  });

  // ---------- 连线层：辐条（城市→岛）+ 我的航线（岛框→岛框，v7.2）+ 断桥 ----------
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'continent-links');
  svg.setAttribute('width', String(layout.worldW));
  svg.setAttribute('height', String(layout.worldH));

  // 辐条：城市 → 该岛代表卡。两端都被节点盖住（SVG 是世界层首个子元素，节点画在它
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

  // 我的航线（v2 落笔 / v7.2 重做）：端点从**岛框边缘**出发、绕行不穿岛——旧版连
  // 两张卡中心的弧线必然穿过岛内部与中间的岛。样式逐条可调（线型/颜色/粗细/走线/
  // 显隐/锚点卡），全局可关（数据不动）；细节档（LOD detail）才画锚点卡的虚线短接。
  // 「我画的路」观感（09-20）：与机器画的细线（辐条/断桥）拉开——核心线圆线帽 +
  // 底下垫一条宽而淡的同色光晕（路基）+ 两端在岛框外各一颗圆珠（站点）。光晕与
  // 圆珠都不接鼠标事件（命中区域与旧版一致，不会挡住附近的画布拖拽）。
  const routePrefs = _continentRoutePrefs();
  const routeThemeLight = document.documentElement &&
    document.documentElement.getAttribute('data-theme') === 'light';
  (data.userEdges || []).forEach(e => {
    const ra = layout.clusterRects.find(r => r.sessionId === e.fromSession);
    const rb = layout.clusterRects.find(r => r.sessionId === e.toSession);
    const pa = layout.placements[e.fromItem], pb = layout.placements[e.toItem];
    if (!ra || !rb) return;  // 找不到岛框的走断桥通道（下方 danglingEdges）
    if (!routePrefs.on || (e.style && e.style.hidden)) return;
    const style = e.style || {};
    const route = _continentRoute(ra, rb, layout.clusterRects, style.route || 'detour',
      { x: 0, y: 0, w: layout.worldW, h: layout.worldH });
    const stroke = _continentRouteStroke(style, e, _continentRegionInfo,
      routeThemeLight ? 'light' : 'dark');
    const sidsAttr = [e.fromSession, e.toSession].join(',');
    // 路基（光晕层）：同色、约 3 倍宽、低透明度——先画，核心线压在它上面
    const halo = document.createElementNS(svgNS, 'path');
    halo.setAttribute('class', 'continent-route-casing');
    halo.setAttribute('d', route.d);
    halo.setAttribute('stroke', stroke.color);
    halo.setAttribute('stroke-width', String(Math.max(5, stroke.width * 3)));
    halo.setAttribute('opacity', String(routePrefs.opacity));
    halo.setAttribute('data-sids', sidsAttr);
    svg.appendChild(halo);
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('class', 'continent-route');
    path.setAttribute('d', route.d);
    path.setAttribute('data-edge-id', e.id);
    path.setAttribute('data-sids', sidsAttr);
    path.setAttribute('stroke', stroke.color);
    path.setAttribute('stroke-width', String(stroke.width));
    if (stroke.dash) path.setAttribute('stroke-dasharray', stroke.dash);
    path.setAttribute('opacity', String(routePrefs.opacity));
    path.addEventListener('pointerdown', ev => {
      ev.stopPropagation();
      _continentEdgePopover(e, ev);
    });
    svg.appendChild(path);
    // 端点圆珠（站点）：摆在岛框**外侧**一点——SVG 连线层在世界层最底下，正好压在
    // 岛框边上的圆会被岛牌盖掉半截，沿「岛心→出岛点」方向外推才完整可见
    const laneMode = route.mode === 'lane' || route.mode === 'detour-lane';
    const beadR = Math.min(4.2, Math.max(2.4, stroke.width * 1.4));
    [[ra, route.p0], [rb, laneMode ? route.p3 : route.p2]].forEach(pair => {
      const rect = pair[0], pt = pair[1];
      if (!rect || !pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
      const dx = pt.x - rect.cx, dy = pt.y - rect.cy;
      const len = Math.max(1, Math.hypot(dx, dy));
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('class', 'continent-route-end');
      dot.setAttribute('cx', String(pt.x + dx / len * 3));
      dot.setAttribute('cy', String(pt.y + dy / len * 3));
      dot.setAttribute('r', String(beadR));
      dot.setAttribute('fill', stroke.color);
      dot.setAttribute('opacity', String(routePrefs.opacity));
      dot.setAttribute('data-sids', sidsAttr);
      svg.appendChild(dot);
    });
    if (e.label && !style.noLabel) {
      const label = document.createElement('div');
      label.className = 'continent-user-link-label';
      // 落点走走线产物 route.mid（finite 兜底在纯函数里）——标签必须压在线上
      label.style.left = route.mid.x + 'px';
      label.style.top = route.mid.y + 'px';
      label.textContent = e.label;
      label.title = '我的航线：' + e.label;
      label.addEventListener('pointerdown', ev => {
        ev.stopPropagation();
        _continentEdgePopover(e, ev);
      });
      world.appendChild(label);
    }
    // 锚点短接（细节档才显，CSS 管显隐）：从锚点卡到出岛点的一小段虚线——
    // 「这条线具体连哪张卡」降级为细节信息，不再穿岛去连卡片中心
    if (pa && pb) {
      [[pa, route.p0], [pb, laneMode ? route.p3 : route.p2]].forEach(pair => {
        const stub = document.createElementNS(svgNS, 'line');
        stub.setAttribute('class', 'continent-route-stub');
        stub.setAttribute('x1', String(pair[0].cx));
        stub.setAttribute('y1', String(pair[0].cy));
        stub.setAttribute('x2', String(pair[1].x));
        stub.setAttribute('y2', String(pair[1].y));
        stub.setAttribute('data-sids', [e.fromSession, e.toSession].join(','));
        svg.appendChild(stub);
      });
    }
  });

  // 断桥（v2）：一端已不在大陆上的边——从幸存端朝目标簇方向画残线，中段断开。
  // 两端都在但同会话的无效边无残线可画，只进清理清单。
  (data.danglingEdges || []).forEach(e => {
    if (e.missing === 'same_session') return;
    const anchor = e.missing === 'from' ? layout.placements[e.toItem] : layout.placements[e.fromItem];
    if (!anchor) return;
    const targetSid = e.missing === 'from' ? e.fromSession : e.toSession;
    const cluster = layout.clusterRects.find(r => r.sessionId === targetSid);
    const tx = cluster ? cluster.cx : anchor.cx + 140, ty = cluster ? cluster.cy : anchor.cy + 90;
    const dx = tx - anchor.cx, dy = ty - anchor.cy;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len, uy = dy / len;
    const seg = (t0, t1) => {
      const p = document.createElementNS(svgNS, 'path');
      p.setAttribute('class', 'continent-dangle-link');
      p.setAttribute('d', 'M ' + (anchor.cx + ux * len * t0) + ' ' + (anchor.cy + uy * len * t0) +
        ' L ' + (anchor.cx + ux * len * t1) + ' ' + (anchor.cy + uy * len * t1));
      svg.appendChild(p);
    };
    seg(0, 0.55); seg(0.68, 0.8);  // 中段留空 = 桥断了
    const mark = document.createElement('div');
    mark.className = 'continent-dangle-mark';
    mark.style.left = (anchor.cx + ux * len * 0.615) + 'px';
    mark.style.top = (anchor.cy + uy * len * 0.615) + 'px';
    mark.textContent = '✕';
    mark.title = '这条大陆边的一端已不在大陆上（画布被清空或概念被删除），可用工具条「清理断线」移除';
    world.appendChild(mark);
  });

  world.insertBefore(svg, world.firstChild);

  const mineCount = (data.userEdges || []).length;
  const stats = document.getElementById('continentStats');
  if (stats) stats.textContent =
    data.clusterCount + ' 个区域 · ' + data.itemCount + ' 个概念' +
    (regionInfo.regions.length ? ' · ' + regionInfo.regions.length + ' 片海域' : '') +
    (cityCount ? ' · ' + cityCount + ' 座边界城市' : '') +
    (plan.folded.length ? ' · 折叠 ' + plan.folded.length + ' 条' : '') +
    (mineCount ? ' · 我的连线 ' + mineCount : '');
  const empty = document.getElementById('continentEmpty');
  if (empty) empty.hidden = (data.itemCount || 0) > 0;
  // 空态引导（v5.4）：「暂无共享连线」管「有岛但 0 城市」，教的是共享概念怎么长成城市。
  // 与连接模式提示互斥的约定不变（见 _continentSetLinkMode）。
  // 「空画布计数」那句引导已按用户要求删除（2026-09-27）：它统计的是本地会话清单里
  // 有几个画布没上图，用户看到的是一句关于自己数据的统计而不是可操作的引导。
  const guide = document.getElementById('continentGuide');
  if (guide) {
    _continentGuideText = (cityCount === 0 && (data.itemCount || 0) > 0)
      ? '暂无共享连线——同一个概念在第二座岛出现时，这里会自动亮起边界城市'
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
        : '<button class="continent-pop-btn" data-link="' + i + '">画成大陆边</button>') +
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
      if (ok) { _continentClosePopover(); _continentToast('已画上这条大陆边'); }
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

const CONTINENT_REGION_SOURCE_LABEL = {
  family: '按概念族推断',
  gate: 'Φ 归类',
  user: '你指定',
};

function _continentRegionSourceLabel(source) {
  return CONTINENT_REGION_SOURCE_LABEL[source] || CONTINENT_REGION_SOURCE_LABEL.family;
}

// 混合岛次要领域色点（岛牌主导领域徽标旁）：后端 domains[1] 概率 ≥ 0.25 才有——
// 「多标签」的可见形态，悬停显示分布
function _continentSecondaryDot(cluster, domainList) {
  const second = cluster && cluster.domains && cluster.domains[1];
  if (!second || !(Number(second.p) >= CONTINENT_CONF_LIGHT - 0.15)) return '';
  const hue = _continentRegionHue(second.name, domainList);
  return '<span class="continent-domain-dot" style="--region-h:' + hue + '"' +
    ' title="次要领域：' + _continentEsc(second.name) + '（' + Math.round(Number(second.p) * 100) + '%）"></span>';
}

// 图例本体（#continentLegend，挂在视口左下角——不与顶栏 #continentGuide/连接模式提示
// 争位，那是 v5.4 踩过的互斥坑）。自身可折叠（不许变成新的复杂度）。
function _continentRenderLegend(regionInfo, data) {
  const legend = document.getElementById('continentLegend');
  if (!legend) return;
  const regions = (regionInfo && regionInfo.regions) || [];
  const pending = (regionInfo && regionInfo.pending) || [];
  if (!regions.length && !pending.length) { legend.hidden = true; legend.innerHTML = ''; return; }
  legend.hidden = false;
  let collapsed = false;
  try { collapsed = localStorage.getItem('phymathia_continent_legend') === '1'; } catch (e) { /* 容忍 */ }
  const esc = _continentEsc;
  const items = regions.map(r => {
    const hueAttr = (r.hue !== null && r.hue !== undefined) ? ' style="--region-h:' + r.hue + '"' : '';
    const over = r.sessions.length > CONTINENT_REGION_CAPACITY
      ? '<span class="continent-region-over" title="这片海域超过 ' + CONTINENT_REGION_CAPACITY +
        ' 座岛，地图还能画，但可以考虑拆成子海域">超容量</span>' : '';
    return '<li class="continent-legend-item' + (_continentLegendFocus === r.key ? ' is-active' : '') + '"' +
      hueAttr + ' data-region="' + esc(r.key) + '" title="点一下聚焦这片海域（其他海域淡出，再点恢复）">' +
      '<span class="continent-legend-chip"></span>' +
      '<span class="continent-legend-name">' + esc(r.name) + '</span>' +
      '<span class="continent-legend-count">' + r.sessions.length + ' 岛 · ' + r.itemCount + ' 卡</span>' +
      over +
      '<span class="continent-legend-src">' + esc(_continentRegionSourceLabel(r.source)) + '</span>' +
      (r.merged ? '' : '<button class="continent-legend-rename" data-rename="' + esc(r.key) +
        '" title="给这片海域改个名（只改显示名，颜色与归类不变）">改名</button>') +
      '</li>';
  }).join('');
  const totalIslands = ((data && data.clusters) || []).length;
  const pendingRatio = totalIslands ? Math.round(pending.length * 100 / totalIslands) : 0;
  // 负载均衡提示（MoE 的 aux loss 位：只提示不硬拆——均衡不是目标，可读才是）：
  // 某领域吃掉 >35% 的卡且库 ≥30 卡时提一句「可拆子海域」，拆不拆用户说了算
  let shareHint = '';
  const totalCards = (data && data.itemCount) || 0;
  if (totalCards >= 30) {
    const biggest = regions.reduce((a, b) => (!a || b.itemCount > a.itemCount) ? b : a, null);
    if (biggest && biggest.itemCount / totalCards > CONTINENT_GATE_DOMINANT_SHARE) {
      shareHint = '「' + biggest.name + '」占了 ' +
        Math.round(biggest.itemCount * 100 / totalCards) + '% 的卡片——海域过大可拆子海域';
    }
  }
  const footBits = [];
  if (pending.length) {
    footBits.push('低置信 ' + pending.length + '/' + totalIslands + '（' + pendingRatio +
      '%）——占比高说明领域名单或词表该补了');
  }
  if (shareHint) footBits.push(shareHint);
  // v8 纠正信号可见（缺失要可见）：记了几笔在图例照报，族表弹层里可清空
  if (_continentCorrectionCount > 0) {
    footBits.push('归类纠正已记录 ' + _continentCorrectionCount + ' 次（族表弹层可清空）');
  }
  legend.innerHTML =
    '<div class="continent-legend-head">' +
      '<span class="continent-legend-title">图例' + (collapsed ? ' ▸' : ' ▾') + '</span>' +
      (pending.length
        ? '<button class="continent-legend-pending" data-pending>待确认 ' + pending.length + ' 座岛</button>'
        : '') +
    '</div>' +
    (collapsed ? '' :
      '<ul class="continent-legend-list">' + items + '</ul>' +
      (footBits.length ? '<div class="continent-legend-foot">' + esc(footBits.join('；')) + '</div>' : ''));
  const toggle = legend.querySelector ? legend.querySelector('.continent-legend-head') : null;
  if (toggle) toggle.addEventListener('pointerdown', e => {
    e.stopPropagation();
    try {
      localStorage.setItem('phymathia_continent_legend',
        localStorage.getItem('phymathia_continent_legend') === '1' ? '0' : '1');
    } catch (err) { /* 容忍 */ }
    _continentRenderLegend(_continentRegionInfo, data);
  });
  (legend.querySelectorAll ? legend.querySelectorAll('[data-region]') : []).forEach(li =>
    li.addEventListener('pointerdown', e => {
      e.stopPropagation();
      _continentToggleLegendFocus(li.getAttribute('data-region'));
    }));
  (legend.querySelectorAll ? legend.querySelectorAll('[data-rename]') : []).forEach(btn =>
    btn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      _continentRenameRegionMenu(e, btn.getAttribute('data-rename'));
    }));
  const pendingBtn = legend.querySelector ? legend.querySelector('[data-pending]') : null;
  if (pendingBtn) pendingBtn.addEventListener('pointerdown', e => {
    e.stopPropagation();
    _continentPendingPopover(e);
  });
}

// 聚焦：只淡化不删不重排——地图的空间记忆（哪片在哪）是用户的资产
function _continentToggleLegendFocus(key) {
  _continentLegendFocus = (_continentLegendFocus === key) ? '' : String(key || '');
  _continentApplyFocus();
  if (_continentRegionInfo && _continentData) {
    _continentRenderLegend(_continentRegionInfo, _continentData);
  }
}

function _continentApplyFocus() {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return;
  const key = _continentLegendFocus;
  const info = _continentRegionInfo || { bySid: {} };
  world.classList.toggle('is-focused', !!key);
  const regionOf = sid => (info.bySid[sid] || {}).key;
  world.querySelectorAll('.continent-region').forEach(el =>
    el.classList.toggle('is-dim', !!key && el.dataset.region !== key));
  world.querySelectorAll('.continent-cluster').forEach(el =>
    el.classList.toggle('is-dim', !!key && regionOf(el.dataset.sessionId) !== key));
  world.querySelectorAll('.continent-node').forEach(el =>
    el.classList.toggle('is-dim', !!key && regionOf(el.dataset.sessionId) !== key));
  const dimBySids = el => {
    const sids = String(el.getAttribute('data-sids') || '').split(',').filter(Boolean);
    el.classList.toggle('is-dim', !!key && !sids.some(sid => regionOf(sid) === key));
  };
  world.querySelectorAll('.continent-city').forEach(dimBySids);
  world.querySelectorAll('.continent-spoke').forEach(dimBySids);
}

// 归到哪个领域：25 个领域 + 不归类，一步落笔（不做拖拽——画布平移已占用 pointerdown，
// v2 踩过 setPointerCapture 把 pointerup 重定向的坑）
function _continentDomainMenu(ev, sid) {
  const data = _continentData || {};
  const list = (data.domainList || []).slice();
  const override = (_continentRegionOverrides && _continentRegionOverrides.assign) || {};
  const hadOverride = Object.prototype.hasOwnProperty.call(override, sid);
  const current = hadOverride ? override[sid]
    : ((((data.clusters || []).find(c => c.sessionId === sid) || {}).domain) || null);
  const esc = _continentEsc;
  const rows = list.map(d =>
    '<button class="continent-pop-btn' + (d === current ? ' is-current' : '') +
    '" data-assign="' + esc(d) + '">' + esc(d) +
    (d === current ? '（当前）' : '') + '</button>').join('');
  const html =
    '<div class="continent-pop-title">这座岛归到哪个领域？</div>' +
    '<div class="continent-pop-desc">你的指派优先于机器判断（Φ 归类 / 概念族推断），写进大陆记忆；Ctrl+Z 可撤销。</div>' +
    '<div class="continent-pop-actions is-wrap">' + rows +
    '<button class="continent-pop-btn is-danger" data-assign="">不归类</button></div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-assign]').forEach(btn => btn.addEventListener('pointerdown', e => {
    e.stopPropagation();
    const domain = btn.getAttribute('data-assign') || null;
    _continentClosePopover();
    _continentAssignRegion(sid, domain, hadOverride ? current : undefined);
  }));
}

async function _continentAssignRegion(sid, domain, before) {
  // 纠正方向（「从纠正中学习」的信号）：改前的**生效归属** = 用户覆盖优先，没有覆盖
  // 才看机器判断（domain）；与改后相同就不算纠正（改了个寂寞不记一笔）
  const overrides = _continentRegionOverrides || {};
  const hadOverride = Object.prototype.hasOwnProperty.call(overrides.assign || {}, sid);
  const cluster = ((_continentData && _continentData.clusters) || []).find(c => c.sessionId === sid) || {};
  const fromDomain = hadOverride ? (overrides.assign[sid] || null) : (cluster.domain || null);
  const next = _continentCopyRegionOverrides();
  if (domain) next.assign[sid] = domain;
  else next.assign[sid] = null;   // 「不归类」也是一条用户决定（盖过机器）
  try {
    await _continentCommitRegionOverrides(next,
      { type: 'region', kind: 'assign', sid: sid, before: before });
    if (fromDomain !== domain) _continentRecordCorrection(sid, fromDomain, domain);
    _continentToast(domain ? '已归到「' + domain + '」（Ctrl+Z 可撤销）' : '已改为不归类（Ctrl+Z 可撤销）');
  } catch (err) {
    _continentToast('保存失败：' + (err && err.message || err));
  }
}

// 海域名修改：只改显示名，色槽与归类键不变（颜色跟规范名走，改名不换色）
function _continentRenameRegionMenu(ev, key) {
  const renames = (_continentRegionOverrides && _continentRegionOverrides.renames) || {};
  const before = Object.prototype.hasOwnProperty.call(renames, key) ? renames[key] : undefined;
  const esc = _continentEsc;
  const html =
    '<div class="continent-pop-title">海域改名</div>' +
    '<div class="continent-pop-row"><input class="continent-pop-input" data-rename-input' +
    ' value="' + esc(renames[key] || key) + '" maxlength="16" placeholder="' + esc(key) + '"></div>' +
    '<div class="continent-pop-actions">' +
      // 次操作（还原默认名）在左、主操作（保存）在右，且「保存」由 CSS 顶到行尾——
      // 于是只有「保存」一个按钮时（没改过名就没有还原按钮）它也停在同一个位置，
      // 不会一会儿左一会儿右。两个按钮都吃 pointerdown，DOM 顺序不影响可点性。
      (before !== undefined ? '<button class="continent-pop-btn is-quiet" data-rename-reset>还原默认名</button>' : '') +
      '<button class="continent-pop-btn" data-rename-save>保存</button>' +
    '</div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  const input = el.querySelector('[data-rename-input]');
  if (input && input.focus) { try { input.focus(); } catch (e) { /* 容忍 */ } }
  const save = async name => {
    _continentClosePopover();
    const next = _continentCopyRegionOverrides();
    if (name) next.renames[key] = name;
    else delete next.renames[key];
    try {
      await _continentCommitRegionOverrides(next,
        { type: 'region', kind: 'rename', key: key, before: before });
      _continentToast('海域已改名（Ctrl+Z 可撤销）');
    } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  };
  const saveBtn = el.querySelector('[data-rename-save]');
  if (saveBtn) saveBtn.addEventListener('pointerdown', e => {
    e.stopPropagation();
    save(input ? String(input.value || '').trim().slice(0, 16) : '');
  });
  const resetBtn = el.querySelector('[data-rename-reset]');
  if (resetBtn) resetBtn.addEventListener('pointerdown', e => {
    e.stopPropagation();
    save('');
  });
  if (input) input.addEventListener('keydown', e => {
    if (e.key === 'Enter') save(String(input.value || '').trim().slice(0, 16));
  });
}

// 待确认清单（低置信岛）：每行「岛名 → 最优猜测（置信度）」+ 快捷指派——「不确定也
// 要可见」的落点，机器不确定的事交给人一锤定音。v7.1b 起，Φ 归类跑出的建议（新领域
// 提名 / 归并组）也落在这里等确认——模型只建议，落笔权永远在用户
function _continentPendingPopover(ev) {
  const info = _continentRegionInfo || {};
  const pending = info.pending || [];
  const esc = _continentEsc;
  const rows = pending.map(p =>
    '<div class="continent-pop-row">' +
    '<span class="continent-pop-row-text">' + esc(p.title || p.sid) +
    ' <span class="continent-pop-reason">' + esc(p.domain) + '（' +
    Math.round((Number(p.conf) || 0) * 100) + '%）</span></span>' +
    '<button class="continent-pop-btn is-quiet" data-pending-sid="' + esc(p.sid) + '">指派领域</button>' +
    '</div>').join('');
  const sug = _continentGateSuggestions;
  let sugHtml = '';
  if (sug) {
    const mergeRows = (sug.merges || []).map((m, i) =>
      '<div class="continent-pop-row">' +
      '<span class="continent-pop-row-text">Φ 说这几张是一回事：<b>' + esc(m.name) + '</b>' +
      ' <span class="continent-pop-reason">' + (m.titles || []).map(esc).join(' / ') + '</span></span>' +
      '<button class="continent-pop-btn" data-adopt="' + i + '">采纳进族表</button>' +
      '</div>').join('');
    const newRows = (sug.newDomains || []).length
      ? '<div class="continent-pop-desc">名单缺领域：' + sug.newDomains.map(esc).join('、') +
        '——领域名单是固定的，可在顶栏「族表」里补（补完旧打标自动作废重打）。</div>'
      : '';
    sugHtml = '<div class="continent-pop-title" style="margin-top:6px">Φ 的建议（待你确认）</div>' + mergeRows + newRows;
  }
  const html =
    '<div class="continent-pop-title">待确认 ' + pending.length + ' 座岛</div>' +
    '<div class="continent-pop-desc">这些岛的领域归属置信度低于 40%——机器拿不准的，你一锤定音（指派后进对应海域、Ctrl+Z 可撤销）。</div>' +
    (rows || '<div class="continent-pop-desc">暂时没有待确认的岛。</div>') +
    sugHtml;
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-pending-sid]').forEach(btn =>
    btn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      _continentDomainMenu(e, btn.getAttribute('data-pending-sid'));
    }));
  el.querySelectorAll('[data-adopt]').forEach(btn =>
    btn.addEventListener('pointerdown', e => {
      e.stopPropagation();
      const m = (_continentGateSuggestions && _continentGateSuggestions.merges || [])
        [Number(btn.getAttribute('data-adopt'))];
      if (m) _continentAdoptGateMerge(m);
    }));
}

function _continentCopyRegionOverrides() {
  const src = _continentRegionOverrides || {};
  const renames = {}, assign = {};
  Object.keys(src.renames || {}).forEach(k => { renames[k] = src.renames[k]; });
  Object.keys(src.assign || {}).forEach(k => { assign[k] = src.assign[k]; });
  return { renames: renames, assign: assign };
}

async function _continentLoadRegionOverrides() {
  try {
    const resp = await fetch(CONTINENT_REGIONS_API, { cache: 'no-cache' });
    if (!resp.ok) return;
    const data = await resp.json();
    const v = (data && data.value) || {};
    _continentRegionOverrides = {
      renames: (v && typeof v.renames === 'object' && !Array.isArray(v.renames)) ? v.renames : {},
      assign: (v && typeof v.assign === 'object' && !Array.isArray(v.assign)) ? v.assign : {},
    };
  } catch (e) { /* 查空是正常路径：没写过就是空覆盖 */ }
}

async function _continentCommitRegionOverrides(next, undoEntry) {
  const resp = await fetch(CONTINENT_REGIONS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: next }),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  if (undoEntry) _continentEdgeUndo.push(undoEntry);
  _continentRegionOverrides = next;
  _continentLegendFocus = '';  // 分组可能变了，聚焦态不作数
  if (_continentOpen && _continentData) _continentRender(_continentData);  // 归属变了 → 重排重渲
  _continentUpdateTools();
}

// 撤销「海域操作」：assign 的 before=undefined 表示原本没有覆盖（撤销=删键）；
// rename 的 before=undefined 表示原本用默认名（撤销=删改名）
async function _continentUndoRegionOp(op) {
  const next = _continentCopyRegionOverrides();
  if (op.kind === 'assign') {
    if (op.before === undefined || op.before === null) delete next.assign[op.sid];
    else next.assign[op.sid] = op.before;
  } else if (op.kind === 'rename') {
    if (op.before === undefined || op.before === null) delete next.renames[op.key];
    else next.renames[op.key] = op.before;
  }
  await _continentCommitRegionOverrides(next);
}

// ---------- v7.1b MoE 门控：Φ 批量归类（读内容，补「查词典」做不到的两类） ----------
// 本地词面门控（评分核心）零成本永远可用，但救不了两类：词表没列的新术语（康普顿
// 散射）、泛名/上位词（质能关系）——Φ 读「标题+摘要+公式」补这层。铁律：
// 触发不自动（打开大陆不烧调用，点了才跑）；名单固定（模型只能从给定名单选，想加
// 领域只能进「建议」待用户确认）；产物落盘带版本与内容 hash（增量重打）；判读失败
// 不写脏数据。通道复用 /api/models/chat 的 stream:false（与「问 Φ」同口径）。
const CONTINENT_GATE_API = '/api/kv/continent_gate';
const CONTINENT_GATE_BATCH = 40;
const CONTINENT_GATE_DOMINANT_SHARE = 0.35;  // 负载均衡提示线（不是硬拆）
let _continentGateCtrl = null;               // 在途批量归类的中止器（关大陆即中止）
let _continentGateSuggestions = null;        // 上次跑完的建议 {newDomains:[], merges:[{name,ids,titles}]}

// 卡片内容指纹：标题+摘要+公式变了才重打（缓存三层的 hash 一环）
function _continentGateHash(card) {
  const key = [card && card.title || '', card && card.summary || '', card && card.formula || '']
    .join('\u0001');
  return _continentStrHash(key).toString(36);
}

// 批量归类的提示词（system+user 两条都写契约——模型对最后一条更敏感，v5.3 的教训）
function _continentGateMessages(cards, domainList) {
  const list = (domainList || []).join('、');
  const lines = (cards || []).map(c =>
    '- ' + c.id + '｜' + c.title + (c.summary ? '｜' + c.summary : '') +
    (c.formula ? '｜' + c.formula : ''));
  const user = [
    '给下面每张知识卡片选 1–2 个领域（只能从给定名单里选），并给 0 到 1 的置信度。',
    '领域名单：' + list,
    '卡片：',
  ].concat(lines).concat([
    '',
    '输出严格的 JSON 数组，每项形如：{"id":"卡片id","domains":[{"name":"名单里的领域","conf":0.9}],"new":[]}',
    '某张卡在名单里找不到合适领域时：它的 domains 留空，把建议的新领域名（不超过 6 个字）放进 new 数组。',
    '如果发现几张卡讲的是同一个概念（同义或译名变体），另加一项：{"merge":{"name":"规范名","ids":["id1","id2"]}}。',
    '宁缺毋滥：拿不准就给低置信度或留空。只输出 JSON，不要任何其他文字。',
  ]).join('\n');
  return [
    { role: 'system',
      content: '你是知识大陆的门控路由器：只从给定的领域名单里选择，输出严格 JSON 数组，不要任何其他文字。' },
    { role: 'user', content: user },
  ];
}

// 判读（纯函数）：剥思考块与代码围栏 → 取首个 [ 到末个 ] 的片段 → JSON.parse →
// 名单外领域丢弃、conf 夹取、每卡至多 2 个领域、merge 组的 ids 必须都在本批内。
// 任何一步失败都返回空产物（该批保持本地归属，不写脏数据）
function _continentGateParse(raw, cardIds, domainList) {
  const out = { labels: {}, newDomains: [], merges: [] };
  const ids = new Set(cardIds || []);
  const allowed = new Set(domainList || []);
  let text = typeof _stripThinkText === 'function'
    ? _stripThinkText(String(raw || '')) : String(raw || '');
  text = text.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return out;
  let arr;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch (e) { return out; }
  if (!Array.isArray(arr)) return out;
  arr.forEach(row => {
    if (row && typeof row === 'object' && row.merge && row.merge.name
        && Array.isArray(row.merge.ids)) {
      const mIds = row.merge.ids.map(String).filter(id => ids.has(id));
      if (mIds.length >= 2) {
        out.merges.push({ name: String(row.merge.name).trim().slice(0, 16), ids: mIds });
      }
      return;
    }
    if (!row || typeof row !== 'object' || !ids.has(String(row.id))) return;
    const doms = Array.isArray(row.domains) ? row.domains : [];
    const good = [];
    doms.slice(0, 2).forEach(d => {
      if (!d || typeof d !== 'object') return;
      const name = String(d.name || '').trim();
      if (!allowed.has(name)) return;
      let conf = Number(d.conf);
      if (!Number.isFinite(conf)) conf = 0;
      conf = Math.min(1, Math.max(0, conf));
      if (conf > 0 && !good.some(g => g.name === name)) good.push({ name: name, conf: conf });
    });
    if (good.length) out.labels[String(row.id)] = good;
    (Array.isArray(row.new) ? row.new : []).forEach(n => {
      const s = String(n || '').trim().slice(0, 16);
      if (s && !allowed.has(s) && out.newDomains.indexOf(s) < 0) out.newDomains.push(s);
    });
  });
  return out;
}

// 待打标卡片：归属缺失（domain=null）或低置信（<0.4）的岛上的卡；内容 hash 没变的
// 跳过（增量）。已有可靠归属的岛不烧调用——Φ 只补本地门控做不到的那部分
function _continentGatePendingCards(clusters, entries) {
  const out = [];
  (clusters || []).forEach(c => {
    const conf = Number(c.domainConf) || 0;
    if (c.domain && conf >= CONTINENT_CONF_LIGHT) return;
    (c.items || []).forEach(it => {
      if (!it || !it.itemId) return;
      const e = entries && entries[it.itemId];
      if (e && e.hash === _continentGateHash(it)) return;
      out.push({ id: it.itemId, title: it.title || '', summary: it.summary || '',
                 formula: String(it.formula || '').slice(0, 80) });
    });
  });
  return out;
}

// 批量归类主流程：分批（40/批）→ 每批判读 → **每批落盘**（中断不丢已完成的）→
// 全部结束刷新投影（后端把 gate KV 合进同一层分区，来源标记变「Φ 归类」）
async function _continentGateClassify() {
  const data = _continentData;
  if (!data) return;
  const model = (typeof getActiveModelForRole === 'function')
    ? (getActiveModelForRole('graph') || getActiveModelForRole('agent')) : null;
  if (!model) { _continentToast('先在「模型设置」里配置主模型，Φ 才能归类'); return; }
  if (typeof proxyChatWithModel !== 'function') { _continentToast('模型代理通道不可用'); return; }
  const btn = document.getElementById('continentGateBtn');
  const setBtn = txt => { if (btn) { btn.disabled = true; btn.textContent = txt; } };
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  _continentGateCtrl = ctrl;
  try {
    // 读现有 gate KV：版本一致才沿用条目（名单/权重变了整批作废重打）
    let entries = {};
    try {
      const r = await fetch(CONTINENT_GATE_API, { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        const v = j && j.value;
        if (v && typeof v === 'object' && v.version === data.gateVersion
            && v.entries && typeof v.entries === 'object') entries = v.entries;
      }
    } catch (e) { /* 读不到就当全新跑 */ }
    const pending = _continentGatePendingCards(data.clusters, entries);
    if (!pending.length) { _continentToast('没有需要 Φ 归类的卡片'); return; }
    const domainList = data.domainList || [];
    const kv = { version: data.gateVersion, entries: entries };
    const newDomains = [], merges = [];
    let done = 0, failed = 0;
    for (let i = 0; i < pending.length; i += CONTINENT_GATE_BATCH) {
      if (ctrl && ctrl.signal.aborted) break;
      const batch = pending.slice(i, i + CONTINENT_GATE_BATCH);
      setBtn('Φ 归类中 ' + Math.min(i + batch.length, pending.length) + '/' + pending.length);
      try {
        const resp = await proxyChatWithModel(model, {
          messages: _continentGateMessages(batch, domainList), stream: false,
          session_bucket: 'phymathia-continent',
        }, ctrl ? ctrl.signal : undefined);
        const j = await resp.json();
        const raw = j && j.choices && j.choices[0] && j.choices[0].message
          ? j.choices[0].message.content : '';
        const parsed = _continentGateParse(raw, batch.map(c => c.id), domainList);
        Object.keys(parsed.labels).forEach(id => {
          const card = batch.find(c => c.id === id) || {};
          kv.entries[id] = { hash: _continentGateHash(card),
                             domains: parsed.labels[id], at: Date.now() };
          done++;
        });
        parsed.newDomains.forEach(n => { if (newDomains.indexOf(n) < 0) newDomains.push(n); });
        parsed.merges.forEach(m => {
          m.titles = m.ids.map(id => {
            const card = (data.clusters || []).flatMap(c => c.items || [])
              .find(it => it.itemId === id);
            return card ? String(card.title || '') : '';
          }).filter(Boolean);
          merges.push(m);
        });
        // 每批落盘：中断后已完成的批照常保留（部分成果不丢，下次接着跑）
        await fetch(CONTINENT_GATE_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: kv }),
        });
      } catch (err) {
        if (err && err.name === 'AbortError') break;
        failed += batch.length;
      }
    }
    // 刷新投影：后端把 gate KV 合进分区，图例来源标记变「Φ 归类」
    try {
      const fresh = await _continentFetchData();
      _continentData = fresh;
      if (_continentOpen) { _continentRender(fresh); _continentUpdateTools(); }
    } catch (e) { /* 刷新失败不丢已落盘的产物，下次打开自然生效 */ }
    _continentGateSuggestions = (newDomains.length || merges.length)
      ? { newDomains: newDomains, merges: merges } : null;
    let msg = 'Φ 已归类 ' + done + ' 张';
    if (failed) msg += '，' + failed + ' 张失败（可再点一次重试）';
    if (_continentGateSuggestions) msg += '；有建议待你确认（图例 · 待确认）';
    _continentToast(msg);
  } finally {
    _continentGateCtrl = null;
    if (btn) { btn.disabled = false; }
    _continentUpdateTools();
  }
}

// 采纳归并建议：写进 continent_families（与内置族同一条汇聚通道——从此会积累）。
// terms 用这几张卡的标题：族匹配跑标题，同款/子串变体今后自动归族
async function _continentAdoptGateMerge(m) {
  const terms = [];
  (m.titles || []).forEach(t => {
    const s = String(t || '').trim().slice(0, 24);
    if (s.length >= 2 && terms.indexOf(s) < 0) terms.push(s);
  });
  if (!terms.length) { _continentToast('这条建议没有可用的术语'); return; }
  let families = [];
  try {
    const r = await fetch('/api/kv/continent_families', { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      const v = j && j.value;
      families = (v && Array.isArray(v.families)) ? v.families : (Array.isArray(v) ? v : []);
    }
  } catch (e) { /* 读不到就当空表 */ }
  const next = families.filter(f => !f || f.canonical !== m.name);
  next.push({ canonical: m.name, terms: terms, source: 'user' });
  try {
    await fetch('/api/kv/continent_families', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { families: next } }),
    });
    // 建议从清单里划掉（其余保留）
    if (_continentGateSuggestions && _continentGateSuggestions.merges) {
      _continentGateSuggestions.merges =
        _continentGateSuggestions.merges.filter(x => x !== m);
      if (!_continentGateSuggestions.merges.length && !_continentGateSuggestions.newDomains.length) {
        _continentGateSuggestions = null;
      }
    }
    const fresh = await _continentFetchData();
    _continentData = fresh;
    if (_continentOpen) { _continentRender(fresh); _continentUpdateTools(); }
    _continentToast('已采纳归并「' + m.name + '」——写进概念族表，从此会积累');
  } catch (err) {
    _continentToast('保存失败：' + (err && err.message || err));
  }
}

// 该岛命中这条共享概念的全部卡（服务端未给 owners 时退回代表卡一张）
function _continentIslandCards(entry, sessionId, fallbackItemId, idx) {
  const owners = (entry && entry.owners) || [];
  const itemSession = (idx && idx.itemSession) || {};
  const mine = owners.filter(iid => itemSession[iid] === sessionId);
  if (!mine.length) return fallbackItemId ? [fallbackItemId] : [];
  const rep = mine.indexOf(fallbackItemId);
  if (rep > 0) { mine.splice(rep, 1); mine.unshift(fallbackItemId); }  // 代表卡排最前（辐条连的就是它）
  return mine;
}

// 重逢清单的行是纯字符串拼装（无 DOM），单独抽出来给 smoke 断言
function _continentReunionRows(city, idx) {
  const items = (idx && idx.items) || {};
  const clusterTitles = (idx && idx.clusterTitles) || {};
  const itemCreated = (idx && idx.itemCreated) || {};
  const rel = (idx && idx.rel) || _continentRelTime;
  const rows = [];
  ((city && city.reps) || []).forEach(r => {
    const sid = r.sessionId;
    const cards = _continentIslandCards(city && city.entry, sid, r.itemId, idx);
    cards.forEach((iid, k) => {
      const when = rel(itemCreated[iid]);
      const head = k === 0
        ? '<span class="continent-pop-place">' + _continentEsc(clusterTitles[sid] || '已删除的画布') + '</span> · '
        : '<span class="continent-pop-sub">同岛还有</span> ';
      rows.push('<div class="continent-pop-row' + (k === 0 ? '' : ' is-sub') + '">' +
        '<span class="continent-pop-row-text">' + head + _continentEsc(items[iid] || '（概念已不在）') +
        (when ? '<span class="continent-pop-when">' + _continentEsc(when) + '</span>' : '') +
        '</span>' +
        '<button class="continent-pop-btn" data-go="' + _continentEsc(sid) + '"' +
        ' data-item="' + _continentEsc(iid) + '">去看</button>' +
        '</div>');
    });
  });
  return rows.join('');
}

function _continentCityPopover(city, ev) {
  const idx = _continentItemIndex();
  const s = (city && city.entry) || {};
  const reps = (city && city.reps) || [];
  const rows = _continentReunionRows(city, idx);
  // 「画成大陆边」= v3 起的用户确认落笔口（Φ 只会口头建议，真要写边得你点）。
  // 一枚芯片 = 一条链路（两块画布的代表卡之间）；已连过的只标「已连线」。
  const links = (s.links || []).slice(0, 6);
  const userEdges = (_continentData && _continentData.userEdges) || [];
  const chips = links.map((link, i) => {
    const already = userEdges.some(e =>
      (e.fromItem === link.from && e.toItem === link.to) ||
      (e.fromItem === link.to && e.toItem === link.from));
    if (already) return '<span class="continent-pop-note-inline">已连线</span>';
    const a = _continentEsc(idx.clusterTitles[link.fromSession] || '已删除的画布');
    const b = _continentEsc(idx.clusterTitles[link.toSession] || '已删除的画布');
    return '<button class="continent-pop-btn is-quiet" data-link="' + i + '"' +
      ' title="把这两块画布的代表卡连成一条我的大陆边">' + a + ' ↔ ' + b + '</button>';
  }).join('');
  const html =
    '<div class="continent-pop-title">' + _continentKindPrefix(s.kind) + _continentEsc(s.label || '') +
    '<span class="continent-pop-count">' + reps.length + ' 块画布</span></div>' +
    (rows || '<div class="continent-pop-desc">这座城市的卡片已不在大陆上了。</div>') +
    '<div class="continent-pop-desc">' +
    (s.kind === 'formula'
      ? '这几块画布的公式共享结构「' + _continentEsc(s.label || '') + '」'
      : (s.kind === 'family'
        ? '这几块画布同属概念族「' + _continentEsc(s.label || '') + '」（领域知识层认出的同族关系）'
        : '这几块画布的概念标题共享「' + _continentEsc(s.label || '') + '」')) +
    '——机器检出的共享点不会自动连线。</div>' +
    (chips ? '<div class="continent-pop-actions is-wrap">' + chips + '</div>' : '');
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-go]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const sid = btn.getAttribute('data-go');
    const iid = btn.getAttribute('data-item');
    _continentClosePopover();
    enterContinentSession(sid, iid);   // 复用下钻转场 + goToKnowledgeNode 直达定位
  }));
  el.querySelectorAll('[data-link]').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    const link = links[Number(btn.getAttribute('data-link'))];
    if (!link) return;
    try {
      const ok = await _continentAddUserEdge(link.from, link.to, s.label);
      if (ok) { _continentClosePopover(); _continentToast('已画上这条大陆边'); }
    } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  }));
}

// v4 折叠清单：没画到地图上的那些在这里照报，逐条可确认并亲手落笔。
// 原因口径见 CONTINENT_FOLD_REASON（v5.1 起四种，v5.5 加第五种「已被更具体的城市
// 覆盖」：弱证据 / 覆盖 / 超每对上限 / 超全图上限 / 无位可放）。地图负责概览，
// 清单负责穷尽——谁也不伪装成对方，更不许静默消失。

// ---------- v5.3 问 Φ：机器没把握的，交给 Φ 说一句人话，落笔权永远在用户 ----------
// 通道取舍：走 /api/models/chat 的 stream:false（与知识摘要优化同一口径），模型选
// Φ 助手槽位（graph，未配置回退主模型）——/api/harness 的评审协议是改图导向
// （messages 按评审/扩展/应用四套固定模板组装、输出走操作白名单），没有裸问答口，
// 折叠行的「两条知识点是否真相关」判断用它反而要绕开整套操作协议。
// 提示词、判读、判断块拼装都是纯函数（无 DOM），单独抽出来给 smoke 断言。

// Φ 必须以「值得连：」或「不建议连：」开头——输出契定了，判读才不是猜谜。
// 格式约定在 system 与 user 两条消息里都写（模型对最后一条更敏感）。
function _continentPhiMessages(left, right, label) {
  const lines = [
    '用户在知识大陆的折叠清单里看到一条机器没把握的跨画布联系，请你判断这两条知识点是否真的相关（值得在地图上画一条连线），还是只是字面相撞。',
    '',
    '共享词：' + (label || '（无）'),
    '第一条：' + ((left && left.title) || '（无标题）') + ((left && left.summary) ? '——' + left.summary : ''),
    '第二条：' + ((right && right.title) || '（无标题）') + ((right && right.summary) ? '——' + right.summary : ''),
    '',
    '注意：共享词可能是「表达」「坐标」这类通用词，判断依据是两条知识的实质内容，不是共享词本身。',
    '只输出一行：以「值得连：」或「不建议连：」开头，后接不超过 50 字的理由。',
  ].join('\n');
  return [
    { role: 'system', content: '你是知识大陆的助手 Φ。只输出一行判断：以「值得连：」或「不建议连：」开头，后接不超过 50 字的理由。不要输出任何其他内容。' },
    { role: 'user', content: lines },
  ];
}

// 判读：只认第一行的开头两个约定词；判不出给中性档——判读只影响徽标与语气，
// 芯片（用户落笔口）两种档位都照给。
function _continentPhiVerdict(raw) {
  let text = typeof _stripThinkText === 'function'
    ? _stripThinkText(String(raw || '')) : String(raw || '');
  text = text.replace(/<[^>]+>/g, ' ').replace(/\*\*/g, '');
  const firstLine = (text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '');
  let verdict = 'unknown';
  if (firstLine.indexOf('值得连') === 0) verdict = 'worth';
  else if (firstLine.indexOf('不建议连') === 0) verdict = 'not';
  const reason = firstLine.replace(/^[「『"']?(值得连|不建议连)[」』"']?[：:、]?\s*/, '').trim();
  return { verdict: verdict, text: (reason || firstLine).slice(0, 120) };
}

// 判断块 HTML：徽标（三档）+ 理由 + 每条链路一枚「画成大陆边」芯片（已连线只标注）。
// userEdges 由调用方传入（smoke 不依赖模块状态）。
function _continentPhiBlockHtml(entry, verdict, idx, userEdges) {
  const items = (idx && idx.items) || {};
  const edges = userEdges || [];
  const worth = verdict && verdict.verdict === 'worth';
  const not = verdict && verdict.verdict === 'not';
  const badge = worth ? '值得连' : not ? '不建议连' : 'Φ 的判断';
  const links = ((entry && entry.links) || []).slice(0, 6);
  const chips = links.map((link, i) => {
    const already = edges.some(e =>
      (e.fromItem === link.from && e.toItem === link.to) ||
      (e.fromItem === link.to && e.toItem === link.from));
    if (already) return '<span class="continent-pop-note-inline">已连线</span>';
    const a = _continentEsc(items[link.from] || '？');
    const b = _continentEsc(items[link.to] || '？');
    return '<button class="continent-pop-btn is-quiet" data-phi-link="' + i + '"' +
      ' title="把这两条概念连成一条我的大陆边（Ctrl+Z 可撤销）">' + a + ' ↔ ' + b + '</button>';
  }).join('');
  return '<div class="continent-pop-phi">' +
    '<span class="continent-pop-phi-badge' + (worth ? ' is-worth' : '') + (not ? ' is-not' : '') + '">' + badge + '</span> ' +
    '<span class="continent-pop-phi-text">' + _continentEsc((verdict && verdict.text) || '') + '</span>' +
    (chips ? '<div class="continent-pop-actions is-wrap">' + chips + '</div>' : '') +
    '</div>';
}

// 芯片点击 = 走 v2 既有落笔通道（KV continent_edges）；清单不关——折叠清单是
// 工作清单，用户要连着过好几条，这行就地变「已连线」。绑定按 dataset 防重：
// 新判断块插入后按整个弹层查询绑定，上一块的芯片不能被二次挂 handler。
function _continentBindPhiChips(scope, entry) {
  if (!scope || !scope.querySelectorAll) return;
  const links = ((entry && entry.links) || []).slice(0, 6);
  scope.querySelectorAll('[data-phi-link]').forEach(btn => {
    if (btn.dataset) {
      if (btn.dataset.phiBound) return;
      btn.dataset.phiBound = '1';
    }
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const link = links[Number(btn.getAttribute('data-phi-link'))];
      if (!link) return;
      try {
        const ok = await _continentAddUserEdge(link.from, link.to, entry.label || '');
        if (ok) {
          const span = document.createElement('span');
          span.className = 'continent-pop-note-inline';
          span.textContent = '已连线';
          if (btn.replaceWith) btn.replaceWith(span); else btn.textContent = '已连线';
          _continentToast('已画上这条大陆边（Ctrl+Z 可撤销）');
        }
      } catch (err) {
        _continentToast('保存失败：' + (err && err.message || err));
      }
    });
  });
}

// 单行「问 Φ」：按钮进忙碌态 → /api/models/chat（stream:false）→ 判断块插到该行
// 下方。弹层已换页/关闭时回包静默丢弃（判断没处落）；失败恢复按钮可重问。
async function _continentAskPhi(f, rowIndex, btn) {
  const entry = (f && f.entry) || {};
  const link = (entry.links || [])[0] || {};
  const idx = _continentItemIndex();
  const model = (typeof getActiveModelForRole === 'function')
    ? (getActiveModelForRole('graph') || getActiveModelForRole('agent')) : null;
  if (!model) { _continentToast('先在「模型设置」里配置主模型，才能问 Φ'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Φ 看着…'; }
  const popover = _continentPopover;
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  if (ctrl) _continentPhiInflight.add(ctrl);
  try {
    const left = { title: idx.items[link.from] || '', summary: idx.itemSummary[link.from] || '' };
    const right = { title: idx.items[link.to] || '', summary: idx.itemSummary[link.to] || '' };
    if (typeof proxyChatWithModel !== 'function') throw new Error('模型代理通道不可用');
    const resp = await proxyChatWithModel(model, {
      messages: _continentPhiMessages(left, right, entry.label || ''),
      stream: false,
      session_bucket: 'phymathia-continent',
    }, ctrl ? ctrl.signal : undefined);
    const data = await resp.json();
    const raw = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '';
    if (!popover || _continentPopover !== popover) return;  // 弹层已关/换页
    const v = _continentPhiVerdict(raw);
    const row = popover.querySelector ? popover.querySelector('[data-fold="' + rowIndex + '"]') : null;
    const html = _continentPhiBlockHtml(entry, v, idx, (_continentData && _continentData.userEdges) || []);
    if (row && row.insertAdjacentHTML) {
      row.insertAdjacentHTML('afterend', html);
    } else if (popover.insertAdjacentHTML) {
      popover.insertAdjacentHTML('beforeend', html);
    }
    _continentBindPhiChips(popover, entry);
    if (btn) { btn.textContent = 'Φ 已答'; btn.disabled = true; }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    _continentToast('Φ 判断失败：' + (err && err.message || err));
    if (btn) { btn.disabled = false; btn.textContent = '问 Φ'; }
  } finally {
    if (ctrl) _continentPhiInflight.delete(ctrl);
  }
}

// 折叠清单的行是纯字符串拼装（无 DOM），单独抽出来给 smoke 断言
function _continentFoldedRows(folded, idx) {
  const items = (idx && idx.items) || {};
  return (folded || []).map((f, i) => {
    const s = f.entry || {};
    const link = (s.links || [])[0] || {};
    return '<div class="continent-pop-row">' +
      '<span class="continent-pop-row-text">' + _continentKindPrefix(s.kind) + _continentEsc(s.label) +
      ' · ' + _continentEsc(items[link.from] || '？') + ' ↔ ' + _continentEsc(items[link.to] || '？') +
      ' <span class="continent-pop-reason">' + (CONTINENT_FOLD_REASON[f.reason] || '折叠') + '</span></span>' +
      '<button class="continent-pop-btn is-quiet" data-phi="' + i + '" title="让 Φ 判断这两条是否真的相关">问 Φ</button>' +
      '<button class="continent-pop-btn" data-fold="' + i + '">看两边</button>' +
      '</div>';
  }).join('');
}

function _continentFoldedPopover(ev) {
  const idx = _continentItemIndex();
  const folded = _continentFolded || [];
  const rows = _continentFoldedRows(folded, idx);
  const html =
    '<div class="continent-pop-title">折叠 ' + folded.length + ' 条</div>' +
    '<div class="continent-pop-desc">「弱证据」是 2 字共享串（「表达」「坐标」级）与泛后缀，' +
    '单独立不住——但它照旧参与岛屿摆位；「已被更具体的城市覆盖」是这条共享串只出现在' +
    '更具体的那几个概念名中间（如两条「…守恒定律」之间的「量守恒定律」），地图交给更' +
    '具体的那几座城；「超出每对上限」「超出全图上限」是地图已经画满；「无位可放」是岛之间挤不出' +
    '放得下一座城市的位置（城市绝不叠在岛上）。都不上地图，但照报——' +
    '拿不准就「问 Φ」，它给一句人话判断，要不要连仍由你点「画成大陆边」；' +
    '想让弱证据彻底消失，得修那两条标题本身。</div>' +
    rows;
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-fold]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const f = folded[Number(btn.getAttribute('data-fold'))];
    if (f && f.entry) _continentSharedPopover(f.entry, ev);
  }));
  el.querySelectorAll('[data-phi]').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    const rowIndex = Number(btn.getAttribute('data-phi'));
    const f = folded[rowIndex];
    if (f) _continentAskPhi(f, rowIndex, btn);
  }));
}

// ---------- v7.2 航线操作：单条可调（线型/颜色/粗细/走线/锚点/显隐/备注） ----------
// 用户反馈「大陆边鸡肋：影响视觉、又不能手动调整」——调整面板就是主答。备注改成
// 内联输入（顺手收编方向候选 U1：大陆边的两处 window.prompt 清场）。

const CONTINENT_ROUTE_PREFS_KEY = 'phymathia_continent_routes'; // 非会话键（全局显示偏好）
const CONTINENT_ROUTE_DASH = { solid: '', dashed: '7 5', dotted: '2 4' };
const CONTINENT_ROUTE_WIDTH = { thin: 1.2, normal: 2, thick: 3.2 };

function _continentRoutePrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONTINENT_ROUTE_PREFS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return { on: raw.on !== false,
               opacity: Number.isFinite(Number(raw.opacity)) ? Math.min(1, Math.max(0.15, Number(raw.opacity))) : 1 };
    }
  } catch (e) { /* 容忍 */ }
  return { on: true, opacity: 1 };
}

function _continentSaveRoutePrefs(prefs) {
  try { localStorage.setItem(CONTINENT_ROUTE_PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* 容忍 */ }
}

// 样式解析（纯函数）：颜色三档——gold 暖色（**默认**：「我画的路」专用色，与机器画
// 的辐条/断线、海域板色系拉开；**按主题选色相**：暗色机器线是蓝→航线用暖金，浅色
// 机器线 accent 本身是暗金（#8b6914）→ 航线换**赭橙**（同属暖色语义、色相 45°→24°
// 彻底分开，且不是报错红）。theme 只影响这一档。旧边无 style 字段走默认（实线/
// normal/暖色）；region 算不出色相时仍回落旧默认蓝（查空是正常路径）
function _continentRouteStroke(style, edge, regionInfo, theme) {
  const s = style || {};
  const colorKey = s.color || 'gold';
  let color = null;
  if (colorKey === 'gold') {
    color = theme === 'light' ? 'rgba(191, 91, 27, 0.92)' : 'rgba(217, 164, 65, 0.9)';
  } else if (colorKey === 'neutral') {
    color = 'rgba(150, 156, 170, 0.8)';
  } else if (regionInfo && edge && regionInfo.bySid) {
    const info = regionInfo.bySid[edge.fromSession];
    const hue = info && info.key !== null && info.key !== undefined
      ? _continentRegionHue(info.key, null) : null;
    if (hue !== null && hue !== undefined) color = 'hsla(' + hue + ', 62%, 64%, 0.85)';
  }
  if (!color) color = 'rgba(74, 158, 255, 0.85)';
  return {
    color: color,
    width: CONTINENT_ROUTE_WIDTH[s.width] || CONTINENT_ROUTE_WIDTH.normal,
    dash: CONTINENT_ROUTE_DASH[s.dash] || '',
  };
}

// 通用编辑（样式/锚点/备注/隐藏共用）：改前留全量快照进撤销栈（type:'edit'）
async function _continentEditEdge(edgeId, patch) {
  const edges = _continentEdgeList();
  const target = edges.find(e => e.id === edgeId);
  if (!target) return;
  const before = JSON.parse(JSON.stringify(target));
  const next = edges.map(e => e.id === edgeId ? Object.assign({}, e, patch) : e);
  await _continentCommit(next, { type: 'edit', id: edgeId, before: before });
}

function _continentEdgePopover(e, ev) {
  const idx = _continentItemIndex();
  const s = e.style || {};
  const esc = _continentEsc;
  const option = (list, val) => list.map(o =>
    '<option value="' + o[0] + '"' + (o[0] === val ? ' selected' : '') + '>' + o[1] + '</option>').join('');
  const dashOpts = option([['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']], s.dash || 'solid');
  const colorOpts = option([['gold', '暖金（默认）'], ['region', '跟海域色'], ['neutral', '中性']], s.color || 'gold');
  const widthOpts = option([['thin', '细'], ['normal', '中'], ['thick', '粗']], s.width || 'normal');
  const routeOpts = option([['detour', '绕行（默认）'], ['straight', '直连'], ['lane', '沿边缘车道']], s.route || 'detour');
  // 换锚点卡：两端各列自己岛上的卡（学习顺序），代表卡口径不变
  const itemsOf = sid => (( _continentData && _continentData.clusters) || [])
    .filter(c => c.sessionId === sid)
    .flatMap(c => c.items || []);
  const anchorOpts = (sid, cur) => option(
    itemsOf(sid).map(it => [it.itemId, it.title || it.itemId]), cur);
  const html =
    '<div class="continent-pop-title">我的航线' + (e.label ? ' · ' + esc(e.label) : '') + '</div>' +
    '<div class="continent-pop-line">' + esc(idx.items[e.fromItem] || '？') +
    ' ↔ ' + esc(idx.items[e.toItem] || '？') + '</div>' +
    '<div class="continent-route-form">' +
      '<div class="continent-pop-row"><input class="continent-pop-input" data-label-input' +
        ' value="' + esc(e.label || '') + '" maxlength="40" placeholder="备注（如：同为波动现象）"></div>' +
      '<div class="continent-route-grid">' +
        '<label>线型<select data-style="dash">' + dashOpts + '</select></label>' +
        '<label>颜色<select data-style="color">' + colorOpts + '</select></label>' +
        '<label>粗细<select data-style="width">' + widthOpts + '</select></label>' +
        '<label>走线<select data-style="route">' + routeOpts + '</select></label>' +
      '</div>' +
      '<div class="continent-route-grid">' +
        '<label>这端卡<select data-anchor="from">' + anchorOpts(e.fromSession, e.fromItem) + '</select></label>' +
        '<label>那端卡<select data-anchor="to">' + anchorOpts(e.toSession, e.toItem) + '</select></label>' +
      '</div>' +
    '</div>' +
    '<div class="continent-pop-actions is-wrap">' +
      '<button class="continent-pop-btn" data-act="save-label">存备注</button>' +
      '<button class="continent-pop-btn is-quiet" data-act="toggle-label">' + (s.noLabel ? '显示备注标签' : '隐藏备注标签') + '</button>' +
      '<button class="continent-pop-btn is-quiet" data-act="hide">' + (s.hidden ? '取消隐藏' : '隐藏（留数据）') + '</button>' +
      '<button class="continent-pop-btn is-danger" data-act="remove">删除航线</button>' +
    '</div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-style]').forEach(sel => sel.addEventListener('change', async () => {
    const patch = { style: Object.assign({}, s) };
    patch.style[sel.getAttribute('data-style')] = sel.value;
    try { await _continentEditEdge(e.id, patch); } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  }));
  el.querySelectorAll('[data-anchor]').forEach(sel => sel.addEventListener('change', async () => {
    const patch = sel.getAttribute('data-anchor') === 'from'
      ? { fromItem: sel.value } : { toItem: sel.value };
    try { await _continentEditEdge(e.id, patch); } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  }));
  const labelInput = el.querySelector('[data-label-input]');
  const saveLabel = async () => {
    const v = labelInput ? String(labelInput.value || '').slice(0, 40) : '';
    try {
      await _continentEditEdge(e.id, { label: v });
      _continentClosePopover();
    } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
  };
  const saveBtn = el.querySelector('[data-act="save-label"]');
  if (saveBtn) saveBtn.addEventListener('pointerdown', e2 => { e2.stopPropagation(); saveLabel(); });
  if (labelInput) labelInput.addEventListener('keydown', ev2 => {
    if (ev2.key === 'Enter') saveLabel();
  });
  el.querySelectorAll('[data-act]').forEach(btn => {
    const act = btn.getAttribute('data-act');
    if (act === 'save-label') return;
    btn.addEventListener('pointerdown', async e2 => {
      e2.stopPropagation();
      if (act === 'remove') {
        _continentClosePopover();
        try {
          await _continentRemoveUserEdges([e.id]);
          _continentToast('已删除（Ctrl+Z 可撤销）');
        } catch (err) { _continentToast('删除失败：' + (err && err.message || err)); }
      } else if (act === 'hide') {
        try {
          await _continentEditEdge(e.id, { style: Object.assign({}, s, { hidden: !s.hidden }) });
          _continentClosePopover();
        } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
      } else if (act === 'toggle-label') {
        try {
          await _continentEditEdge(e.id, { style: Object.assign({}, s, { noLabel: !s.noLabel }) });
        } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
      }
    });
  });
}

// 全局航线面板（顶栏「航线」按钮）：总开关 + 透明度——关了数据还在，再开就回来
function _continentRoutePrefsPopover(ev) {
  const prefs = _continentRoutePrefs();
  const html =
    '<div class="continent-pop-title">航线显示</div>' +
    '<div class="continent-pop-row"><label class="continent-route-check">' +
      '<input type="checkbox" data-route-on' + (prefs.on ? ' checked' : '') + '> 显示我的航线</label></div>' +
    '<div class="continent-pop-row"><label class="continent-route-check">透明度' +
      '<input type="range" min="0.15" max="1" step="0.05" value="' + prefs.opacity + '" data-route-opacity></label></div>' +
    '<div class="continent-pop-desc">悬停一座岛可单独看它的航线（其余淡出）。单条的样式点线本身调。</div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  const apply = next => {
    _continentSaveRoutePrefs(next);
    if (_continentOpen && _continentData) _continentRender(_continentData);
  };
  const onBox = el.querySelector('[data-route-on]');
  if (onBox) onBox.addEventListener('change', () => {
    apply({ on: onBox.checked, opacity: _continentRoutePrefs().opacity });
  });
  const range = el.querySelector('[data-route-opacity]');
  if (range) range.addEventListener('input', () => {
    apply({ on: _continentRoutePrefs().on, opacity: Number(range.value) });
  });
}

// 悬停隔离（「只看选中岛的航线」，零点击零模式）：悬停岛 → 不相关的航线淡出。
// 岛牌点击仍是下钻，两者不冲突
function _continentSetRouteIso(sid) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return;
  if (!sid) {
    world.classList.remove('route-iso');
    world.querySelectorAll('.continent-route, .continent-route-stub, ' +
      '.continent-route-casing, .continent-route-end').forEach(el =>
      el.classList.remove('is-dim', 'is-lit'));
    return;
  }
  world.classList.add('route-iso');
  world.querySelectorAll('.continent-route, .continent-route-stub, ' +
    '.continent-route-casing, .continent-route-end').forEach(el => {
    const sids = String(el.getAttribute('data-sids') || '').split(',');
    const mine = sids.indexOf(sid) >= 0;
    el.classList.toggle('is-lit', mine);
    el.classList.toggle('is-dim', !mine);
  });
}

// ---------- v8 顶栏搜索：在大陆里找岛与概念卡（纯函数 + 轻量 DOM） ----------
// 口径沿铁律「跳转不猜」：唯一命中回车直达；多命中出清单，点哪行去哪行——搜索框
// 绝不替用户挑目标。归一化抹掉空格与大小写（中英混排标题不至于因为一个空格搜不到）；
// 卡片标题优先、摘要兜底——「能量」要能搜到标题里没这两个字、但摘要讲能量的卡。
function _continentSearchNorm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '');
}

function _continentSearchMatches(data, query, limit) {
  const q = _continentSearchNorm(query);
  const out = [];
  if (!q) return out;
  const cap = Math.max(1, Number(limit) || 30);
  ((data && data.clusters) || []).forEach(c => {
    const sid = String(c.sessionId || '');
    if (_continentSearchNorm(c.title).indexOf(q) >= 0) {
      out.push({ type: 'island', sid: sid, itemId: '',
                 title: c.title || '未命名画布', sub: (c.itemCount || 0) + ' 个概念' });
    }
    (c.items || []).forEach(it => {
      const titleHit = _continentSearchNorm(it.title).indexOf(q) >= 0;
      const summaryHit = !titleHit && _continentSearchNorm(it.summary).indexOf(q) >= 0;
      if (!titleHit && !summaryHit) return;
      out.push({ type: 'item', sid: sid, itemId: String(it.itemId || ''),
                 title: it.title || '', sub: c.title || '', viaSummary: summaryHit });
    });
  });
  // 标题命中排前、摘要命中靠后；同档保持投影顺序（sort 稳定）——最重要的行在最上面
  out.sort((a, b) => (a.viaSummary ? 1 : 0) - (b.viaSummary ? 1 : 0));
  return out.slice(0, cap);
}

// 命中高亮 + 结果清单（DOM）。渲染重画世界层后 is-search-hit 会丢，_continentRender
// 结尾会用同一份 _continentSearchResults 重放（搜索态跨重渲存活，与视口记忆同精神）
function _continentApplySearchHit(results) {
  _continentSearchResults = results || [];
  const pop = document.getElementById('continentSearchPop');
  const world = document.getElementById('continentWorld');
  if (world && world.querySelectorAll) {
    world.querySelectorAll('.is-search-hit').forEach(el => el.classList.remove('is-search-hit'));
  }
  if (pop) {
    if (!_continentSearchResults.length) {
      pop.hidden = true;
      pop.innerHTML = '';
    } else {
      pop.innerHTML = _continentSearchResults.map((r, i) =>
        '<button class="continent-search-row" data-search-idx="' + i + '">' +
          '<span class="continent-search-row-title">' + _continentEsc(r.title) + '</span>' +
          '<span class="continent-search-row-sub">' +
            (r.type === 'item' ? _continentEsc(r.sub) : _continentEsc(r.sub)) + '</span>' +
        '</button>').join('') +
        '<div class="continent-search-foot">' + _continentSearchResults.length +
        ' 个结果 · 点行跳转' + (_continentSearchResults.length === 1 ? '，回车直达' : '') + '</div>';
      pop.hidden = false;
      pop.querySelectorAll('[data-search-idx]').forEach(btn =>
        btn.addEventListener('pointerdown', e => {
          e.stopPropagation();
          const r = _continentSearchResults[Number(btn.getAttribute('data-search-idx'))];
          if (r) _continentSearchJump(r);
        }));
    }
  }
  if (world && world.querySelectorAll) {
    _continentSearchResults.forEach(r => {
      if (r.type === 'item') {
        const el = _continentNodeEl(r.itemId);
        if (el && el.classList) el.classList.add('is-search-hit');
      } else {
        const el = world.querySelector('.continent-cluster[data-session-id="' +
          String(r.sid).replace(/"/g, '\\"') + '"]');
        if (el && el.classList) el.classList.add('is-search-hit');
      }
    });
  }
}

function _continentSearchUpdate() {
  const input = document.getElementById('continentSearch');
  if (!input) return;
  const q = String(input.value || '');
  _continentApplySearchHit(q ? _continentSearchMatches(_continentData, q) : []);
}

function _continentSearchGo() {
  if (_continentSearchResults.length === 1) _continentSearchJump(_continentSearchResults[0]);
}

function _continentSearchJump(r) {
  _continentSearchClear();
  enterContinentSession(r.sid, r.itemId || '');
}

function _continentSearchClear() {
  const input = document.getElementById('continentSearch');
  if (input && input.value) input.value = '';
  _continentApplySearchHit([]);
}

// ---------- v8 概念族表编辑（顶栏「族表」）：汇聚的证据从此可养 ----------
// 族表是 ❖ 城市与海域的证据来源（v6/v7）。此前改表只能手改 KV——编辑入口落在大
// 陆顶栏（数据面板从未存在，v7.1b 待确认清单里那句「数据面板」一并纠正）。语义沿
// v6：KV `continent_families` 覆盖内置同名族，删除 KV 覆盖即恢复内置；保存后投影
// 自动重算，名单变了旧 Φ 打标因 gateVersion 变化作废（服务端既有口径，不用重写）。
// 归类纠正记录（「从纠正中学习」第一期）也在这层清空——它们都是「大陆的自有记忆」。

function _continentFamilySourceLabel(source) {
  if (source === 'builtin') return '内置';
  if (source === 'user') return '你指定';
  return '自定义';
}

// 术语输入解析（纯函数）：顿号/逗号/分号/空白都当分隔——用户不该去想「该用哪个分隔符」
function _continentFamilyParseTerms(text) {
  return String(text || '').split(/[、,，;；\s]+/)
    .map(t => _continentClipText(t, 24))
    .filter(t => t.length >= 2);
}

// KV 族表规范化（纯函数，与服务端 families_from_payload 同口径）：限长、去重、丢
// 无效项、总量封顶。前端先挡一层是体验（立刻报错），服务端兜底同一条尺子是纪律
function _continentFamilyNormalizeList(raw) {
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach(f => {
    if (!f || typeof f !== 'object' || out.length >= CONTINENT_FAMILY_LIMIT) return;
    const canonical = _continentClipText(f.canonical, 16);
    if (!canonical) return;
    const terms = [];
    (Array.isArray(f.terms) ? f.terms : []).forEach(t => {
      const s = _continentClipText(t, 24);
      if (s.length >= 2 && terms.indexOf(s) < 0 && terms.length < CONTINENT_FAMILY_TERMS_MAX) {
        terms.push(s);
      }
    });
    if (!terms.length) return;
    out.push({ canonical: canonical, terms: terms,
               source: f.source === 'user' ? 'user' : 'custom' });
  });
  return out;
}

async function _continentLoadCorrectionCount() {
  try {
    const r = await fetch(CONTINENT_WEIGHTS_API, { cache: 'no-cache' });
    if (!r.ok) return 0;
    const j = await r.json();
    const v = j && j.value;
    return (v && Array.isArray(v.log)) ? v.log.length : 0;
  } catch (e) { return 0; }
}

// 纠正信号落盘：把岛挪出机器判断 = 一次纠正，方向（从哪个领域→到哪个领域）追加进
// KV。本期只采集 + 图例可见 + 可清空；「≥5 次同向自动微调权重」是二期，攒够真实
// 数据才接（大陆计划动工前优化④的口径）。记录失败不阻断纠正本身（纠正已生效）。
async function _continentRecordCorrection(sid, fromDomain, toDomain) {
  try {
    let log = [];
    try {
      const r = await fetch(CONTINENT_WEIGHTS_API, { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        const v = j && j.value;
        if (v && Array.isArray(v.log)) log = v.log.slice(-499);
      }
    } catch (e) { /* 读不到就当空记录 */ }
    log.push({ from: fromDomain || null, to: toDomain || null, sid: String(sid || ''), at: Date.now() });
    const resp = await fetch(CONTINENT_WEIGHTS_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { log: log } }),
    });
    if (!resp.ok) return;
    _continentCorrectionCount = log.length;
    if (_continentOpen && _continentRegionInfo) {
      _continentRenderLegend(_continentRegionInfo, _continentData);
    }
  } catch (e) { /* 信号采集失败不影响纠正本身 */ }
}

// 保存 KV 后刷新投影（与 Φ 归类收尾同一口径：刷失败不丢已落盘的产物，下次打开自然生效）
async function _continentRefreshAfterFamilies() {
  try {
    const fresh = await _continentFetchData();
    _continentData = fresh;
    if (_continentOpen) { _continentRender(fresh); _continentUpdateTools(); }
  } catch (e) { /* 刷新失败下次打开自然生效 */ }
}

function _continentFamilyRowHtml(f) {
  const terms = (f && f.terms) || [];
  const preview = terms.slice(0, 6).map(_continentEsc).join('、') + (terms.length > 6 ? ' …' : '');
  return '<div class="continent-family-row" data-family-canonical="' + _continentEsc(f.canonical) + '">' +
    '<div class="continent-family-line">' +
      '<span class="continent-family-name">' + _continentEsc(f.canonical) + '</span>' +
      '<span class="continent-family-src">' + _continentEsc(_continentFamilySourceLabel(f.source)) + '</span>' +
      '<span class="continent-family-terms" title="' + _continentEsc(terms.join('、')) + '">' + preview + '</span>' +
      '<button class="continent-pop-btn is-quiet" data-family-edit>改</button>' +
    '</div>' +
  '</div>';
}

// v10 补词建议行（纯函数）：词条 → 目标族 + 证据卡。机器只建议，落笔是两个按钮——
// 「收下」把词条并进族表 KV，「不要」记进拒绝 KV（证据没长出来不再提）
function _continentSuggestRowHtml(s) {
  if (!s || !s.family || !s.term) return '';
  const cards = Array.isArray(s.cards) ? s.cards : [];
  const preview = cards.slice(0, 3).map(c => _continentEsc((c && c.title) || '')).join('、') +
    (cards.length > 3 ? ' …' : '');
  return '<div class="continent-family-row continent-family-suggest"' +
      ' data-suggest-family="' + _continentEsc(s.family) + '"' +
      ' data-suggest-term="' + _continentEsc(s.term) + '">' +
    '<div class="continent-family-line">' +
      '<span class="continent-family-name">＋' + _continentEsc(s.term) + '</span>' +
      '<span class="continent-family-src">→ ' + _continentEsc(s.family) + '</span>' +
      '<button class="continent-pop-btn" data-suggest-accept>收下</button>' +
      '<button class="continent-pop-btn is-quiet" data-suggest-reject>不要</button>' +
    '</div>' +
    '<div class="continent-family-line continent-suggest-evidence">' +
      (s.regrown ? '<span class="continent-suggest-note">上次你拒过，这次证据更多</span>' : '') +
      '<span class="continent-family-terms" title="' +
        _continentEsc(cards.map(c => (c && c.title) || '').join('、')) + '">来自 ' +
        cards.length + ' 张卡：' + preview + '</span>' +
    '</div>' +
  '</div>';
}

// ---------- v10 第二期 新族候选（无主抱团簇 → Φ 起名 → 用户裁决） ----------
// 与补词建议互斥互补：补词管「像某个已有族」的卡，这里管「哪个族都不像但彼此抱团」
// 的卡。起名是花钱的调用：点「让 Φ 起名」才调（触发不自动），结果缓存 KV，
// 一个簇（含近重复簇）只问一次。

// Φ 起名的输出契约：一行 JSON。格式约定在 system 与 user 两条消息里都写
//（与 v5.3 问 Φ 同一条纪律），判读才不是猜谜。
function _continentNameMessages(cluster, knownNames) {
  const cards = ((cluster && cluster.cards) || []).slice(0, 10);
  const known = Array.isArray(knownNames) ? knownNames : [];
  const list = cards.map((c, i) =>
    (i + 1) + '. ' + ((c && c.title) || '（无标题）') +
    ((c && c.summary) ? '——' + c.summary : '')).join('\n');
  const lines = [
    '用户的知识库里有一批知识卡：它们不属于下面任何已知领域（语义向量都离得很远），' +
    '但彼此语义相近，可能是一个花名册上还没有的新领域。',
    '',
    '已知领域名单：' + (known.length ? known.join('、') : '（空）'),
    '候选卡（共 ' + cards.length + ' 张）：',
    list,
    '',
    '请判断这批卡：',
    '- verdict=new：它们够格成一个新领域——给出规范名 name（2~8 字，像教科书章节名）' +
    '与 terms（3~6 个代表词条，出现在卡片标题里就有意义）。',
    '- verdict=merge：它们其实属于名单中某个已有领域——name 填该领域名（必须从名单里原样选），' +
    'terms 给出应补进该领域的词条。',
    '- verdict=none：证据不足，不建议建。',
    'reason 用不超过 40 字说明依据。',
  ].join('\n');
  return [
    { role: 'system', content: '你是知识大陆的助手 Φ。只输出一行 JSON，不要 markdown 代码围栏，不要解释：' +
      '{"verdict":"new|merge|none","name":"领域名","terms":["词条"],"reason":"一句话理由"}。' },
    { role: 'user', content: lines },
  ];
}

// 判读（纯函数）：剥思考块 → 抠出第一段 JSON → 校验。verdict=merge 时 name 必须
// 在已知名单里（模型编造名单外的领域一律降级为 none——专家名单固定，铁律）；
// verdict=new 但 name 与已有族撞名 → 同语义降级为 merge（词条收进已有族）。
// 判不出返回 null，调用方给「Φ 没判出来」的提示，绝不猜。
function _continentParseNameVerdict(raw, knownNames) {
  let text = typeof _stripThinkText === 'function'
    ? _stripThinkText(String(raw || '')) : String(raw || '');
  text = text.replace(/```(?:json)?/gi, '');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  let verdict = String(obj.verdict || '').trim();
  if (['new', 'merge', 'none'].indexOf(verdict) < 0) return null;
  const reason = String(obj.reason || '').trim().slice(0, 60);
  const known = Array.isArray(knownNames) ? knownNames : [];
  let name = _continentClipText(obj.name, 16);
  let terms = (Array.isArray(obj.terms) ? obj.terms : [])
    .map(t => _continentClipText(t, 24)).filter(t => t.length >= 2);
  terms = terms.filter((t, i) => terms.indexOf(t) === i).slice(0, 6);
  if (verdict === 'merge') {
    if (!name || known.indexOf(name) < 0) {
      // 编造的领域名不可信（专家名单固定）：不整条作废，降级为「证据不足」
      return { verdict: 'none', name: '', terms: [], reason: 'Φ 给的领域不在名单里' };
    }
  } else if (verdict === 'new') {
    if (!name) return null;
    if (known.indexOf(name) >= 0) {  // 撞名：它说的其实是已有族的漏
      verdict = 'merge';
    } else if (!terms.length) {
      verdict = 'none';  // 建新族却不给词条 = 没法落表
    }
  }
  return { verdict: verdict, name: name, terms: terms, reason: reason };
}

// 命名缓存命中（纯函数）：先精确 key；没有再按卡片重叠扫——同一簇长了几张新卡后
// key 会变，但只要与某条已命名簇的重叠 ≥ 六成，就复用旧判读（一个簇一辈子只烧
// 一次 API 钱）。命中返回缓存的判读，未命中 null。
function _continentClusterCacheHit(cluster, named) {
  if (!cluster || !named || typeof named !== 'object') return null;
  const exact = named[cluster.key];
  if (exact && exact.verdict) return exact;
  const ids = ((cluster.cards) || []).map(c => (c && c.id) || '');
  if (!ids.length) return null;
  const idSet = new Set(ids);
  for (const k in named) {
    const entry = named[k];
    const cachedIds = (entry && Array.isArray(entry.cards)) ? entry.cards : null;
    if (!cachedIds || !entry.verdict) continue;
    const shared = cachedIds.filter(cid => idSet.has(cid)).length;
    if (shared * 10 >= Math.min(cachedIds.length, ids.length) * 6) return entry;
  }
  return null;
}

// 新族候选行（纯函数）：三种态——未起名（让 Φ 起名按钮）/ 已判 new（建族/不要）/
// 已判 merge 或 none（处置提示）。全部插值过 _continentEsc。
function _continentClusterRowHtml(cluster, namedEntry, dismissed) {
  if (!cluster || !Array.isArray(cluster.cards) || !cluster.cards.length) return '';
  const preview = cluster.cards.slice(0, 3)
    .map(c => _continentEsc((c && c.title) || '')).join('、') +
    (cluster.size > 3 ? ' …' : '');
  const regrown = dismissed && dismissed.cards != null &&
    cluster.size > Number(dismissed.cards) + 2;
  const head = '<div class="continent-family-line">' +
      '<span class="continent-family-name">疑似新领域 · ' + cluster.size + ' 张卡</span>' +
      (regrown ? '<span class="continent-suggest-note">上次你拒过，这次证据更多</span>' : '') +
      '<button class="continent-pop-btn is-quiet" data-cluster-dismiss>不要</button>' +
    '</div>' +
    '<div class="continent-family-line continent-suggest-evidence">' +
      '<span class="continent-family-terms" title="' +
        _continentEsc(cluster.cards.map(c => (c && c.title) || '').join('、')) + '">来自：' +
        preview + '</span>' +
    '</div>';
  const body = namedEntry && namedEntry.verdict
    ? (namedEntry.verdict === 'new'
        ? '<div class="continent-family-line">' +
            '<span class="continent-family-name">Φ 提议：' + _continentEsc(namedEntry.name) + '</span>' +
            '<span class="continent-family-terms">' +
              _continentEsc((namedEntry.terms || []).join('、')) + '</span>' +
            '<button class="continent-pop-btn" data-cluster-create>建族</button>' +
          '</div>' +
          '<div class="continent-family-line continent-suggest-evidence">' +
            '<span class="continent-pop-phi-badge is-worth">Φ</span>' +
            '<span class="continent-family-terms">' + _continentEsc(namedEntry.reason || '') + '</span>' +
          '</div>'
        : namedEntry.verdict === 'merge'
          ? '<div class="continent-family-line">' +
              '<span class="continent-family-name">＋' + _continentEsc((namedEntry.terms || []).join('、')) + '</span>' +
              '<span class="continent-family-src">→ ' + _continentEsc(namedEntry.name) + '</span>' +
              '<button class="continent-pop-btn" data-cluster-merge>收下</button>' +
            '</div>' +
            '<div class="continent-family-line continent-suggest-evidence">' +
              '<span class="continent-pop-phi-badge">Φ</span>' +
              '<span class="continent-family-terms">' +
                _continentEsc('Φ 认为这是「' + namedEntry.name + '」的漏：' + (namedEntry.reason || '')) +
              '</span>' +
            '</div>'
          : '<div class="continent-family-line continent-suggest-evidence">' +
              '<span class="continent-pop-phi-badge">Φ</span>' +
              '<span class="continent-family-terms">Φ：证据不足' +
                (namedEntry.reason ? '——' + _continentEsc(namedEntry.reason) : '') + '</span>' +
            '</div>')
    : '<div class="continent-family-line">' +
        '<button class="continent-pop-btn" data-cluster-name>让 Φ 起名</button>' +
        '<span class="continent-family-terms">起名是 AI 调用（一次一条，结果会记住）</span>' +
      '</div>';
  return '<div class="continent-family-row continent-family-suggest"' +
      ' data-cluster-key="' + _continentEsc(cluster.key) + '">' + head + body + '</div>';
}

async function _continentFamilyPopover(ev) {
  let merged = [];
  let limit = CONTINENT_FAMILY_LIMIT;
  try {
    const r = await fetch(CONTINENT_FAMILIES_API, { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      merged = (j && Array.isArray(j.families)) ? j.families : [];
      limit = (j && j.limit) || limit;
    }
  } catch (e) { /* 拉不到就只渲染 KV 侧（查空是正常路径） */ }
  let kvList = [];
  try {
    const r = await fetch(CONTINENT_FAMILIES_KV_API, { cache: 'no-cache' });
    if (r.ok) {
      const j = await r.json();
      const v = j && j.value;
      kvList = _continentFamilyNormalizeList(
        (v && Array.isArray(v.families)) ? v.families : (Array.isArray(v) ? v : []));
    }
  } catch (e) { /* 读不到就当空表 */ }
  const builtinCount = merged.filter(f => f.source === 'builtin').length;
  const esc = _continentEsc;
  const html =
    '<div class="continent-pop-title">概念族表（' + merged.length + ' / 上限 ' + limit + '）</div>' +
    '<div class="continent-pop-desc">族是 ❖ 城市与海域的证据来源：卡片标题或岛名命中术语、且跨 ≥2 座岛，' +
    '就会连成一座 ❖ 城市、聚进同一片海域。内置 ' + builtinCount + ' 族是底线；你保存过的族以内表为准。' +
    '保存后地图自动重算（名单变了，旧 Φ 打标自动作废重打）。</div>' +
    '<div class="continent-family-list" data-family-list>' +
      merged.map(f => _continentFamilyRowHtml(f)).join('') +
    '</div>' +
    '<div data-suggest-section></div>' +
    '<div data-cluster-section></div>' +
    '<div class="continent-pop-title" style="margin-top:8px">新增族</div>' +
    '<div class="continent-family-editor">' +
      '<div class="continent-pop-row"><input class="continent-pop-input" data-family-new-name maxlength="16" placeholder="族名（如：分析力学）"></div>' +
      '<div class="continent-pop-row"><input class="continent-pop-input" data-family-new-terms placeholder="术语，用顿号或空格隔开（如：拉格朗日方程、哈密顿）"></div>' +
      '<div class="continent-pop-actions"><button class="continent-pop-btn" data-family-new-save>新增族</button></div>' +
    '</div>' +
    '<div class="continent-pop-title" style="margin-top:8px">归类纠正记录</div>' +
    '<div class="continent-pop-desc">已记录 <b>' + _continentCorrectionCount + '</b> 次纠正（你把岛挪出机器判断的方向）——' +
    '这是将来「自动微调领域判断」的依据；现在只记录，不动地图。</div>' +
    (_continentCorrectionCount
      ? '<div class="continent-pop-actions"><button class="continent-pop-btn is-danger" data-correction-clear>清空记录</button></div>'
      : '');
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;

  const persist = async next => {
    const resp = await fetch(CONTINENT_FAMILIES_KV_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: { families: next } }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    await _continentRefreshAfterFamilies();
    _continentToast('族表已保存，地图已重算');
    _continentFamilyPopover(ev);  // 重开弹层：重拉合并视图，行内编辑态归零
  };

  // v10 补词建议（语义找亲）：收下 = 词条并进该族走 persist（与手动加词同一条 KV
  // 通道）；不要 = 记进拒绝 KV——服务端证据没长出来就不再算这条建议（防骚扰）。
  // 记录失败不阻断「收下」本身（词条已落族表），只影响「不再提」的记性。
  const acceptSuggestion = async s => {
    const fam = merged.find(f => f.canonical === s.family);
    const kvIdx = kvList.findIndex(f => f.canonical === s.family);
    let terms;
    if (kvIdx >= 0) terms = kvList[kvIdx].terms.slice();
    else if (fam) terms = (fam.terms || []).slice();
    else { _continentToast('找不到目标族了——地图刷新后重试'); return; }
    if (terms.indexOf(s.term) < 0) terms.push(s.term);
    const entry = { canonical: s.family,
                    terms: terms.slice(0, CONTINENT_FAMILY_TERMS_MAX), source: 'user' };
    let next = kvList.slice();
    if (kvIdx >= 0) next[kvIdx] = entry; else next = next.concat([entry]);
    if (next.length > CONTINENT_FAMILY_LIMIT) { _continentToast('族表上限 ' + CONTINENT_FAMILY_LIMIT + ' 个'); return; }
    try { await persist(next); } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
  };
  const rejectSuggestion = async s => {
    try {
      let state = {};
      try {
        const r = await fetch(CONTINENT_FAMILY_SUGGEST_KV_API, { cache: 'no-cache' });
        if (r.ok) {
          const j = await r.json();
          const v = j && j.value;
          if (v && typeof v === 'object') state = v;
        }
      } catch (e) { /* 读不到就当空记录 */ }
      const rejected = (state.rejected && typeof state.rejected === 'object')
        ? state.rejected : (state.rejected = {});
      const famRej = (rejected[s.family] && typeof rejected[s.family] === 'object')
        ? rejected[s.family] : (rejected[s.family] = {});
      famRej[s.term] = { cards: ((s.cards || []).length), at: Date.now() };
      const resp = await fetch(CONTINENT_FAMILY_SUGGEST_KV_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: Object.assign({ version: 1 }, state) }),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      _continentToast('已记住：这条建议不再提（证据明显变多时会再问一次）');
      _continentFamilyPopover(ev);  // 重开弹层：建议区按最新拒绝记录重算
    } catch (err) { _continentToast('记录失败：' + (err && err.message || err)); }
  };

  // ---------- v10 第二期：新族候选（无主抱团簇） ----------
  // 状态三件套都落 KV continent_family_suggestions：named=Φ 判读缓存（一个簇只烧
  // 一次 API），dismissed=用户拒过的簇（证据没长出来不再端上来）。命名/建族都是
  // 用户点出来的：触发不自动，落笔不自动。
  const loadSuggestState = async () => {
    try {
      const r = await fetch(CONTINENT_FAMILY_SUGGEST_KV_API, { cache: 'no-cache' });
      if (!r.ok) return {};
      const j = await r.json();
      const v = j && j.value;
      return (v && typeof v === 'object') ? v : {};
    } catch (e) { return {}; }
  };
  const saveSuggestState = async state => {
    const resp = await fetch(CONTINENT_FAMILY_SUGGEST_KV_API, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: Object.assign({ version: 1 }, state) }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
  };
  // 族表 KV 的当下快照（写前重读用）：闭包里的 kvList 是弹层打开时的，直接拼会
  // 覆盖期间别处落笔的族。规范化走同一把 _continentFamilyNormalizeList 尺子。
  const _continentFetchKvFamilies = async () => {
    try {
      const r = await fetch(CONTINENT_FAMILIES_KV_API, { cache: 'no-cache' });
      if (!r.ok) return kvList;
      const j = await r.json();
      const v = j && j.value;
      return _continentFamilyNormalizeList(
        (v && Array.isArray(v.families)) ? v.families : (Array.isArray(v) ? v : []));
    } catch (e) { return kvList; }
  };
  const knownNames = merged.map(f => f.canonical);
  const bindClusterRows = box => {
    box.querySelectorAll('.continent-family-suggest[data-cluster-key]').forEach(row => {
      const key = row.getAttribute('data-cluster-key');
      const cluster = clusterList.find(c => c && c.key === key);
      if (!cluster) return;
      const nameBtn = row.querySelector('[data-cluster-name]');
      const createBtn = row.querySelector('[data-cluster-create]');
      const mergeBtn = row.querySelector('[data-cluster-merge]');
      const dismissBtn = row.querySelector('[data-cluster-dismiss]');
      if (nameBtn) nameBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const model = (typeof getActiveModelForRole === 'function')
          ? (getActiveModelForRole('graph') || getActiveModelForRole('agent')) : null;
        if (!model) { _continentToast('先在「模型设置」里配置主模型，才能让 Φ 起名'); return; }
        nameBtn.disabled = true; nameBtn.textContent = 'Φ 看着…';
        try {
          if (typeof proxyChatWithModel !== 'function') throw new Error('模型代理通道不可用');
          const resp = await proxyChatWithModel(model, {
            messages: _continentNameMessages(cluster, knownNames),
            stream: false,
            session_bucket: 'phymathia-continent',
          });
          const data = await resp.json();
          const raw = data && data.choices && data.choices[0] && data.choices[0].message
            ? data.choices[0].message.content : '';
          const verdict = _continentParseNameVerdict(raw, knownNames);
          if (!verdict) throw new Error('Φ 的回答没认出来，可再试一次');
          const state = await loadSuggestState();
          const named = (state.named && typeof state.named === 'object')
            ? state.named : (state.named = {});
          named[cluster.key] = Object.assign({}, verdict, {
            at: Date.now(), cards: cluster.cards.map(c => c.id),
          });
          await saveSuggestState(state);
          renderClusterSection(box, state);  // 就地重渲：不重开弹层、不重拉建议
          bindClusterRows(box);  // 重渲换掉了 DOM，落笔按钮必须重新挂 handler
        } catch (err) {
          _continentToast('Φ 起名失败：' + (err && err.message || err));
          nameBtn.disabled = false; nameBtn.textContent = '让 Φ 起名';
        }
      });
      if (createBtn) createBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const state = await loadSuggestState();
        const entry = _continentClusterCacheHit(cluster, state.named);
        if (!entry || entry.verdict !== 'new') return;
        // 写前重读 KV：闭包里的 kvList 是弹层打开时的快照，直接拼会覆盖期间
        // 别处落笔的族（先后两次保存，后者必须以前者为基础）
        const freshKvList = await _continentFetchKvFamilies();
        if (freshKvList.some(f => f.canonical === entry.name)) {
          _continentToast('已有同名族——收下词条走「收下」按钮'); return;
        }
        if (freshKvList.length >= CONTINENT_FAMILY_LIMIT) {
          _continentToast('族表上限 ' + CONTINENT_FAMILY_LIMIT + ' 个'); return;
        }
        try {
          await persist(freshKvList.concat([{
            canonical: entry.name,
            terms: (entry.terms || []).slice(0, CONTINENT_FAMILY_TERMS_MAX),
            source: 'user',
          }]));
        } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
      });
      if (mergeBtn) mergeBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const state = await loadSuggestState();
        const entry = _continentClusterCacheHit(cluster, state.named);
        if (!entry || entry.verdict !== 'merge') return;
        const freshKvList = await _continentFetchKvFamilies();
        const kvIdx = freshKvList.findIndex(f => f.canonical === entry.name);
        const fam = merged.find(f => f.canonical === entry.name);
        let terms;
        if (kvIdx >= 0) terms = freshKvList[kvIdx].terms.slice();
        else if (fam) terms = (fam.terms || []).slice();
        else { _continentToast('找不到目标族了——地图刷新后重试'); return; }
        (entry.terms || []).forEach(t => { if (terms.indexOf(t) < 0) terms.push(t); });
        const nextEntry = { canonical: entry.name,
                            terms: terms.slice(0, CONTINENT_FAMILY_TERMS_MAX), source: 'user' };
        let next = freshKvList.slice();
        if (kvIdx >= 0) next[kvIdx] = nextEntry; else next = next.concat([nextEntry]);
        if (next.length > CONTINENT_FAMILY_LIMIT) {
          _continentToast('族表上限 ' + CONTINENT_FAMILY_LIMIT + ' 个'); return;
        }
        try { await persist(next); } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
      });
      if (dismissBtn) dismissBtn.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          const state = await loadSuggestState();
          const dismissed = (state.dismissed && typeof state.dismissed === 'object')
            ? state.dismissed : (state.dismissed = {});
          dismissed[cluster.key] = { cards: cluster.size, at: Date.now() };
          await saveSuggestState(state);
          _continentToast('已记住：这个候选不再提（证据明显变多时会再问一次）');
          renderClusterSection(box, state);
          bindClusterRows(box);  // 重渲换掉了 DOM，按钮必须重新挂 handler
        } catch (err) { _continentToast('记录失败：' + (err && err.message || err)); }
      });
    });
  };
  const renderClusterSection = (box, state) => {
    const named = (state && state.named && typeof state.named === 'object') ? state.named : {};
    const dismissed = (state && state.dismissed && typeof state.dismissed === 'object') ? state.dismissed : {};
    const rows = clusterList.filter(c => {
      if (!c || !c.key) return false;
      const d = dismissed[c.key];
      // 拒过的簇闭嘴（防骚扰），证据长出 2+ 张才重新开口（与补词同一记性口径）
      if (d && c.size <= Number(d.cards || 0) + 2) return false;
      return true;
    }).map(c => _continentClusterRowHtml(c, _continentClusterCacheHit(c, named),
                                         dismissed[c.key])).join('');
    box.innerHTML = rows
      ? '<div class="continent-pop-title" style="margin-top:8px">新领域候选</div>' +
        '<div class="continent-pop-desc">这些卡不属于任何已知领域，但彼此抱团——可能是一个' +
        '花名册上还没有的新领域。让 Φ 提个名，你裁决；机器不会自己落笔。</div>' + rows
      : '';
  };

  // 行内编辑：点「改」→ 该行换成词条编辑器（芯片可删 + 输入可加 + 保存/取消/删除）。
  // 绑定按行闭包：取消/保存后行内 HTML 会换掉，bindRow 必须对新内容重绑一次
  const enterEdit = (row, fam) => {
    const kvIdx = kvList.findIndex(f => f.canonical === fam.canonical);
    const working = (kvIdx >= 0 ? kvList[kvIdx].terms.slice() : fam.terms.slice());
    const render = () => {
      row.innerHTML =
        '<div class="continent-family-line">' +
          '<span class="continent-family-name">' + _continentEsc(fam.canonical) + '</span>' +
          '<span class="continent-family-src">' + _continentEsc(_continentFamilySourceLabel(fam.source)) + '</span>' +
        '</div>' +
        '<div class="continent-family-chips">' +
          working.map((t, i) =>
            '<span class="continent-family-chip">' + _continentEsc(t) +
            '<button data-term-del="' + i + '" title="删除这个词条" aria-label="删除词条">×</button></span>').join('') +
        '</div>' +
        (fam.source === 'builtin' && kvIdx < 0
          ? '<div class="continent-pop-desc">内置族：保存后以你改的名单覆盖内置表（源标记变「你指定」）。</div>' : '') +
        '<div class="continent-pop-row"><input class="continent-pop-input" data-term-add maxlength="24" placeholder="加词条（≥2 字，出现在标题里就有意义）"></div>' +
        '<div class="continent-pop-actions">' +
          '<button class="continent-pop-btn" data-term-save>保存</button>' +
          '<button class="continent-pop-btn is-quiet" data-term-cancel>取消</button>' +
          (kvIdx >= 0 ? '<button class="continent-pop-btn is-danger" data-term-remove>删除这个族</button>' : '') +
        '</div>';
      row.querySelectorAll('[data-term-del]').forEach(del =>
        del.addEventListener('click', ev2 => {
          ev2.stopPropagation();
          working.splice(Number(del.getAttribute('data-term-del')), 1);
          render();
        }));
      const addInput = row.querySelector('[data-term-add]');
      const addTerm = () => {
        const terms = _continentFamilyParseTerms(addInput ? addInput.value : '');
        if (!terms.length) { _continentToast('词条至少要 2 个字'); return; }
        terms.forEach(t => { if (working.indexOf(t) < 0) working.push(t); });
        if (working.length > CONTINENT_FAMILY_TERMS_MAX) working.length = CONTINENT_FAMILY_TERMS_MAX;
        render();
      };
      if (addInput) {
        addInput.addEventListener('pointerdown', ev2 => ev2.stopPropagation());
        addInput.addEventListener('keydown', ev2 => { if (ev2.key === 'Enter') addTerm(); });
      }
      row.querySelectorAll('[data-term-save]').forEach(b2 => b2.addEventListener('click', async ev2 => {
        ev2.stopPropagation();
        if (!working.length) { _continentToast('至少要留一个词条'); return; }
        const next = kvList.slice();
        next[(kvIdx >= 0 ? kvIdx : next.length)] =
          { canonical: fam.canonical, terms: working.slice(0, CONTINENT_FAMILY_TERMS_MAX), source: 'user' };
        if (next.length > CONTINENT_FAMILY_LIMIT) { _continentToast('族表上限 ' + CONTINENT_FAMILY_LIMIT + ' 个'); return; }
        try { await persist(next); } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
      }));
      row.querySelectorAll('[data-term-cancel]').forEach(b2 => b2.addEventListener('click', ev2 => {
        ev2.stopPropagation();
        row.innerHTML = _continentFamilyRowHtml(fam);
        bindRow(row);
      }));
      row.querySelectorAll('[data-term-remove]').forEach(b2 => b2.addEventListener('click', async ev2 => {
        ev2.stopPropagation();
        try {
          await persist(kvList.filter((_, i) => i !== kvIdx));
          _continentToast(fam.source === 'builtin' ? '已删除覆盖，内置词条恢复' : '已删除这个族');
        } catch (err) { _continentToast('删除失败：' + (err && err.message || err)); }
      }));
      const focusAdd = row.querySelector('[data-term-add]');
      if (focusAdd && focusAdd.focus) { try { focusAdd.focus(); } catch (err) { /* 容忍 */ } }
    };
    render();
  };
  const bindRow = row => {
    const btn = row.querySelector('[data-family-edit]');
    if (!btn) return;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const fam = merged.find(f => f.canonical === row.getAttribute('data-family-canonical'));
      if (fam) enterEdit(row, fam);
    });
  };
  el.querySelectorAll('.continent-family-row').forEach(bindRow);

  // v10 补词建议区 + 新领域候选区：弹层先开，两者异步补进来（首算可能含模型加载，
  // 别让弹层干等）。embedEnabled=False（缺模型/缺依赖）或没有候选 → 区块保持空白
  // （查空是正常路径）。补词建议拉一次；新领域候选另需 KV 里的命名/拒绝状态。
  const suggBox = el.querySelector('[data-suggest-section]');
  const clusterBox = el.querySelector('[data-cluster-section]');
  let clusterList = [];
  if (suggBox) {
    try {
      const r = await fetch(CONTINENT_FAMILY_SUGGEST_API, { cache: 'no-cache' });
      if (r.ok) {
        const j = await r.json();
        const sugs = (j && j.embedEnabled && Array.isArray(j.suggestions)) ? j.suggestions : [];
        clusterList = (j && j.embedEnabled && Array.isArray(j.clusters)) ? j.clusters : [];
        if (sugs.length) {
          suggBox.innerHTML =
            '<div class="continent-pop-title" style="margin-top:8px">补词建议</div>' +
            '<div class="continent-pop-desc">这些卡闻起来像某个领域，标题里却没有它的词条——' +
            '多半是族表漏了词。收下后词条进族表，同类卡从此自动归对；不收就一直躺着。</div>' +
            sugs.map(_continentSuggestRowHtml).join('');
          suggBox.querySelectorAll('.continent-family-suggest').forEach(row => {
            const fam = row.getAttribute('data-suggest-family');
            const term = row.getAttribute('data-suggest-term');
            const s = sugs.find(x => x && x.family === fam && x.term === term);
            if (!s) return;
            const acceptBtn = row.querySelector('[data-suggest-accept]');
            const rejectBtn = row.querySelector('[data-suggest-reject]');
            if (acceptBtn) acceptBtn.addEventListener('click', async e => {
              e.stopPropagation();
              await acceptSuggestion(s);
            });
            if (rejectBtn) rejectBtn.addEventListener('click', async e => {
              e.stopPropagation();
              await rejectSuggestion(s);
            });
          });
        }
      }
    } catch (e) { /* 建议拉不到就当没有（查空是正常路径） */ }
  }
  if (clusterBox && clusterList.length) {
    const state = await loadSuggestState();
    renderClusterSection(clusterBox, state);
    bindClusterRows(clusterBox);
  }

  // 新增族
  const newName = el.querySelector('[data-family-new-name]');
  const newTerms = el.querySelector('[data-family-new-terms]');
  const addFamily = async () => {
    const canonical = _continentClipText(newName ? newName.value : '', 16);
    const terms = _continentFamilyParseTerms(newTerms ? newTerms.value : '');
    if (!canonical || !terms.length) { _continentToast('族名和至少一个词条（≥2 字）都要有'); return; }
    if (merged.some(f => f.canonical === canonical)) { _continentToast('已有同名族——点那一行的「改」直接改它'); return; }
    if (kvList.length >= CONTINENT_FAMILY_LIMIT) { _continentToast('族表上限 ' + CONTINENT_FAMILY_LIMIT + ' 个'); return; }
    try {
      await persist(kvList.concat([{ canonical: canonical, terms: terms, source: 'user' }]));
    } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
  };
  const newSave = el.querySelector('[data-family-new-save]');
  if (newSave) newSave.addEventListener('click', e => { e.stopPropagation(); addFamily(); });
  [newName, newTerms].forEach(inp => {
    if (inp) {
      inp.addEventListener('pointerdown', e => e.stopPropagation());
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') addFamily(); });
    }
  });

  // 纠正记录清空（一键复位：二期自动档的权重表也在这层）
  const clearBtn = el.querySelector('[data-correction-clear]');
  if (clearBtn) clearBtn.addEventListener('click', async e => {
    e.stopPropagation();
    try {
      const resp = await fetch(CONTINENT_WEIGHTS_API, { method: 'DELETE' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      _continentCorrectionCount = 0;
      _continentToast('纠正记录已清空');
      if (_continentOpen && _continentRegionInfo) _continentRenderLegend(_continentRegionInfo, _continentData);
      _continentFamilyPopover(ev);
    } catch (err) { _continentToast('清空失败：' + (err && err.message || err)); }
  });
}

// ---------- v2 簇间边：KV 读写 + 撤销栈（只记边操作） ----------
function _continentEdgeList() {
  const d = _continentData || {};
  return ((d.userEdges || []).concat(d.danglingEdges || []));
}

async function _continentCommit(edges, undoEntry) {
  const resp = await fetch(CONTINENT_EDGES_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: edges.slice(0, CONTINENT_USER_EDGE_LIMIT) }),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  if (undoEntry) _continentEdgeUndo.push(undoEntry);
  const data = await _continentFetchData();
  _continentData = data;
  if (_continentOpen) _continentRender(data);  // 布局与边无关，重渲不动视口
  _continentUpdateTools();
}

async function _continentAddUserEdge(fromItem, toItem, label) {
  const dup = (((_continentData && _continentData.userEdges) || []).some(e =>
    (e.fromItem === fromItem && e.toItem === toItem) ||
    (e.fromItem === toItem && e.toItem === fromItem)));
  if (dup) { _continentToast('这两条概念已经连过线了'); return false; }
  const edge = {
    id: 'ce_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    fromItem: String(fromItem), toItem: String(toItem),
    label: String(label || '').slice(0, 40),
    createdAt: Date.now(),
  };
  await _continentCommit(_continentEdgeList().concat([edge]), { type: 'add', edge });
  return true;
}

async function _continentRemoveUserEdges(removeIds) {
  const ids = new Set(removeIds);
  const removed = _continentEdgeList().filter(e => ids.has(e.id));
  if (!removed.length) return;
  await _continentCommit(
    _continentEdgeList().filter(e => !ids.has(e.id)),
    removeIds.length === 1 ? { type: 'remove', edge: removed[0] } : { type: 'bulk', edges: removed });
}

async function _continentUndoEdgeOp() {
  if (!_continentEdgeUndo.length) { _continentToast('没有可撤销的边操作'); return; }
  const op = _continentEdgeUndo.pop();
  _continentUpdateTools();
  try {
    if (op.type === 'add') {
      await _continentCommit(_continentEdgeList().filter(e => e.id !== op.edge.id));
    } else if (op.type === 'edit') {
      // v7.2 单条编辑（样式/锚点/备注/隐藏）：恢复改前快照
      const edges = _continentEdgeList().map(e => e.id === op.id ? op.before : e);
      await _continentCommit(edges);
    } else if (op.type === 'region') {
      // v7.1a 海域操作（挪岛/改名）与边操作共用同一条 Ctrl+Z 栈（大陆打开时截获的约定不变）
      await _continentUndoRegionOp(op);
    } else {
      const restore = op.type === 'bulk' ? op.edges : [op.edge];
      const have = new Set(_continentEdgeList().map(e => e.id));
      await _continentCommit(_continentEdgeList().concat(restore.filter(e => !have.has(e.id))));
    }
    _continentToast('已撤销上一条边操作');
  } catch (err) {
    _continentToast('撤销失败：' + (err && err.message || err));
  }
}

async function _continentCleanDangling() {
  const dangling = ((_continentData && _continentData.danglingEdges) || []);
  if (!dangling.length) return;
  if (typeof window.confirm === 'function' &&
      !window.confirm('大陆上有 ' + dangling.length + ' 条连线的一端已不在（画布被清空或概念被删除），确定移除这些断线吗？')) return;
  try {
    await _continentRemoveUserEdges(dangling.map(e => e.id));
    _continentToast('已清理 ' + dangling.length + ' 条断线（Ctrl+Z 可撤销）');
  } catch (err) {
    _continentToast('清理失败：' + (err && err.message || err));
  }
}

function _continentUpdateTools() {
  const undoBtn = document.getElementById('continentUndoBtn');
  if (undoBtn) undoBtn.hidden = _continentEdgeUndo.length === 0;
  const cleanBtn = document.getElementById('continentCleanBtn');
  if (cleanBtn) {
    const n = ((_continentData && _continentData.danglingEdges) || []).length;
    cleanBtn.hidden = n === 0;
    cleanBtn.textContent = n ? '清理断线 ' + n : '清理断线';
  }
  // v4 折叠清单入口：有折叠才有按钮（没有就不占位）
  const weakBtn = document.getElementById('continentWeakBtn');
  if (weakBtn) {
    const n = (_continentFolded || []).length;
    weakBtn.hidden = n === 0;
    weakBtn.textContent = '折叠 ' + n + ' 条';
  }
  // v7.1b Φ 归类入口：有「归属缺失」的卡才出现（有可靠归属的不烧调用）
  const gateBtn = document.getElementById('continentGateBtn');
  if (gateBtn && !gateBtn.disabled) {
    const unclassified = (( _continentData && _continentData.clusters) || [])
      .filter(c => !c.domain)
      .reduce((acc, c) => acc + (c.itemCount || 0), 0);
    gateBtn.hidden = unclassified === 0;
    gateBtn.textContent = 'Φ 归类 ' + unclassified + ' 张';
  }
  // v7.2 航线入口：有航线才有全局显示开关
  const routeBtn = document.getElementById('continentRouteBtn');
  if (routeBtn) {
    const n = (((_continentData && _continentData.userEdges) || []).length)
      + (((_continentData && _continentData.danglingEdges) || []).length);
    routeBtn.hidden = n === 0;
  }
}

// ---------- 连接模式（v2 画边入口） ----------
function _continentSetLinkMode(on) {
  _continentLinkMode = !!on;
  _continentLinkSource = null;
  _continentIslandLinkSource = null;
  _continentMarkIslandLinkSource(null);
  const layer = document.getElementById('continentLayer');
  if (layer && layer.classList) layer.classList.toggle('is-linking', _continentLinkMode);
  const btn = document.getElementById('continentLinkBtn');
  if (btn && btn.classList) btn.classList.toggle('active', _continentLinkMode);
  const hint = document.getElementById('continentHint');
  if (hint) {
    hint.hidden = !_continentLinkMode;
    hint.textContent = '连接模式：点两个概念，或点两座岛的岛牌连成岛级航线（Esc 退出）';
  }
  // v5.4 空态引导与连接模式提示互斥（同一条顶栏位置）
  const guide = document.getElementById('continentGuide');
  if (guide) guide.hidden = _continentLinkMode || !_continentGuideText;
  _continentMarkLinkSource(null);
  _continentClosePopover();
}

function _continentMarkLinkSource(itemId) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return;
  world.querySelectorAll('.continent-node.is-link-source').forEach(el => el.classList.remove('is-link-source'));
  if (itemId) {
    const el = _continentNodeEl(itemId);
    if (el && el.classList) el.classList.add('is-link-source');
  }
}

async function _continentLinkPick(itemId, sessionId) {
  if (!_continentLinkSource) {
    _continentLinkSource = { itemId: itemId, sessionId: sessionId };
    _continentMarkLinkSource(itemId);
    const hint = document.getElementById('continentHint');
    if (hint) hint.textContent = '再点另一个区域的概念完成连线（再点自己取消，Esc 退出）';
    return;
  }
  if (_continentLinkSource.itemId === itemId) {
    _continentMarkLinkSource(null);          // 再点自己 = 取消首选
    _continentLinkSource = null;
    return;
  }
  if (_continentLinkSource.sessionId === sessionId) {
    _continentToast('大陆连线要连接两个不同区域的概念');
    return;
  }
  // v7.2：落笔不再弹 window.prompt 拦路（方向候选 U1）——备注与样式连线后点线可调
  try {
    const ok = await _continentAddUserEdge(_continentLinkSource.itemId, itemId, '');
    if (ok) {
      _continentSetLinkMode(false);
      _continentToast('已连成航线（点线可加备注、调样式，Ctrl+Z 可撤销）');
    }
  } catch (err) {
    _continentToast('连线保存失败：' + (err && err.message || err));
  }
}

// v7.2 岛级落笔：连接模式点两座**岛牌**也能落笔——两端取各岛最早学的卡当锚点
// （与代表卡同口径），渲染仍是岛框到岛框的航线
let _continentIslandLinkSource = null;

function _continentMarkIslandLinkSource(sid) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return;
  world.querySelectorAll('.continent-cluster.is-link-source').forEach(el =>
    el.classList.remove('is-link-source'));
  if (sid) {
    const el = world.querySelector('.continent-cluster[data-session-id="' +
      String(sid).replace(/"/g, '\\"') + '"]');
    if (el && el.classList) el.classList.add('is-link-source');
  }
}

async function _continentLinkPickIsland(sessionId) {
  if (!_continentIslandLinkSource) {
    _continentIslandLinkSource = sessionId;
    _continentMarkIslandLinkSource(sessionId);
    const hint = document.getElementById('continentHint');
    if (hint) hint.textContent = '再点另一座岛的岛牌完成岛级航线（再点自己取消，Esc 退出）';
    return;
  }
  if (_continentIslandLinkSource === sessionId) {
    _continentMarkIslandLinkSource(null);
    _continentIslandLinkSource = null;
    return;
  }
  const clusters = (_continentData && _continentData.clusters) || [];
  const from = clusters.find(c => c.sessionId === _continentIslandLinkSource);
  const to = clusters.find(c => c.sessionId === sessionId);
  const fromItem = from && from.items && from.items[0] && from.items[0].itemId;
  const toItem = to && to.items && to.items[0] && to.items[0].itemId;
  if (!fromItem || !toItem) { _continentToast('两座岛都要有概念才能连航线'); return; }
  try {
    const ok = await _continentAddUserEdge(fromItem, toItem, '');
    if (ok) {
      _continentIslandLinkSource = null;
      _continentMarkIslandLinkSource(null);
      _continentSetLinkMode(false);
      _continentToast('已连成岛级航线（点线可加备注、调样式，Ctrl+Z 可撤销）');
    }
  } catch (err) {
    _continentToast('连线保存失败：' + (err && err.message || err));
  }
}

// ---------- 视口：平移缩放（缩放锚点保持光标下的世界点不动） ----------
// v5.6 备注标签「固定字号」：标签在世界层里，会随地图缩放一起放大缩小（2.5 倍时 10px
// 变 25px）。乘 1/zoom 抵消即可当路牌用——缩放只该改变地图，不该改变文字大小。
// 纯函数：夹在 [0.4, 4] 防极端倍率把字缩没或撑爆。
function _continentEdgeLabelScale(zoom) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.min(4, Math.max(0.4, 1 / z));
}

function _continentSyncEdgeLabels() {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return 0;
  const k = _continentEdgeLabelScale(_continentZoom);
  const labels = world.querySelectorAll('.continent-user-link-label');
  labels.forEach(el => {
    if (el && el.style) el.style.transform = 'translate(-50%,-50%) scale(' + k + ')';
  });
  return labels.length;
}

function _continentApplyTransform() {
  const world = document.getElementById('continentWorld');
  if (world && world.style) {
    world.style.transform = 'translate(' + _continentPan.x + 'px,' + _continentPan.y + 'px) scale(' + _continentZoom + ')';
  }
  // v7.3 渐进披露：细节只切一个 CSS 类（零重建 DOM）——远景档只画海域板+岛牌+城市+航线；
  // 世界档在陆地内部铺词流；区域档加卡片标题；细节档加公式行与锚点短接。一次性全量渲染
  // + CSS 显隐，不动既有 DOM 契约。v8.8 由三档扩到四档，多出来的远景档收掉词流、只留大地名。
  if (world && world.classList) {
    const tier = _continentZoom < CONTINENT_LOD_HORIZON ? 'lod-horizon'
      : _continentZoom < CONTINENT_LOD_WORLD ? 'lod-world'
      : _continentZoom < CONTINENT_LOD_DETAIL ? 'lod-region' : 'lod-detail';
    world.classList.toggle('lod-horizon', tier === 'lod-horizon');
    world.classList.toggle('lod-world', tier === 'lod-world');
    world.classList.toggle('lod-region', tier === 'lod-region');
    world.classList.toggle('lod-detail', tier === 'lod-detail');
    // 词流的反向缩放补偿（推导见 CONTINENT_CLOUD_SCALE_MAX 处）：屏幕字号 = 13px×zoom×k，
    // k 取 1/zoom 于是恒定在 13px 可读档。**带死区**：--cloud-k 写在世界层上，改一次就要
    // 整棵子树重算字号，而滚轮每帧都调这里——0.04 死区把重算从「每帧」压到「每 ~4% 缩放」。
    const k = Math.min(CONTINENT_CLOUD_SCALE_MAX, Math.max(1, 1 / _continentZoom));
    if (Math.abs(k - _continentCloudK) > 0.04) {
      _continentCloudK = k;
      world.style.setProperty('--cloud-k', k.toFixed(2));
    }
  }
  _continentSyncEdgeLabels();
}

function _continentZoomAt(factor, cx, cy) {
  const next = Math.min(CONTINENT_ZOOM_MAX, Math.max(CONTINENT_ZOOM_MIN, _continentZoom * factor));
  const ratio = next / _continentZoom;
  // pan' = c − (c − pan)·ratio：世界点 (c − pan)/zoom 在缩放前后都落在屏幕 c 处
  _continentPan.x = cx - (cx - _continentPan.x) * ratio;
  _continentPan.y = cy - (cy - _continentPan.y) * ratio;
  _continentZoom = next;
  _continentApplyTransform();
}

function _continentCenter() {
  const vp = document.getElementById('continentViewport');
  const w = (vp && typeof vp.clientWidth === 'number' && vp.clientWidth) || 900;
  const h = (vp && typeof vp.clientHeight === 'number' && vp.clientHeight) || 600;
  return { x: w / 2, y: h / 2 };
}

function _continentFitView() {
  const world = document.getElementById('continentWorld');
  if (!world) return;
  const vp = document.getElementById('continentViewport');
  const vw = (vp && typeof vp.clientWidth === 'number' && vp.clientWidth) || 900;
  const vh = (vp && typeof vp.clientHeight === 'number' && vp.clientHeight) || 600;
  // world 尺寸是内联 '1858px' 这样的字符串：Number('1858px') 是 NaN，会让适配永远走
  // 800×600 兜底（地图一开就是放大的半屏，看不到岛之间有没有城市）——必须 parseFloat
  const ww = parseFloat(world.style.width) || 800;
  const wh = parseFloat(world.style.height) || 600;
  _continentZoom = Math.min(CONTINENT_ZOOM_MAX,
    Math.max(CONTINENT_ZOOM_MIN, Math.min(vw / ww, vh / wh) * 0.92));
  _continentPan.x = (vw - ww * _continentZoom) / 2;
  _continentPan.y = (vh - wh * _continentZoom) / 2;
  _continentApplyTransform();
}

function _continentRestoreOrFitView() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CONTINENT_VIEW_KEY) || 'null'); } catch (e) { saved = null; }
  if (saved && typeof saved.zoom === 'number' && saved.pan
      && isFinite(saved.pan.x) && isFinite(saved.pan.y)) {
    _continentZoom = Math.min(CONTINENT_ZOOM_MAX, Math.max(CONTINENT_ZOOM_MIN, saved.zoom));
    _continentPan = { x: saved.pan.x, y: saved.pan.y };
    _continentApplyTransform();
  } else {
    _continentFitView();
  }
}

function _continentPersistView() {
  try {
    localStorage.setItem(CONTINENT_VIEW_KEY,
      JSON.stringify({ pan: { x: _continentPan.x, y: _continentPan.y }, zoom: _continentZoom }));
  } catch (e) { /* 存储不可用就只留在内存，不阻断 */ }
}

function _continentBindViewport(viewport) {
  if (!viewport || !viewport.addEventListener) return;
  viewport.addEventListener('pointerdown', e => {
    if (e.button !== 0) return; // 右键留给浏览器原生菜单
    // 记下按下时的目标：setPointerCapture 会把 pointerup 重定目标到 viewport，
    // 那时 e.target 不再是被点的节点——点击判定必须用 down 时的目标
    _continentDragState = {
      x: e.clientX, y: e.clientY, panX: _continentPan.x, panY: _continentPan.y,
      moved: false, target: e.target,
    };
    try { viewport.setPointerCapture(e.pointerId); } catch (err) { /* 容忍 */ }
  });
  viewport.addEventListener('pointermove', e => {
    const st = _continentDragState;
    if (!st) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    if (!st.moved && Math.abs(dx) + Math.abs(dy) > 5) st.moved = true;
    if (st.moved) {
      _continentPan.x = st.panX + dx;
      _continentPan.y = st.panY + dy;
      _continentApplyTransform();
    }
  });
  viewport.addEventListener('pointerup', e => {
    const st = _continentDragState;
    _continentDragState = null;
    if (!st || st.moved || _continentDrilling) return;
    const el = st.target && st.target.closest
      ? st.target.closest('.continent-node, .continent-cluster') : null;
    if (!el || !el.dataset) return;
    if (el.classList && el.classList.contains('continent-node')) {
      // v2 连接模式：节点点击是选端点，不下钻
      if (_continentLinkMode) { _continentLinkPick(el.dataset.itemId, el.dataset.sessionId); return; }
      enterContinentSession(el.dataset.sessionId, el.dataset.itemId);
    } else {
      // v7.2：连接模式点岛牌 = 岛级航线端点（点两座岛牌也能落笔）；平时点岛牌仍下钻
      if (_continentLinkMode) { _continentLinkPickIsland(el.dataset.sessionId); return; }
      enterContinentSession(el.dataset.sessionId, '');
    }
  });
  viewport.addEventListener('pointercancel', () => { _continentDragState = null; });
  // 滚轮缩放合帧（与探索网画布同一口径）：连发 wheel 只累乘系数、记最新锚点，
  // rAF 内重取一次 rect 再缩放——rect 不能在事件里缓存到帧执行时（布局可能已变）
  let _contWheelRaf = 0, _contWheelFactor = 1, _contWheelX = 0, _contWheelY = 0;
  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    _contWheelFactor *= e.deltaY < 0 ? 1.12 : 0.9;
    _contWheelX = e.clientX;
    _contWheelY = e.clientY;
    if (!_contWheelRaf) {
      _contWheelRaf = requestAnimationFrame(() => {
        _contWheelRaf = 0;
        const factor = _contWheelFactor;
        _contWheelFactor = 1;
        const rect = viewport.getBoundingClientRect();
        _continentZoomAt(factor, _contWheelX - rect.left, _contWheelY - rect.top);
      });
    }
  }, { passive: false });
}

// ---------- 开合与转场 ----------
// 跨层转场拆成**两件独立的事**，因为它们的起止时机不一样：
//   1) 交叉淡化（大陆层 ↔ 会话画布）：点下按钮那一刻就能播，两侧都只需要层级的
//      opacity 与画布的 scale，不依赖任何数据。
//   2) 大陆镜头补间（世界层 translate/scale）：**必须等数据**——起点缩放是「目标视口的
//      0.35 倍」，而目标视口要等 _continentRestoreOrFitView() 跑完才知道。
// 暖缓存（实测 0.32s）时两段自然重叠成一段连贯的 420ms；冷启动时是「先拉远、后长出地图」。
//
// 手势沿用本文件原有的「内联 transition + 双 rAF 起跳」，**不走纯 CSS 类驱动**：
// 类增删的时机和 transition 生效窗口互相打架。起点用 transition:none 写死 → 强制重排
// → 再开 transition 写终点，两帧 rAF 只为确保浏览器认得出「起点已经发生过」。
function _continentWarpMs() {
  // T21 收口：以前转场时长是内联写死的 430ms，CSS 里 prefers-reduced-motion 的
  // transition:none !important 压不住内联值，开了「减少动态效果」的用户看到的仍是完整
  // 时长（且下钻会硬等 430ms 才切会话）。时长改从一个函数出，命中就压成 0——状态照翻，
  // 只是不补间。JS 与 CSS 两侧于是都认这个开关。
  try {
    if (typeof matchMedia === 'function'
        && matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  } catch (e) { /* 老浏览器没有 matchMedia：按有动效处理 */ }
  return CONTINENT_WARP_MS;
}

function _continentWorkspace() { return document.getElementById('graphWorkspace'); }
function _continentLayerEl() { return document.getElementById('continentLayer'); }
function _continentCanvasEl() { return document.getElementById('graphCanvas'); }

function _continentForcedReflow(el) {
  if (!el) return;
  try { void el.offsetWidth; } catch (e) { /* 沙箱里可能没有布局引擎 */ }
}

// 令牌只能释放一次（setTimeout 兜底与 transitionend 可能都触发，也可能打断路径先来）
function _continentWarpHold() {
  const ws = _continentWorkspace();
  if (ws && ws.classList) ws.classList.add('continent-warp');
  const token = { released: false };
  _continentWarpHoldTok = token;
  return token;
}
function _continentWarpRelease(token) {
  if (!token || token.released) return;
  token.released = true;
  if (_continentWarpHoldTok === token) _continentWarpHoldTok = null;
  const ws = _continentWorkspace();
  if (ws && ws.classList) ws.classList.remove('continent-warp');
}

// 绝对 zoom + 锚点落点。_continentZoomAt 只有相对倍率，跨转场需要直接落到某个绝对值：
// 「从目标视口的 0.35 倍长回去」= 先压到 0.35 倍、绕同一锚点再放回目标。
function _continentSetZoomAt(zoom, cx, cy) {
  const next = Math.min(CONTINENT_ZOOM_MAX, Math.max(CONTINENT_ZOOM_MIN, zoom));
  const ratio = _continentZoom > 0 ? next / _continentZoom : 1;
  _continentPan.x = cx - (cx - _continentPan.x) * ratio;
  _continentPan.y = cy - (cy - _continentPan.y) * ratio;
  _continentZoom = next;
  _continentApplyTransform();
}

// ---- 1) 交叉淡化：大陆层 ↔ 会话画布 ----
// dir='enter' 会话→大陆：会话图缩到 0.5 淡出 + 大陆层淡入（拉远）
// dir='exit'  大陆→会话：大陆层淡出 + 会话图从 0.5 放大到 1 淡入（推近）
// 两方向是严格镜像：同一个类在两个方向扮演相反的起止角色（见下面两个 Apply）。
//
// 画布那一侧走 CSS 类（.is-continent-retreat）而不是内联：.graph-canvas 自身从不写
// inline style（只有内层 .graph-canvas-inner 的 transform 由 _applyGraphTransform 写），
// 所以这里加类不会和会话图自己的缩放互相覆盖。
//
// ⚠️ 三段式（禁过渡→写过渡→写终点）是**规范要求**，不是风格选择：css-transitions-1
// 规定过渡的启动条件是「**变化前**样式里已有该属性的 transition」。先写
// `transition:none` + 起点、下一帧再同时写 `transition:transform 420ms` + 终点，
// 浏览器看到的变化前样式是 none，于是**根本不启动过渡**——表现为一帧硬跳。
// 改这一段之前，进入大陆的「1.14 落定」和下钻的「2.6 推镜」就是这么一直硬跳的
// （用户报的现象正是「立刻切屏，然后放大再缩小」）。中间那次强制重排的作用是让
// 「起点已提交、过渡属性已提交、值还没变」这三个状态分别落地一帧。
function _continentWarpStartState(dir) {
  const layer = _continentLayerEl();
  const canvas = _continentCanvasEl();
  // enter 的起点：大陆层还是透明的，会话图还在自然态
  // exit  的起点：大陆层可见，会话图已经退到 0.5（等下要放大回来）
  if (layer && layer.classList) layer.classList.toggle('continent-warp-fade', dir === 'enter');
  if (canvas && canvas.classList) canvas.classList.toggle('is-continent-retreat', dir === 'exit');
}
function _continentWarpEndState(dir) {
  const layer = _continentLayerEl();
  const canvas = _continentCanvasEl();
  if (layer && layer.classList) layer.classList.toggle('continent-warp-fade', dir === 'exit');
  if (canvas && canvas.classList) canvas.classList.toggle('is-continent-retreat', dir === 'enter');
}

function _continentRunWarp(dir, done) {
  const finish = typeof done === 'function' ? done : () => {};
  const ms = _continentWarpMs();
  const layer = _continentLayerEl();
  const canvas = _continentCanvasEl();
  const ws = _continentWorkspace();

  // 打断在途的那段：直接把它收尾，绝不留半个状态在半路。这是「转场中再按 Esc、
  // 立即跳到目标状态」的收敛保证——任何时刻最多一段转场在跑，且一定收敛到
  // 「大陆开」或「大陆关」二选一。
  if (_continentWarp) {
    const stale = _continentWarp;
    _continentWarp = null;
    _continentClearWarpDom(stale.canvasEl);
    try { stale.finish(); } catch (e) { /* 收尾失败不阻断新转场 */ }
  }
  // 退场时先把藏画布的规则摘掉，否则会话图在整段退场里都是 visibility:hidden，
  // 「放大迎上来」根本看不见。由本函数统一负责，closeContinentView 不再另做。
  if (dir === 'exit' && ws && ws.classList) ws.classList.remove('continent-open');

  const state = { id: ++_continentWarpSeq, dir, canvasEl: canvas, finish };
  _continentWarp = state;

  if (ms <= 0) {
    // 减少动态效果：只翻状态不补间
    _continentWarpEndState(dir);
    _continentWarp = null;
    _continentClearWarpDom(canvas);
    finish();
    return;
  }

  // ① 起点（禁过渡，强制结算）
  _continentWarpStartState(dir);
  _continentForcedReflow(canvas || layer);
  // ② 只写过渡属性，值不动 —— 提交一个「有 transition、值没变」的样式，不会触发过渡
  const trans = 'transform ' + ms + 'ms ' + CONTINENT_WARP_EASE
    + ', opacity ' + ms + 'ms ' + CONTINENT_WARP_EASE;
  if (canvas && canvas.style) canvas.style.transition = trans;
  if (layer && layer.style) layer.style.transition = trans;
  _continentForcedReflow(canvas);
  // ③ 写终点 —— 变化前样式里已有 transition，过渡在这里才真正启动
  _continentWarpEndState(dir);

  // 收尾：transitionend + 定时器双保险。元素被 hidden 时 transitionend 可能不触发，
  // 只挂 transitionend 会把状态永久卡在半路（层藏了但 workspace 还挂着 continent-warp）。
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    if (_continentWarp !== state) return;
    _continentWarp = null;
    _continentClearWarpDom(canvas);
    finish();
  };
  if (canvas && canvas.addEventListener) {
    canvas.addEventListener('transitionend', settle, { once: true });
    if (layer && layer.addEventListener) layer.addEventListener('transitionend', settle, { once: true });
  }
  setTimeout(settle, ms + 60);
}

// 收干净转场态。三处都要清：画布的类与内联、大陆层的类与内联、workspace 的 continent-warp。
// 漏掉任何一处的后果分别是「会话图永久缩在半屏」「大陆层永远透明」「回归脚本永远等不到
// 转场结束」——所以收尾只走这一个函数，不允许散落。
function _continentClearWarpDom(canvas) {
  if (canvas) {
    if (canvas.style) canvas.style.transition = '';
    if (canvas.classList) canvas.classList.remove('is-continent-retreat');
  }
  const layer = _continentLayerEl();
  if (layer) {
    if (layer.style) layer.style.transition = '';
    if (layer.classList) layer.classList.remove('continent-warp-fade');
  }
  const ws = _continentWorkspace();
  if (ws && ws.classList) ws.classList.remove('continent-warp');
}

// ---- 2) 大陆镜头补间：世界层从 fromZoom 走到 toZoom，锚点 (cx,cy) 原地不动 ----
// 只有一个方向语义：from → to。打开大陆是 from=0.35×目标、to=目标视口（长出来）；
// 下钻是 from=当前、to=更大（推进）。调用方自己算好两端，这里不做倍率推导——
// 早先一版带了个 zoomIn 布尔来分派方向，结果起点终点写反了，世界停在 0.35 倍的远景档，
// 概念卡与边界城市整档 display:none，continent_regression 连挂三条。方向只有一种。
// 同样用三段式启动（见 _continentRunWarp 上面的规范说明）。
function _continentAnimateWorld(fromZoom, toZoom, cx, cy) {
  const world = document.getElementById('continentWorld');
  const ms = _continentWarpMs();
  if (!world || !world.style) { _continentSetZoomAt(toZoom, cx, cy); return; }
  if (ms <= 0) { _continentSetZoomAt(toZoom, cx, cy); return; }
  world.style.transition = 'none';
  _continentSetZoomAt(fromZoom, cx, cy);
  _continentForcedReflow(world);
  world.style.transition = 'transform ' + ms + 'ms ' + CONTINENT_WARP_EASE;
  _continentForcedReflow(world);
  _continentSetZoomAt(toZoom, cx, cy);
  setTimeout(() => { if (world && world.style) world.style.transition = ''; }, ms + 60);
}

// 打开大陆时把「你当前会话对应的那座岛」滚到视口中央；返回 false 让调用方回退到
// 视口中心缩放（没建大陆 / 空数据 / 地图未落笔）。
// 复用 _continentClusterRects —— enterContinentSession 下钻时已经在用同一份数据按
// sessionId 找岛，这里是同一件事的反方向，不需要引入新的 ID 映射。
function _continentFocusSessionIsland(sid) {
  if (!sid) return false;
  const rect = _continentClusterRects.find(r => r && r.sessionId === sid);
  if (!rect || !isFinite(rect.cx) || !isFinite(rect.cy)) return false;
  const c = _continentCenter();
  // 岛在目标缩放下的屏幕位置：pan + worldPos·zoom。解 pan 使它落在视口中心。
  _continentPan.x = c.x - rect.cx * _continentZoom;
  _continentPan.y = c.y - rect.cy * _continentZoom;
  _continentApplyTransform();
  return true;
}


function _continentUpdateBreadcrumb(data) {
  const bc = document.getElementById('continentBreadcrumb');
  if (!bc) return;
  const has = data && Array.isArray(data.clusters) && data.clusters.length > 0
    && (data.itemCount || 0) > 0;
  bc.hidden = !has;
}

async function openContinentView(opts) {
  const layer = _continentEnsureLayer();
  if (!layer || _continentOpen) return;
  _continentOpen = true;
  // 开图路径分两种（v9），靠这个标记区分「从会话打开」与「从面包屑返回」：
  //   返回 → 恢复上次浏览视口（老口径，保住用户离开时的位置）
  //   打开 → 数据到了之后把「你当前会话对应的那座岛」滚到中央（地标连续）
  // 两者在 _continentSettleWorld 里汇合，都走同一段镜头补间。
  // opts.fromBreadcrumb=true 是「‹ 大陆」返回：老口径优先，恢复上次浏览视口。
  // 从会话打开则把当前会话对应的那座岛滚到中央（地标连续）。
  const fromBreadcrumb = !!(opts && opts.fromBreadcrumb);
  const entrySession = typeof window.getCurrentSessionId === 'function'
    ? (window.getCurrentSessionId() || '') : '';
  layer.classList.remove('continent-diving', 'continent-surfacing');
  layer.hidden = false;
  const ws = _continentWorkspace();
  if (ws) ws.classList.add('continent-open');

  // 开图持有一个令牌，第一段（交叉淡化）收尾就释放——v9.1 起没有第二段镜头补间，
  // 「转场在途」就是这 420ms 本身
  const openHold = _continentWarpHold();
  _continentOpenHold = openHold;
  // 交叉淡化立即起播，**不等数据**（smoke 的沙箱里 rAF/setTimeout 是空桩，open 的
  // promise 不能 await 任何靠它们收尾的东西，否则 frontend_smoke 会永不落地）
  _continentRunWarp('enter', () => _continentWarpRelease(openHold));

  _continentKeyHandler = e => {
    if (e.key === 'Escape') {
      // v8 顶栏搜索最先收（有命中=清单开着）：清搜索，不动弹层/连接模式/大陆本身
      if (_continentSearchResults.length) { _continentSearchClear(); return; }
      if (_continentPopover) { _continentClosePopover(); return; }
      if (_continentLinkMode) { _continentSetLinkMode(false); return; }
      closeContinentView();
    }
    // v2：大陆打开时 Ctrl+Z 只作用于大陆边操作栈，不透传给会话图撤销
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      _continentUndoEdgeOp();
    }
  };
  document.addEventListener('keydown', _continentKeyHandler);

  let data;
  try {
    // v7.1a：海域覆盖（改名/挪岛）先于首次渲染就位——第一次画就是用户纠正过的样子；
    // v7.3：折叠态（收起的岛/海域）同样先就位；v8：纠正记录条数（图例脚注要照报）
    await _continentLoadRegionOverrides();
    _continentLoadCollapsed();
    _continentCorrectionCount = await _continentLoadCorrectionCount();
    data = await _continentFetchData();
  } catch (err) {
    // 加载失败：把已经起播的拉远动画反向收回去（大陆缩回没打开的样子），再报错。
    // 不能只 closeContinentView —— 那样会把用户留在「会话已缩没、大陆也没了」的空白里。
    _continentRunWarp('exit');
    if (typeof showToast === 'function') showToast('大陆数据加载失败：' + (err && err.message || err));
    setTimeout(() => {
      if (_continentOpen) closeContinentView();
      else _continentWarpRelease(openHold); // 已被关：close 接手释放，这里只兜底
    }, _continentWarpMs() + 80);
    return;
  }
  if (!_continentOpen) { _continentWarpRelease(openHold); return; } // 加载途中被关
  _continentData = data;
  _continentRender(data);
  _continentUpdateBreadcrumb(data);
  _continentUpdateTools();
  _continentSettleWorld(entrySession, fromBreadcrumb);
}

// 数据到了之后把大陆落到最终视口——**只落位，不补间**（v9.1，见 CONTINENT_WARP_MS
// 上方的注释）。锚点仍是「当前会话对应的那座岛」；从面包屑返回时走老口径恢复视口。
// 内容在这里直接出现：暖缓存下第一段刚好收尾、读起来是一段；冷启动下内容后到、
// 直接出现（那是加载，不是动画）。 continent-warp 已由第一段的 finish 释放，
// 这里不再持有令牌。
function _continentSettleWorld(entrySession, fromBreadcrumb) {
  _continentRestoreOrFitView();
  if (!fromBreadcrumb && entrySession) {
    _continentFocusSessionIsland(entrySession);
  }
}

function closeContinentView() {
  if (!_continentOpen) return; // 未开先关必须幂等
  _continentOpen = false;
  // v7.1b：在途的 Φ 批量归类随大陆关闭中止（已完成的批已落盘，不丢）
  if (_continentGateCtrl) {
    try { _continentGateCtrl.abort(); } catch (e) { /* 容忍 */ }
    _continentGateCtrl = null;
  }
  if (!_continentSkipViewPersist) _continentPersistView();
  _continentSkipViewPersist = false;
  _continentSetLinkMode(false);
  _continentSearchClear();   // v8：搜索态（输入/清单/高亮）不跨开合存活
  _continentClosePopover();
  // v9：layer.hidden 从「同步立刻置位」改成「转场结束后才置」——退场要先看见大陆
  // 淡出、画布放大迎上来，硬切就没有退场动画了。_continentOpen 与上面的清理全部
  // 仍是同步的：smoke 的「未开先关两次幂等」用例同步连调两次 close，不等动画。
  // 藏画布规则的解除交给 _continentRunWarp('exit')（它要在摆起点之前做，
  // 否则会话图整段退场都是 visibility:hidden）
  // 关图接手开图可能还挂着的令牌（数据没到就被关）：否则 continent-warp 永远不摘
  if (_continentOpenHold) { _continentWarpRelease(_continentOpenHold); _continentOpenHold = null; }
  // _continentSkipWarp=true 说明调用方（enterContinentSession）刚播完退场转场，
  // 这里只做收尾不要再播一遍
  if (_continentSkipWarp) {
    _continentClearWarpDom(_continentCanvasEl());
    const l0 = _continentLayerEl();
    if (l0) {
      l0.classList.remove('continent-diving', 'continent-surfacing', 'continent-warp-fade');
      l0.hidden = true;
    }
    const w0 = document.getElementById('continentWorld');
    if (w0 && w0.style) w0.style.transition = '';
    if (_continentKeyHandler) {
      document.removeEventListener('keydown', _continentKeyHandler);
      _continentKeyHandler = null;
    }
    return;
  }
  const closeHold = _continentWarpHold();
  _continentRunWarp('exit', () => {
    const layer = _continentLayerEl();
    if (layer) {
      layer.classList.remove('continent-diving', 'continent-surfacing', 'continent-warp-fade');
      layer.hidden = true;
    }
    const world = document.getElementById('continentWorld');
    if (world && world.style) world.style.transition = '';
    _continentWarpRelease(closeHold);
  });
  if (_continentKeyHandler) {
    document.removeEventListener('keydown', _continentKeyHandler);
    _continentKeyHandler = null;
  }
}

// 下钻：先切到目标会话（会话画布在背后就位），再播「大陆朝点击处推进 + 会话迎面放大」
// 的转场，收尾后经 goToKnowledgeNode 直达定位（它自带「定位 + 失败 toast」全流程，
// 这里不复述其职责）。v9 换了顺序：会话图必须在转场开始前就渲染好，否则放大进来的
// 是上一个会话的图。切换失败要退回大陆——人已经离开了，不能把他留在空白里。
async function enterContinentSession(sessionId, itemId) {
  if (!sessionId || _continentDrilling) return;
  if (typeof switchToSession !== 'function') { closeContinentView(); return; }
  _continentDrilling = true;
  // 留给回程的「离开时视口」是用户此刻的浏览态——下钻动画会把镜头推远，
  // 那是跳转动作不是浏览位置，close 时的持久化要跳过，别让它覆盖
  _continentPersistView();
  _continentSkipViewPersist = true;
  const layer = _continentLayerEl();
  const key = String(itemId || '');
  const focus = key && _continentPlacements[key];
  const rect = !focus
    ? _continentClusterRects.find(r => r.sessionId === sessionId) || null : null;
  const origin = focus || rect;
  let sx = 0, sy = 0, hasAnchor = false;
  if (origin && isFinite(origin.cx) && isFinite(origin.cy)) {
    // 点击处的屏幕坐标：pan + worldPos·zoom——缩放锚点放这里，节点原地不动
    sx = _continentPan.x + origin.cx * _continentZoom;
    sy = _continentPan.y + origin.cy * _continentZoom;
    hasAnchor = true;
  }
  if (!hasAnchor) { const c = _continentCenter(); sx = c.x; sy = c.y; }

  // 先切会话。渲染在背后完成，失败则原地退回大陆（不播转场，用户不感知这次失败）
  try {
    await switchToSession(sessionId);
  } catch (e) {
    if (typeof showToast === 'function') showToast('切换会话失败：' + (e && e.message || e));
    _continentDrilling = false;
    _continentSkipViewPersist = false;
    return; // 大陆仍开着，无需退回
  }

  if (layer && layer.classList) layer.classList.add('continent-diving');
  // 大陆朝锚点推进（被点的岛原地不动、其余向外涌出）——同时会话画布从 0.5 倍迎面放大。
  // 播完再 closeContinentView，但那时转场已经跑完，别让它重播一遍（会看到大陆淡出两次）
  const targetZoom = Math.min(CONTINENT_ZOOM_MAX, _continentZoom * 1.8);
  const drillHold = _continentWarpHold();
  _continentAnimateWorld(_continentZoom, targetZoom, sx, sy);
  _continentRunWarp('exit');
  await new Promise(r => setTimeout(r, _continentWarpMs() + 80));
  _continentSkipWarp = true;
  closeContinentView();
  _continentSkipWarp = false;
  _continentWarpRelease(drillHold);
  _continentDrilling = false;
  if (key && typeof goToKnowledgeNode === 'function') {
    try { await goToKnowledgeNode(itemId); } catch (e) { /* 定位失败自带 toast */ }
  }
}


// 供 continent_regression.mjs 把视口摆到指定会话的岛上：那条用例要点具体节点，
// 不能再依赖「开图入口碰巧落在哪」的副作用（v9 起入口分两种，见 openContinentView）。
// 暴露的是应用自己的同一个算子，不另造一套测试专用逻辑。
window._continentFocusSessionIslandForTest = _continentFocusSessionIsland;
window.openContinentView = openContinentView;
window.closeContinentView = closeContinentView;
window.enterContinentSession = enterContinentSession;
window._continentLayoutClusters = _continentLayoutClusters;
// v4/v5.1 画什么的纯函数（无 DOM），smoke 直接断言：弱证据不上图 / 每对与全图上限 /
// 城市选位（不撞岛不撞城）/ 折叠原因可分辨 / 重逢清单行可跳转
window._continentDrawPlan = _continentDrawPlan;
window._continentFoldedRows = _continentFoldedRows;
window._continentReunionRows = _continentReunionRows;
window._continentPlaceCity = _continentPlaceCity;
window._continentCityBox = _continentCityBox;
window._continentFits = _continentFits;
window._continentLinkMid = _continentLinkMid;
window._continentKindPrefix = _continentKindPrefix;
window._continentEdgeLabelScale = _continentEdgeLabelScale;
window._continentSyncEdgeLabels = _continentSyncEdgeLabels;
// v5.2 群岛布局 / v5.3 问 Φ / v5.4 岛牌：纯函数（无 DOM），smoke 直接断言
window._continentKinship = _continentKinship;
window._continentClusterOrder = _continentClusterOrder;
window._continentPhiMessages = _continentPhiMessages;
window._continentPhiVerdict = _continentPhiVerdict;
window._continentPhiBlockHtml = _continentPhiBlockHtml;
window._continentIslandTagline = _continentIslandTagline;
// v7.1a 海域层：纯函数（无 DOM），smoke 直接断言（分组/配色确定性/两级布局罩住海域板）
window._continentRegionHue = _continentRegionHue;
window._continentRegions = _continentRegions;
window._continentRegionLayout = _continentRegionLayout;
window._continentLayoutGrid = _continentLayoutGrid;
window._continentRegionSourceLabel = _continentRegionSourceLabel;
window._continentSecondaryDot = _continentSecondaryDot;
window._continentRegionInfoOf = () => _continentRegionInfo;  // 验收/调试用（只读当前归属解析）
// v7.1b 门控：纯函数（无 DOM），smoke 直接断言（提示词契约/判读防御/哈希增量）
window._continentGateMessages = _continentGateMessages;
window._continentGateParse = _continentGateParse;
window._continentGateHash = _continentGateHash;
window._continentGatePendingCards = _continentGatePendingCards;
// v7.2 航线：纯函数（无 DOM），smoke 直接断言（出岛框/绕行不穿岛/标签落点 finite）
window._continentRoute = _continentRoute;
window._continentBorderPoint = _continentBorderPoint;
window._continentRouteStroke = _continentRouteStroke;
// v8 顶栏搜索 / 族表编辑 / 纠正信号：纯函数（无 DOM），smoke 直接断言
window._continentSearchMatches = _continentSearchMatches;
window._continentFamilyParseTerms = _continentFamilyParseTerms;
window._continentFamilyNormalizeList = _continentFamilyNormalizeList;
window._continentFamilySourceLabel = _continentFamilySourceLabel;
window._continentClipText = _continentClipText;

// 预热面包屑：启动后拉一次投影，有内容才亮「‹ 大陆」入口（失败静默——
// 查空是正常路径，不弹错）。?continent=1 直开大陆视图（演示/验收捷径）。
// 沙箱里 setTimeout 是桩，此段只在真浏览器跑。
setTimeout(() => {
  _continentFetchData().then(data => {
    _continentUpdateBreadcrumb(data);
    try {
      if (String(location.search || '').indexOf('continent=1') >= 0) openContinentView();
    } catch (e) { /* location 不可用就忽略 */ }
  }).catch(() => {});
}, 2500);
