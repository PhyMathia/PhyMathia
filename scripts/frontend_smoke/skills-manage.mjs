// 技能管理面（2026-11-16 第 5 版）：单条/总开关、内置可改、删除/恢复默认、导入确认卡。
// 范围：_settingsSkillGroups 的关闭项归属（2026-11-17 二次拍板：不挪窝）、_settingsSkillRowHtml 的按钮集合、
//       _settingsSkillImportEntryHtml 的字段与坏条目处理、四个新接口的静态契约。
// 纯同步用例：不碰 fetch / DOM，只调沙箱里的真函数与源码字符串。
import { check, sandbox, fs } from './_runner.mjs';

const settingsSrc = () => fs.readFileSync('src/static/js/settings.js', 'utf8');

const row = (patch) => Object.assign({
  id: 'iso-cutaway', name: '等距剖视画法', desc: '装置内部结构', scope: ['viz'],
  chars: 845, builtin: true, source: 'builtin', overridden: false, enabled: true
}, patch || {});

export function run() {
  check('skills-manage: 关掉的技能留在原节点组不挪窝（2026-11-17 二次拍板），disabled 清单与计数不变', () => {
    const items = [
      row({ id: 'iso-cutaway' }),
      row({ id: 'force-analysis', name: '受力分析七步', scope: ['physics'], source: 'user', builtin: false }),
      row({ id: 'muted', name: '关掉的', scope: ['viz', 'learn'], source: 'user', builtin: false, enabled: false })
    ];
    const split = sandbox._settingsSkillGroups(items, {
      physics: ['force-analysis'], math: [], graph: [], viz: ['iso-cutaway'], socratic: [], learn: []
    });
    // 服务端 byModule 只回开着的（viz 只有 iso-cutaway，learn 是空数组）：前端必须把关掉的按 scope 补回来
    const viz = split.groups.find(g => g.key === 'viz');
    const learn = split.groups.find(g => g.key === 'learn');
    if (!viz || viz.items.map(i => i.id).join(',') !== 'iso-cutaway,muted') {
      throw new Error('关掉的不该离开 viz 组：' + (viz && viz.items.map(i => i.id).join(',')));
    }
    if (!learn || learn.items.map(i => i.id).join(',') !== 'muted') throw new Error('muted 该留在 learn 组');
    if (split.disabled.length !== 1 || split.disabled[0].id !== 'muted') throw new Error('disabled 清单仍在');
    if (split.active !== 2 || split.total !== 3) throw new Error('计数不对：' + split.active + '/' + split.total);
    if (split.emptyLabels.indexOf('进阶学习') >= 0) throw new Error('learn 组有关掉的撑着，不该报空');
    return true;
  });

  check('skills-manage: 旧接口退化（无 byModule）时按 scope 现算，关掉的也进组', () => {
    const split = sandbox._settingsSkillGroups([
      { id: 'a', name: 'A', scope: ['viz'] },
      { id: 'c', name: 'C', scope: ['viz'], enabled: false }
    ], null);
    const viz = split.groups.find(g => g.key === 'viz');
    if (!viz || viz.items.map(i => i.id).join(',') !== 'a,c') throw new Error('退化路径漏了关掉条目');
    return true;
  });

  check('skills-manage: 旧调用（无 enabled 字段）仍按开启处理，分组数量不退化', () => {
    const split = sandbox._settingsSkillGroups([
      { id: 'a', name: 'A', scope: ['viz'] },
      { id: 'b', name: 'B', scope: ['physics'] }
    ], { physics: ['b'], viz: ['a'] });
    if (split.groups.length !== 2) throw new Error('两组应保留，实为 ' + split.groups.length);
    if (split.disabled.length !== 0) throw new Error('undefined 不该当成关闭');
    return true;
  });

  check('skills-manage: 纯内置行——给「编辑」与开关，不给「删除」，标「内置」', () => {
    const html = sandbox._settingsSkillRowHtml(row());
    if (!html.includes('内置')) throw new Error('缺「内置」徽标');
    if (!html.includes('settingsSkillEdit(')) throw new Error('内置也应能编辑（保存成自己的副本）');
    if (!html.includes('settings-model-switch')) throw new Error('开关应是模型列表同款滑块');
    if (!html.includes(' checked')) throw new Error('启用态开关应勾上');
    if (html.includes('settingsSkillDelete(')) throw new Error('纯内置不该给删除按钮');
    if (!html.includes('settingsSkillToggle(\'iso-cutaway\', false)')) throw new Error('开关应带上取反后的目标状态');
    return true;
  });

  check('skills-manage: 自建行给「删除」，改过的内置给「恢复默认」并标「改过的内置」', () => {
    const own = sandbox._settingsSkillRowHtml(row({ source: 'user', builtin: false, name: '受力分析七步' }));
    if (!own.includes('>自建<')) throw new Error('缺「自建」徽标');
    if (!own.includes('settingsSkillDelete(\'iso-cutaway\', false)')) throw new Error('自建应给删除');
    if (!own.includes('>删除<')) throw new Error('自建按钮文案应为「删除」');
    const over = sandbox._settingsSkillRowHtml(row({ source: 'user', builtin: false, overridden: true }));
    if (!over.includes('改过的内置')) throw new Error('覆盖内置的副本应标明来源');
    if (!over.includes('settingsSkillDelete(\'iso-cutaway\', true)')) throw new Error('恢复默认要带 isOverride 标记');
    if (!over.includes('>恢复默认<')) throw new Error('按钮文案应为「恢复默认」');
    return true;
  });

  check('skills-manage: 关闭的行开关不勾选、下一步是打开、整行降透明度（2026-11-17 起状态看滑块不看字样）', () => {
    const html = sandbox._settingsSkillRowHtml(row({ enabled: false, source: 'user', builtin: false }));
    if (html.includes(' checked')) throw new Error('关闭态开关不应勾上');
    if (!html.includes('settingsSkillToggle(\'iso-cutaway\', true)')) throw new Error('关闭态的开关应指向打开');
    if (!html.includes('opacity:.62')) throw new Error('关闭的行应整体降透明度');
    return true;
  });

  check('skills-manage: 导入确认卡把名字/id/描述/节点都做成可改字段，问题条目标红且不可勾选', () => {
    // 勾选状态住在 _skillsPage.importer 里；用真函数置位（同时验证它不依赖真实 DOM）
    sandbox.settingsSkillImportPick(0, true);
    let good;
    try {
      good = sandbox._settingsSkillImportEntryHtml({
        ok: true, filename: 'force.md', id: 'force-analysis', name: '受力分析七步', desc: '斜面题用它',
        scope: ['physics'], chars: 320, warnings: ['没写适用节点，已按内容猜成：物理视角'], problems: []
      }, 0);
    } finally {
      sandbox.settingsSkillImportPick(0, false);
    }
    if (!good.includes('settingsSkillImportField(0, \'name\'')) throw new Error('名字应可改');
    if (!good.includes('settingsSkillImportField(0, \'id\'')) throw new Error('id 应可改');
    if (!good.includes('settingsSkillImportField(0, \'desc\'')) throw new Error('描述应可改');
    if (!good.includes('settingsSkillImportScope(0, \'physics\'')) throw new Error('节点应可点');
    if (!good.includes('猜成')) throw new Error('推断出来的节点要给出提示');
    if (!good.includes('type="checkbox" checked')) throw new Error('可导入的条目默认勾选');

    const bad = sandbox._settingsSkillImportEntryHtml({
      ok: false, filename: 'empty.md', problems: ['内容是空的'], warnings: []
    }, 1);
    if (!bad.includes('内容是空的')) throw new Error('坏条目要显示原因');
    if (!bad.includes('type="checkbox" disabled')) throw new Error('坏条目复选框应禁用');
    if (bad.includes('settingsSkillImportField')) throw new Error('坏条目不该再给编辑字段');
    return true;
  });

  check('skills-manage: 前端接上四个新接口与总开关/导入入口（静态契约）', () => {
    const src = settingsSrc();
    ['/api/skills/toggle', '/api/skills/router', '/api/skills/import', 'dryRun: true'].forEach(mark => {
      if (!src.includes(mark)) throw new Error('缺接口调用：' + mark);
    });
    ['settingsSkillToggleRouter', 'settingsSkillToggle', 'settingsSkillImportOpen',
      'settingsSkillImportFiles', 'settingsSkillImportConfirm', 'settingsSkillImportPick'
    ].forEach(name => {
      if (!src.includes('function ' + name + '(')) throw new Error('缺函数：' + name);
    });
    if (!src.includes("导入技能</button>")) throw new Error('页头缺「导入技能」按钮');
    if (!src.includes('>总开关</span>')) throw new Error('缺总开关标签');
    if (!src.includes('onchange="settingsSkillToggleRouter()"')) throw new Error('总开关应挂滑块 onchange');
    // 输入框 oninput 只存状态、不重画：否则每敲一个字就丢焦点
    if (!src.includes('oninput="settingsSkillImportField(')) throw new Error('导入字段应走 oninput 存状态');
    if (/_settingsPageSkills[\s\S]{0,4000}oninput="[^"]*renderSettingsPage/.test(src)) {
      throw new Error('技能页的输入不该在 oninput 里重画整页');
    }
    // 圆角令牌：设计尺子会拦裸值
    if (/border-radius:999px/.test(src)) throw new Error('技能页仍用裸圆角 999px，应走 var(--r-pill)');
    return true;
  });
}
