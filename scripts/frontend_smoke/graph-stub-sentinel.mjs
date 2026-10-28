// T411 跨域桩位传染哨兵（2026-10-28）：沙箱 window 是 loose 代理，读任意属性都会
// 固化一个假函数进去（_runner loose 的 get 副作用）；源码 _graphState() 的
// typeof window.getGraphState === 'function' 兜底因此永远走不到（loose 的 typeof
// 恒为 'function'），落图链 _pushGraphUndo 的 JSON.parse(JSON.stringify(松代理))
// 当场炸 "undefined" is not valid JSON。serial-source-input 清桩若裸 delete、
// 后续域还原前值若裸赋回 loose，桩位就会带着假函数在域间传染——单独跑任何域
// 都不复炸，只有全量跑才现形，新增画布用例的自然写法（不自带桩直接跑落图链）
// 第一个踩雷。本域在两个雷区位置（graph 系开门、全量收尾）各放一条不带桩的
// _graphState() 实链探针：传染一出现当场红在这里，而不是炸在下一个新用例上。
import { check, sandbox, vm, isLoose, fillNeutralGraphStubs } from './_runner.mjs';

export function run(at) {
  check('T411: 画布桩位无跨域 loose 传染（' + at + '）', () => {
    const st = vm.runInContext('_graphState()', sandbox);
    if (isLoose(st)) {
      // 自愈：探针这一读本身也会固化 loose，报红后立即回填中性桩，
      // 不让雷继续传给后面的域
      fillNeutralGraphStubs();
      throw new Error('window.getGraphState 桩位被 loose 代理占据：落图链将炸 "undefined" is not valid JSON'
        + '——桩位还原/清桩须走 _runner 的 restoreWindowStub / fillNeutralGraphStubs 回填中性桩，别裸赋回、别裸 delete');
    }
    JSON.parse(JSON.stringify(st));   // _pushGraphUndo 同款序列化口径
    return true;
  });
}
