import React from 'react';
import { AbsoluteFill, Audio, staticFile, useCurrentFrame } from 'remotion';
import { C } from './theme';
import { decay, hash } from './lib';
import { Stage } from './components/Stage';
import { Hud } from './components/Hud';
import { Subtitles } from './components/ui';
import { subtitles, sectionOf } from './theme';
import { Cold } from './scenes/Cold';
import { Boot } from './scenes/Boot';
import { Dual } from './scenes/Dual';
import { Graph } from './scenes/Graph';
import { Land } from './scenes/Land';
import { Back } from './scenes/Back';
import { Name } from './scenes/Name';

const CUTS = [300, 540, 1020, 1380, 1860, 2220];
const CHAPTER_AT: Record<string, number> = {
  SIGNAL: 0,
  PROTOCOL: 300,
  'DUAL DOMAIN': 540,
  NETWORK: 1020,
  CONTINENT: 1380,
  RETURN: 1860,
  DESIGNATION: 2220,
};

export const Video: React.FC = () => {
  const f = useCurrentFrame();
  const chapter = sectionOf(f);
  const cut = CUTS.reduce((a, c) => a + decay(f, c, 2.4), 0);
  const tear = cut > 0.35 ? Math.round((hash(f * 1.7) - 0.5) * 9) : 0;

  return (
    <AbsoluteFill style={{ background: '#000205' }}>
      <Stage f={f} />

      <AbsoluteFill style={{ transform: `translateX(${tear}px)` }}>
      {f < 300 && <Cold />}
      {f >= 300 && f < 540 && <Boot />}
      {f >= 540 && f < 1020 && <Dual />}
      {f >= 1020 && f < 1380 && <Graph />}
      {f >= 1380 && f < 1860 && <Land />}
      {f >= 1860 && f < 2220 && <Back />}
      {f >= 2220 && <Name />}
      </AbsoluteFill>

      <Hud f={f} chapter={chapter} chapterStart={CHAPTER_AT[chapter] ?? 0} />

      <AbsoluteFill
        style={{
          background: C.cyan,
          opacity: Math.min(0.42, cut * 0.18),
          mixBlendMode: 'screen',
          pointerEvents: 'none',
        }}
      />

      <Subtitles f={f} items={subtitles} />

      <Audio src={staticFile('score.wav')} />
    </AbsoluteFill>
  );
};
