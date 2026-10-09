import {TransitionSeries} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {slide} from '@remotion/transitions/slide';
import {linearTiming} from '@remotion/transitions';
import {useVideoConfig} from 'remotion';
import {OpeningScene} from './scenes/OpeningScene';
import {DualDomainScene} from './scenes/DualDomainScene';
import {CanvasScene} from './scenes/CanvasScene';
import {VizScene} from './scenes/VizScene';
import {PhiScene} from './scenes/PhiScene';
import {LearningScene} from './scenes/LearningScene';
import {ClosingScene} from './scenes/ClosingScene';

const TRANSITION = 25;

export const PhyMathiaIntro: React.FC = () => {
  const {fps} = useVideoConfig();

  return (
    <TransitionSeries>
      <TransitionSeries.Sequence name="封面" durationInFrames={240} premountFor={fps}>
        <OpeningScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({durationInFrames: TRANSITION})} />

      <TransitionSeries.Sequence name="双域解释" durationInFrames={330} premountFor={fps}>
        <DualDomainScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({direction: 'from-left'})} timing={linearTiming({durationInFrames: TRANSITION})} />

      <TransitionSeries.Sequence name="探索网画布" durationInFrames={420} premountFor={fps}>
        <CanvasScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({durationInFrames: TRANSITION})} />

      <TransitionSeries.Sequence name="交互可视化" durationInFrames={270} premountFor={fps}>
        <VizScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={slide({direction: 'from-right'})} timing={linearTiming({durationInFrames: TRANSITION})} />

      <TransitionSeries.Sequence name="Φ 网络助手" durationInFrames={360} premountFor={fps}>
        <PhiScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({durationInFrames: TRANSITION})} />

      <TransitionSeries.Sequence name="学习系统" durationInFrames={300} premountFor={fps}>
        <LearningScene />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()} timing={linearTiming({durationInFrames: TRANSITION})} />

      <TransitionSeries.Sequence name="收尾" durationInFrames={240} premountFor={fps}>
        <ClosingScene />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  );
};
