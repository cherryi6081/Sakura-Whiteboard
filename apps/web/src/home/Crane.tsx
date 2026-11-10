import type { ReactElement } from "react";
import {
  CRANE_BEAK,
  CRANE_BELLY,
  CRANE_BODY,
  CRANE_COVERTS,
  CRANE_CROWN,
  CRANE_EYE,
  CRANE_FAR_LEG,
  CRANE_FAR_PRIMARIES,
  CRANE_FAR_TOES,
  CRANE_FAR_WING,
  CRANE_FAR_WING_SHAFT,
  CRANE_FLANK,
  CRANE_HEAD,
  CRANE_LAYERS,
  CRANE_LEG,
  CRANE_NAPE,
  CRANE_NEAR_WING,
  CRANE_NEAR_WING_EDGE,
  CRANE_NECK,
  CRANE_PRIMARIES,
  CRANE_SECONDARIES,
  CRANE_TAIL,
  CRANE_TOES,
  CRANE_VIEWBOX,
  bladePath,
  featherPath,
  type CraneLayerId,
} from "./craneGeometry";

/**
 * 首页丹顶鹤。三层容器各自只负责一件事，transform 互不覆盖：
 *   1. `.wb-scene__crane`      —— 外层，沿曲线飞行（translate3d + rotate + opacity）
 *   2. `.wb-scene__crane-flip` —— 静态 scaleX(-1)，把朝右的造型镜像成向左飞
 *   3. `.wb-scene__crane-bob`  —— 轻微上下起伏（振翅周期的半周期）
 * SVG 内部再分两个摆动组（远翼 / 近翼）做原地振翅。
 *
 * 七层各是一个独立 <svg>，用 CSS z-index 明确定层（见 CRANE_LAYERS），
 * 不依赖 DOM 顺序；每个 <svg> 共用同一个 viewBox，坐标一一对应。
 *
 * 两只鹤共用这一份造型，靠 `variant` 挂不同的修饰类：
 *   - 前一只（默认）：基准高度，正常不透明度，取景最靠前；
 *   - 后一只（trail）：高度收到约 0.83、整体略淡、航路延时 3s、振翅相位错开半个周期。
 */

const SVG_PROPS = {
  viewBox: `0 0 ${CRANE_VIEWBOX.width} ${CRANE_VIEWBOX.height}`,
  preserveAspectRatio: "xMidYMid meet",
  focusable: "false",
  "aria-hidden": true,
} as const;

function LegLayer() {
  const [hip, knee, ankle] = CRANE_LEG;
  const [farHip, farKnee, farAnkle] = CRANE_FAR_LEG;
  return (
    <g>
      {/* 远侧腿：更短、更靠内、抬得更高，先画，压在近侧腿之下并整体减淡 */}
      <g className="wb-crane__leg-group wb-crane__leg-group--far">
        <polyline
          className="wb-crane__leg"
          points={`${farHip.x} ${farHip.y} ${farKnee.x} ${farKnee.y} ${farAnkle.x} ${farAnkle.y}`}
        />
        {CRANE_FAR_TOES.map(([from, to]) => (
          <line className="wb-crane__leg" key={`ft-${to.x}-${to.y}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
        ))}
      </g>
      {/* 近侧腿：髋 → 膝 → 踝 三段折线，线宽最细 */}
      <g className="wb-crane__leg-group">
        <polyline
          className="wb-crane__leg"
          points={`${hip.x} ${hip.y} ${knee.x} ${knee.y} ${ankle.x} ${ankle.y}`}
        />
        {CRANE_TOES.map(([from, to]) => (
          <line className="wb-crane__leg" key={`${to.x}-${to.y}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
        ))}
      </g>
    </g>
  );
}

function FarWingLayer() {
  return (
    <g className="wb-crane__wing wb-crane__wing--far">
      {/* 同样先画羽、后压翼面：远翼的黑羽与近翼同色（--crane-ink），只在翼外露一段 */}
      {CRANE_FAR_PRIMARIES.map((feather) => (
        <path
          className="wb-crane__ink"
          key={`${feather.tip.x}-${feather.tip.y}`}
          d={bladePath(feather.base, feather.tip, feather.width, feather.bow, 0.55)}
        />
      ))}
      <path className="wb-crane__plume wb-crane__plume--far" d={CRANE_FAR_WING} />
      <path className="wb-crane__shaft" d={CRANE_FAR_WING_SHAFT} />
    </g>
  );
}

function TailLayer() {
  return (
    <g>
      {CRANE_TAIL.map((feather) => (
        <path
          className="wb-crane__ink"
          key={`${feather.tip.x}-${feather.tip.y}`}
          d={bladePath(feather.base, feather.tip, feather.width, feather.bow)}
        />
      ))}
    </g>
  );
}

function NeckLayer() {
  return (
    <g>
      <path className="wb-crane__plume" d={CRANE_NECK} />
      <path className="wb-crane__shaft" d={CRANE_NAPE} />
    </g>
  );
}

function BodyLayer() {
  return (
    <g>
      <path className="wb-crane__plume" d={CRANE_BODY} />
      <path className="wb-crane__plume-shade" d={CRANE_FLANK} />
      <path className="wb-crane__plume-shade wb-crane__plume-shade--belly" d={CRANE_BELLY} />
    </g>
  );
}

function NearWingLayer() {
  return (
    <g className="wb-crane__wing wb-crane__wing--near">
      {/* 先画飞羽、再压翼面：羽根被翼面盖住，露在轮廓外的只剩一段连续羽面，
          不会在翼面上留下一排羽根的锯齿 */}
      {CRANE_SECONDARIES.map((feather) => (
        <path
          className="wb-crane__plume wb-crane__plume--secondary"
          key={`s-${feather.tip.x}-${feather.tip.y}`}
          d={bladePath(feather.base, feather.tip, feather.width, feather.bow, 0.2)}
        />
      ))}
      {CRANE_PRIMARIES.map((feather) => (
        <path
          className="wb-crane__ink"
          key={`p-${feather.tip.x}-${feather.tip.y}`}
          d={bladePath(feather.base, feather.tip, feather.width, feather.bow, 0.42)}
        />
      ))}
      {/* 翼面闭合填色但不描边：翼根那条边压在躯干上，描边会变成横切躯干的一道线 */}
      <path className="wb-crane__plume-fill" d={CRANE_NEAR_WING} />
      <path className="wb-crane__plume-edge" d={CRANE_NEAR_WING_EDGE} />
      {/* 覆羽分区线：把翼根覆羽与飞羽区分开 */}
      {CRANE_COVERTS.map((d) => (
        <path className="wb-crane__shaft" key={d} d={d} />
      ))}
    </g>
  );
}

function HeadLayer() {
  return (
    <g>
      <path className="wb-crane__plume" d={CRANE_HEAD} />
      <path className="wb-crane__beak" d={CRANE_BEAK} />
      <path className="wb-crane__crown" d={CRANE_CROWN} />
      <circle className="wb-crane__eye" cx={CRANE_EYE.x} cy={CRANE_EYE.y} r={CRANE_EYE.r} />
    </g>
  );
}

const LAYER_ART: Record<CraneLayerId, () => ReactElement> = {
  leg: LegLayer,
  farWing: FarWingLayer,
  tail: TailLayer,
  neck: NeckLayer,
  body: BodyLayer,
  nearWing: NearWingLayer,
  head: HeadLayer,
};

export function Crane({ variant = "lead" }: { variant?: "lead" | "trail" }) {
  return (
    <div className={`wb-scene__crane${variant === "trail" ? " wb-scene__crane--trail" : ""}`} aria-hidden="true">
      <div className="wb-scene__crane-flip">
        <div className="wb-scene__crane-bob">
          {CRANE_LAYERS.map((layer) => {
            const Art = LAYER_ART[layer.id];
            return (
              <svg
                {...SVG_PROPS}
                className={`wb-crane__layer wb-crane__layer--${layer.id}`}
                style={{ zIndex: layer.z }}
                key={layer.id}
              >
                <Art />
              </svg>
            );
          })}
        </div>
      </div>
    </div>
  );
}
