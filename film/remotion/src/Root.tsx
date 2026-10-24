import React from 'react';
import { Composition } from 'remotion';
import { Video } from './Video';
import { FPS, TOTAL } from './theme';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition id="PhyMathia" component={Video} durationInFrames={TOTAL} fps={FPS} width={1920} height={1080} />
    </>
  );
};
