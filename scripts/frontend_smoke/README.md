# frontend_smoke 冒烟用例编写规则

给 `scripts/frontend_smoke/` 加/改用例前必读。2026-10-28 自 AGENTS.md 硬规则 4 外移（T417 预算压缩），规则原文一字未删；AGENTS.md 只留指针。跑法与基线数字见 AGENTS.md 硬规则 4 验证表。

## 分域与执行顺序（T66，2026-10-08）

用例在各分域文件，入口 `frontend_smoke.mjs` 是薄壳、其调用序列＝全局执行顺序（并行改各自域文件不再互避）。

## 串行边界段

给 smoke 加的用例若共享 localStorage 键且会 await，放对应 `serial-*.mjs`（串行边界段）。

## 异步用例收口线（2026-10-07 实测）

**任何异步用例都要确认它在某个 `drain()` 收口线（原 `await Promise.all(pendingChecks)`）之前注册**——收口线之后的异步用例会被静默跳过：既不打 ✓ 也不打 ❌。

## 同文件混排两实锤（2026-10-17）

- **异步用例与「重置共享沙箱」的同步用例不可同文件混排**——异步让出微任务期间同步用例的 _seed() 会重置状态致假红，须拆独立域文件串行执行。
- **两条都要替换同一全局桩（setTimeout/clearTimeout 等）的异步用例也不可同文件并排**——互相换桩，先注册那条当场假红，本域内改成串行 await 队列。

## window.* 桩位铁则（T411，2026-10-28）

loose 代理读属性即固化假函数且 typeof 恒 'function'（源码兜底失效），桩位还原/清桩一律走 `_runner.mjs` 的 `restoreWindowStub`/`fillNeutralGraphStubs` 回填中性桩——裸赋回 loose 会跨域传染、裸 delete 留空位下一位读者一读又固化，两者都会让落图链炸 `"undefined" is not valid JSON`；`graph-stub-sentinel.mjs` 两探针站岗，别在用例里手抓手还 window 桩。
