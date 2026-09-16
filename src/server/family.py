"""概念族与译名变体（大陆 v6 / A 档）：把「相似知识点的汇聚」从纯字面统计升级为
**可积累、可确认的概念层**。

为什么需要它（真机实测的老问题）：
- 纯子串证据只能认出「字面撞车」：`梯度`/`散度`/`旋度` 三座岛都属矢量分析，但两两之间
  共享的只有 2 字词，判 weak 后既不建城、也不影响摆位——用户地图上表现为「一片孤岛」；
- 同一个概念换个写法就断联：`傅里叶变换` / `傅立叶变换`（异体译名）、`振动` / `振荡`；
- 判定尺子只有「长度」一把：`表达`/`坐标` 这类语法碎片靠黑名单挡，而真正的 2 字领域词
  （`振动`/`守恒`/`梯度`）连带一起被压低。

本模块给出一层**领域知识**（而不是更宽松的阈值）：一张概念族表——每个族有规范名
（城市上显示的名字）与一组术语（出现在**标题**里就说明这张卡在讲这个）。

术语取舍口径（写表时按这条自查）：**匹配只跑标题（卡片名 + 岛名），不跑正文**——
卡片标题是提炼过的概念名，所以「标题里出现 积分」意味着这张卡在讲积分，而不是"推导里
顺手用了一次积分"。据此把术语写成"出现在标题里就有意义"的词；`表达`/`坐标` 这类语法
碎片永远不进表（它们在 v4 已被标题闸门挡掉）。

三条使用原则（与大陆既有铁律一致）：
1. **只读投影**：族表不改任何子图数据，也不改知识条目；它只影响「跨画布怎么汇聚」；
2. **可扩展、可覆盖**：内置表是初值，KV `continent_families`（主图自有数据，与
   `continent_edges` 同级）可增删族与术语，同名族以 KV 为准；
3. **模型与用户都能往里写**：Φ 批量归并（折叠清单）与用户确认的"这俩是一回事"最终都
   落在这张表上——汇聚从此会**积累**，不再每次打开都从零现算。

本模块**不 import concept/knowledge**（那两个模块反过来要用它做译名归一），保持纯数据 +
纯函数，避免循环依赖。
"""

import re

__all__ = [
    "BUILTIN_FAMILIES", "ALIASES", "apply_aliases", "families_from_payload",
    "merge_families", "family_term_index", "prepare_families", "match_families",
    "FAMILY_LIMIT", "FAMILY_TERM_MAX_CHARS", "FAMILY_CANONICAL_MAX_CHARS",
]

# 主图最多同时认多少族（防脏数据撑爆城市名额；超出的按 KV 优先、内置靠后截断）
FAMILY_LIMIT = 40
FAMILY_TERM_MAX_CHARS = 24
FAMILY_CANONICAL_MAX_CHARS = 16
FAMILY_TERMS_PER_FAMILY = 40

# 译名/写法变体归一（中文数理文献里反复出现的异体）：把常见的另一种写法映射到规范写法。
# 只收**确实同义**的写法差异（异体字、音译差异、常见缩写），不做同义词扩展——
# 同义词（振荡=振动）走族表的 terms 而不是这里，因为那是"同族"而非"同一个词"。
ALIASES = {
    # 只保留**真正的写法变体**：值 == 键的同义项、以及「规范名是变体前缀」的截断项
    # （如 拉格朗→拉格朗日、范德华→范德瓦尔斯）一律不收——后者会把已经正确的写法
    # 改成「拉格朗日日」这类畸形串。替换按长度降序做，避免短变体吃掉长变体的一部分。
    "傅立叶": "傅里叶",
    "富里叶": "傅里叶",
    "薛丁格": "薛定谔",
    "麦克斯威尔": "麦克斯韦",
    "马克斯韦": "麦克斯韦",
    "罗伦兹": "洛伦兹",
    "伯努力": "伯努利",
    "戴维宁": "戴维南",
    "德布洛意": "德布罗意",
    "汉密尔顿": "哈密顿",
    "彭加勒": "庞加莱",
    "波尔": "玻尔",
    "范德瓦耳斯": "范德瓦尔斯",
}

# 概念族表：canonical = 城市上显示的规范名；terms = 命中即入族（出现在**标题**里）。
# 只收「共享它就意味着两座岛在讲同一个主题」的词——语法碎片与泛后缀永远不进表。
BUILTIN_FAMILIES = [
    {"canonical": "矢量分析", "terms": [
        "梯度", "散度", "旋度", "通量", "环量", "保守场", "有势场", "矢量场", "向量场",
        "格林公式", "斯托克斯", "高斯定理", "拉普拉斯算子", "哈密顿算子", "nabla",
        "方向导数", "等值面", "势场"]},
    {"canonical": "振动与波动", "terms": [
        "振动", "振荡", "简谐运动", "简谐振动", "谐振", "振幅", "相位", "初相", "阻尼",
        "受迫", "共振", "单摆", "弹簧振子", "复摆", "相图"]},
    {"canonical": "机械波", "terms": [
        "机械波", "横波", "纵波", "驻波", "波速", "波长", "波节", "波腹", "多普勒",
        "波的叠加", "惠更斯", "声波", "拍频"]},
    {"canonical": "波动光学", "terms": [
        "干涉", "衍射", "偏振", "光程", "双缝", "薄膜干涉", "光栅", "半波损失",
        "劈尖", "牛顿环", "相干光"]},
    {"canonical": "几何光学", "terms": [
        "折射", "反射定律", "全反射", "透镜", "焦距", "像距", "物距", "色散", "棱镜",
        "成像公式", "光路"]},
    {"canonical": "守恒定律", "terms": [
        "守恒", "能量守恒", "动量守恒", "角动量守恒", "机械能守恒", "电荷守恒",
        "质量守恒", "动能定理", "动量定理", "功能原理", "碰撞"]},
    {"canonical": "牛顿力学", "terms": [
        "牛顿", "受力分析", "摩擦力", "斜面", "圆周运动", "向心力", "向心加速度",
        "惯性系", "非惯性系", "连接体", "抛体", "绳张力", "约束"]},
    {"canonical": "刚体转动", "terms": [
        "转动惯量", "角速度", "角加速度", "力矩", "定轴转动", "进动", "陀螺",
        "角动量定理", "平行轴定理"]},
    {"canonical": "热力学", "terms": [
        "热力学", "熵", "焓", "自由能", "卡诺", "等温", "绝热", "等压", "等容", "内能",
        "热机", "热容", "麦克斯韦关系", "循环效率", "熵增"]},
    {"canonical": "静电场", "terms": [
        "库仑定律", "电场强度", "电势", "电通量", "电偶极子", "电容", "静电屏蔽",
        "电场线", "电势能", "电极化", "介质"]},
    {"canonical": "稳恒磁场", "terms": [
        "安培环路", "毕奥", "萨伐尔", "洛伦兹力", "磁感应强度", "磁通量", "螺线管",
        "磁矩", "霍尔效应", "磁介质"]},
    {"canonical": "电磁感应", "terms": [
        "法拉第", "楞次定律", "感生电动势", "动生电动势", "自感", "互感", "涡电流",
        "磁链", "感应电流"]},
    {"canonical": "电路", "terms": [
        "基尔霍夫", "欧姆定律", "串联", "并联", "戴维南", "诺顿", "交流电", "阻抗",
        "相量", "谐振电路", "rc电路", "rl电路", "rlc", "电桥", "功率因数"]},
    {"canonical": "电磁波", "terms": [
        "麦克斯韦方程组", "电磁波", "坡印廷", "平面波", "波导", "辐射压强", "位移电流",
        "偶极辐射"]},
    {"canonical": "狭义相对论", "terms": [
        "洛伦兹变换", "时间膨胀", "长度收缩", "质能方程", "相对论", "四维", "光速不变",
        "同时性", "相对论动量"]},
    {"canonical": "量子力学", "terms": [
        "波函数", "薛定谔", "不确定性原理", "本征态", "本征值", "算符", "量子数",
        "隧穿", "氢原子", "泡利", "自旋", "能级", "跃迁", "测不准", "势阱"]},
    {"canonical": "微积分", "terms": [
        "导数", "微分", "积分", "极限", "泰勒", "麦克劳林", "中值定理", "偏导", "全微分",
        "链式法则", "洛必达", "定积分", "不定积分", "级数", "收敛半径", "多元函数",
        "拉格朗日乘子", "隐函数"]},
    {"canonical": "微分方程", "terms": [
        "微分方程", "常微分", "偏微分", "分离变量", "特征方程", "初值问题", "边值问题",
        "拉普拉斯方程", "泊松方程", "热方程", "波动方程", "稳定性", "通解", "特解"]},
    {"canonical": "线性代数", "terms": [
        "矩阵", "行列式", "特征值", "特征向量", "线性变换", "秩", "基变换", "线性无关",
        "对角化", "若尔当", "二次型", "内积空间", "子空间"]},
    {"canonical": "傅里叶分析", "terms": [
        "傅里叶", "fourier", "频谱", "频域", "拉普拉斯变换", "z变换", "采样定理",
        "卷积", "滤波器", "谐波分析"]},
    {"canonical": "概率统计", "terms": [
        "随机变量", "期望", "方差", "正态分布", "大数定律", "中心极限", "假设检验",
        "贝叶斯", "分布函数", "置信区间"]},
    {"canonical": "复变函数", "terms": [
        "柯西", "留数", "解析函数", "围道", "洛朗", "保角变换", "调和函数", "复变函数"]},
    {"canonical": "数学物理方法", "terms": [
        "格林函数", "变分法", "泛函", "欧拉-拉格朗日", "勒让德", "贝塞尔", "施图姆",
        "本征函数", "正交函数系"]},
    {"canonical": "流体力学", "terms": [
        "伯努利", "连续性方程", "雷诺数", "层流", "湍流", "黏滞", "纳维", "斯托克斯方程",
        "浮力", "压强梯度"]},
    {"canonical": "天体与引力", "terms": [
        "开普勒", "万有引力", "逃逸速度", "轨道", "潮汐", "拉格朗日点", "双星",
        "引力势能"]},
]


def apply_aliases(text: str) -> str:
    """译名/写法变体归一（`傅立叶变换` → `傅里叶变换`）。

    只做**等长替换**意义上的写法归一，不做同义扩展——同义词归族表管。调用方负责先做
    标题归一化（concept._normalize_title），本函数只关心写法。
    """
    s = str(text or "")
    if not s:
        return s
    # 长变体优先：先换「麦克斯威尔」再换「马克斯韦」，短串不会破坏长串的匹配位置
    for variant in sorted(ALIASES, key=len, reverse=True):
        canonical = ALIASES[variant]
        if variant != canonical and variant in s:
            s = s.replace(variant, canonical)
    return s


def _clip(text, limit: int) -> str:
    s = str(text or "").strip()
    return s if len(s) <= limit else s[:limit].rstrip()


def families_from_payload(raw) -> list:
    """KV `continent_families` 里的原始值 → 规范化的族列表（裸数组或 {families:[…]} 都收）。

    白名单字段、逐项限长、总量封顶：投影层对脏数据的立场是「照常返回，别报错」。
    canonical 为空或没有有效 terms 的条目直接丢弃（空族会把所有岛圈进同一片）。
    """
    if isinstance(raw, dict):
        raw = raw.get("families")
    if not isinstance(raw, list):
        return []
    out = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        canonical = _clip(entry.get("canonical"), FAMILY_CANONICAL_MAX_CHARS)
        if not canonical:
            continue
        terms = entry.get("terms")
        if not isinstance(terms, list):
            terms = []
        clean_terms = []
        for term in terms:
            # 术语也过译名归一：用户把族术语写成「傅立叶」时，照样命中「傅里叶变换」标题
            t = apply_aliases(_clip(term, FAMILY_TERM_MAX_CHARS))
            # 单字术语不进族表：中文单字在标题里到处都是（「力」「场」「波」），
            # 拿它当族证据会把无关的岛圈成一家
            if t and len(t) >= 2 and t not in clean_terms:
                clean_terms.append(t)
        if not clean_terms:
            continue
        out.append({
            "canonical": canonical,
            "terms": clean_terms[:FAMILY_TERMS_PER_FAMILY],
            "source": "user" if str(entry.get("source") or "") == "user" else "custom",
        })
        if len(out) >= FAMILY_LIMIT:
            break
    return out


def merge_families(builtin: list, custom: list) -> list:
    """内置表 + KV 表：同名族以 KV 为准（用户/模型可以覆盖我写的术语）。"""
    merged = []
    seen = set()
    for fam in list(custom or []) + list(builtin or []):
        canonical = str(fam.get("canonical") or "").strip()
        if not canonical or canonical in seen:
            continue
        terms = [apply_aliases(str(t).strip()) for t in (fam.get("terms") or [])
                 if str(t).strip()]
        if not terms:
            continue
        seen.add(canonical)
        merged.append({"canonical": canonical, "terms": terms,
                       "source": str(fam.get("source") or "builtin")})
    return merged


def family_term_index(families: list) -> set:
    """全部族术语（小写化）：用来把「已被族覆盖的原始标签」从 shared 里去掉，避免同一件事
    既画一座城、又留一条弱证据标签。"""
    return {str(t).strip().lower() for fam in (families or [])
            for t in (fam.get("terms") or []) if str(t).strip()}


_ASCII_WORD_RE = re.compile(r"[a-z0-9]+")


def prepare_families(families: list) -> list:
    """族表 → 可复用的匹配结构（**热路径必须先走这一步**）。

    投影是每次打开大陆现算的，而 `match_families` 要对每一条卡片标题跑一遍全表：直接把
    术语的 `lower()/strip()/isascii()` 留在匹配函数里，会在「25 族 × 600 卡」这种规模上
    白烧 420 万次字符串方法（实测：600 条从几十毫秒涨到 1.7 秒，cProfile 一眼看到）。
    把术语侧的规范化提到这里做一次、中文/ASCII 分开放，匹配就只剩子串/集合判断。
    """
    prepared = []
    for fam in (families or []):
        canonical = str(fam.get("canonical") or "").strip()
        if not canonical:
            continue
        cjk, ascii_terms = [], set()
        for term in (fam.get("terms") or []):
            t = apply_aliases(str(term or "")).strip().lower()
            if not t:
                continue
            (ascii_terms.add(t) if t.isascii() else cjk.append(t))
        if not cjk and not ascii_terms:
            continue
        prepared.append({"canonical": canonical, "source": str(fam.get("source") or "builtin"),
                         "cjk": cjk, "ascii": ascii_terms})
    return prepared


def match_families(text: str, families: list) -> list:
    """一段（已归一化的）文本属于哪些族，返回规范名列表。

    匹配规则：术语出现在文本里即可（子串）。ASCII 术语按**词边界**匹配——`rlc` 不该在
    `rlcircuit` 里命中；中文术语照旧子串（中文没有词边界，靠表本身写具体即可）。

    `families` 应当是 `prepare_families()` 的产物；传入原始族列表也能跑（内部补一次
    准备），但那是 O(卡片数 × 术语数) 的写法，只留给测试与一次性调用。
    """
    s = str(text or "").lower()
    if not s:
        return []
    if families and not ("cjk" in families[0] or "ascii" in families[0]):
        families = prepare_families(families)
    words = None
    out = []
    for fam in (families or []):
        hit = False
        for t in fam["cjk"]:
            if t in s:
                hit = True
                break
        if not hit and fam["ascii"]:
            if words is None:
                words = set(_ASCII_WORD_RE.findall(s))
            hit = any(t in words for t in fam["ascii"])
        if hit:
            out.append(fam["canonical"])
    return out
