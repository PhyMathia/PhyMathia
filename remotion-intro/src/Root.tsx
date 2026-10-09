import {Composition, Folder} from 'remotion';
import {PhyMathiaIntro} from './IntroVideo';
import {OpeningScene} from './scenes/OpeningScene';
import {DualDomainScene} from './scenes/DualDomainScene';
import {CanvasScene} from './scenes/CanvasScene';
import {VizScene} from './scenes/VizScene';
import {PhiScene} from './scenes/PhiScene';
import {LearningScene} from './scenes/LearningScene';
import {ClosingScene} from './scenes/ClosingScene';

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

// 场景时长之和 2160，6 段转场各 25 帧重叠 → 成片 2010 帧（67 秒）
const TOTAL = 2160 - 6 * 25;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Folder name="PhyMathia介绍片">
        <Composition
          id="PhyMathiaIntro"
          component={PhyMathiaIntro}
          durationInFrames={TOTAL}
          fps={FPS}
          width={WIDTH}
          height={HEIGHT}
        />
      </Folder>
      <Folder name="分镜头">
        <Composition
          id="Opening"
          component={OpeningScene}
          durationInFrames={240}
          fps={FPS}
          width={WIDTH}
          height={HEIGHT}
        />
        <Composition
          id="DualDomain"
          component={DualDomainScene}
          durationInFrames={330}
          fps={FPS}
          width={WIDTH}
          height={HEIGHT}
        />
        <Composition
          id="Canvas"
          component={CanvasScene}
          durationInFrames={420}
          fps={FPS}
          width={WIDTH}
          height={HEIGHT}
        />
        <Composition
          id="Viz"
          component={VizScene}
          durationInFrames={270}
          fps={FPS}
          width={WIDTH}
          height={HEIGHT}
        />
        <Composition
          id="Phi"
          component={PhiScene}
          durationInFrames={360}
          fps={FPS}
          width={WIDTH}
          height={HEIGHT}
        />
        <Composition
          id="Learning"
          component={LearningScene}
          durationInFrames={300}
          fps={FPS}
          width={WIDTH}
          height={HEIGHT}
        />
        <Composition
          id="Closing"
          component={ClosingScene}
          durationInFrames={240}
          fps={FPS}
          width={WIDTH}
          height={HEIGHT}
        />
      </Folder>
    </>
  );
};
