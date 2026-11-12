/**
 * 「我的白板」右上角的一枝樱花（背景 A 的装饰层）。
 *
 * 与首页共用同一套色板：枝干 `--branch-brown-900/500`，花 `--sakura-100/200/300`，
 * 花芯 `--sakura-bloom-core`。只是枝条/花，不满铺，也不参与点击。
 * 单瓣路径沿用首页樱花的花瓣形状（上端收圆、中间小缺口），保证两页造型一致。
 */

const PETAL_PATH =
  "M0 0 C -0.32 -0.18 -0.56 -0.44 -0.5 -0.74 C -0.46 -0.93 -0.3 -1 -0.17 -0.95 L 0 -0.8 L 0.17 -0.95 C 0.3 -1 0.46 -0.93 0.5 -0.74 C 0.56 -0.44 0.32 -0.18 0 0 Z";
const PETAL_ANGLES = [0, 72, 144, 216, 288];
const HALF_ANGLES = [-58, 0, 58];

function Blossom({
  x,
  y,
  size,
  rotate,
  half = false,
  bud = false,
}: {
  x: number;
  y: number;
  size: number;
  rotate: number;
  half?: boolean;
  bud?: boolean;
}) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${size * (bud ? 0.78 : half ? 0.9 : 1)})`}>
      {bud ? (
        <path
          d="M0 0 C -0.42 -0.18 -0.56 -0.5 -0.44 -0.78 C -0.34 -1 -0.12 -1.08 0 -1.02 C 0.12 -1.08 0.34 -1 0.44 -0.78 C 0.56 -0.5 0.42 -0.18 0 0 Z"
          fill="var(--sakura-200)"
          stroke="var(--sakura-300)"
          strokeWidth="0.04"
        />
      ) : (
        <>
          {(half ? HALF_ANGLES : PETAL_ANGLES).map((deg, index) => (
            <path
              key={deg}
              d={PETAL_PATH}
              transform={`rotate(${deg})`}
              fill={index % 2 === 1 ? "var(--sakura-300)" : index === 0 ? "var(--sakura-100)" : "var(--sakura-200)"}
              stroke="var(--sakura-300)"
              strokeWidth="0.03"
            />
          ))}
          <circle r="0.3" fill="var(--sakura-bloom-core)" />
        </>
      )}
    </g>
  );
}

export function SakuraBranch() {
  return (
    <svg
      className="wb-boards__branch"
      viewBox="0 0 560 400"
      preserveAspectRatio="xMaxYMin meet"
      aria-hidden
      focusable="false"
    >
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.9">
        {/* 主枝：从右上角伸入，向画面中下部垂落 */}
        <path
          d="M566 -10 C 520 52 486 92 442 116 C 404 137 380 166 358 200"
          stroke="var(--branch-brown-900)"
          strokeWidth="5.6"
        />
        {/* 侧枝与末梢：越靠梢越细、越浅，形成一根树的层次 */}
        <path d="M486 92 C 458 72 428 58 398 46" stroke="var(--branch-brown-900)" strokeWidth="3.6" />
        <path d="M398 46 C 382 34 366 29 350 27" stroke="var(--branch-brown-500)" strokeWidth="2" />
        <path d="M442 116 C 424 146 402 168 380 182" stroke="var(--branch-brown-500)" strokeWidth="3.2" />
        <path d="M442 116 C 449 148 443 172 429 192" stroke="var(--branch-brown-500)" strokeWidth="2.4" />
        <path d="M380 182 C 367 204 349 220 330 232" stroke="var(--branch-brown-500)" strokeWidth="2.2" />
        <path d="M358 200 C 348 214 338 224 326 230" stroke="var(--branch-brown-500)" strokeWidth="1.6" />
      </g>

      <g strokeLinecap="round">
        <Blossom x={350} y={27} size={16} rotate={12} />
        <Blossom x={398} y={46} size={13} rotate={-18} half />
        <Blossom x={442} y={116} size={10} rotate={-20} bud />
        <Blossom x={380} y={182} size={12} rotate={30} half />
        <Blossom x={429} y={192} size={14} rotate={-8} />
        <Blossom x={330} y={232} size={15} rotate={22} />
        <Blossom x={326} y={230} size={11} rotate={8} bud />
        {/* 两片被风带离枝条的单瓣，保持"一枝花"而非"贴图满铺" */}
        <path
          d={PETAL_PATH}
          transform="translate(300 112) rotate(38) scale(7)"
          fill="var(--sakura-200)"
          stroke="var(--sakura-300)"
          strokeWidth="0.04"
        />
        <path
          d={PETAL_PATH}
          transform="translate(392 152) rotate(-26) scale(6)"
          fill="var(--sakura-100)"
          stroke="var(--sakura-300)"
          strokeWidth="0.04"
        />
      </g>
    </svg>
  );
}
