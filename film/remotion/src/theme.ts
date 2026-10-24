export const FPS = 30;
export const BPM = 120;
export const BEAT = 15; // frames
export const BAR = 60; // frames (2s)
export const TOTAL = 2400; // 80s

export const C = {
  void0: '#000205',
  void1: '#03080f',
  void2: '#061019',
  ink: '#EAF6FF',
  cyan: '#4FE3FF',
  cyanSoft: '#9BEEFF',
  cyanDim: 'rgba(79,227,255,0.42)',
  cyanFaint: 'rgba(79,227,255,0.16)',
  amber: '#FFC978',
  amberSoft: '#FFE3B4',
  rose: '#FF4D8D',
  slate: '#7FA0B4',
};

export const F = {
  mono: '"DejaVu Sans Mono", "Noto Sans Mono", monospace',
  serif: '"Noto Serif CJK SC", "DejaVu Serif", serif',
  sans: '"Noto Sans CJK SC", "DejaVu Sans", sans-serif',
};

/** scene boundaries in frames */
export const T = {
  cold: [0, 300],
  boot: [300, 540],
  dual: [540, 1020],
  graph: [1020, 1380],
  land: [1380, 1860],
  back: [1860, 2220],
  name: [2220, 2400],
} as const;

export const sectionOf = (f: number) => {
  if (f < 300) return 'SIGNAL';
  if (f < 540) return 'PROTOCOL';
  if (f < 1020) return 'DUAL DOMAIN';
  if (f < 1380) return 'NETWORK';
  if (f < 1860) return 'CONTINENT';
  if (f < 2220) return 'RETURN';
  return 'DESIGNATION';
};

export const subtitles = [
  { in: 40, out: 130, text: '你一定背过这个。' },
  { in: 150, out: 245, text: '可它到底是什么，没人讲过。' },
  { in: 330, out: 430, text: '所以我想：能不能每次都这么问一遍。' },
  { in: 565, out: 660, text: '左边，一根弦在动。' },
  { in: 675, out: 770, text: '右边，八条正弦在叠加。' },
  { in: 790, out: 880, text: '同一个数，在两边同时亮。' },
  { in: 900, out: 995, text: '一张图，两种记法。' },
  { in: 1060, out: 1155, text: '一个答案，应该长成一张卡。' },
  { in: 1175, out: 1270, text: '每张卡，都还能再长出邻居。' },
  { in: 1420, out: 1520, text: '每问一次，大陆长一寸。' },
  { in: 1650, out: 1750, text: '学科之间的墙，是人为的。' },
  { in: 1930, out: 2035, text: '你问过的问题，还在这里。' },
  { in: 2265, out: 2350, text: '理解，是同时看见它的两种语言。' },
];
