/** 极简线稿图标（1.5px，保持视觉方案 §3.2 的描边口径）。只画必要图标，不做图标墙。 */

type IconProps = { className?: string; size?: number };

const base = (size: number) => ({ width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true });

export function IconBack({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

export function IconEye({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

export function IconEyeOff({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <path d="M4 5l16 14" />
      <path d="M9.6 6.4A10.7 10.7 0 0 1 12 6c6.4 0 10 6 10 6a17.3 17.3 0 0 1-3 3.5M6.3 8.1A17.4 17.4 0 0 0 2 12s3.6 6 10 6a11 11 0 0 0 3.9-.7" />
    </svg>
  );
}

export function IconPlus({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconBoard({ size = 20 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 9v11" />
    </svg>
  );
}

export function IconLock({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function IconClose({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconShare({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6" />
    </svg>
  );
}

export function IconCopy({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
    </svg>
  );
}

export function IconAlert({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <path d="M12 4l8 14H4L12 4z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconImage({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="M21 16l-5-5-6 6-2-2-5 5" />
    </svg>
  );
}

export function IconPin({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <path d="M9.5 3h5l-.9 4.6 3 3.2H7.4l3-3.2L9.5 3z" />
      <path d="M12 10.8V21" />
    </svg>
  );
}

/** 花形标记：用在「置顶」胶囊上，和首页樱花同属一个造型语言 */
export function IconFlower({ size = 12 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      {/* 12px 下描边花瓣会糊成一团，用实心五瓣剪影 + 白芯，缩到 12px 仍能读出花形 */}
      <g fill="currentColor" stroke="none">
        <circle cx="12" cy="7.4" r="2.8" />
        <circle cx="16.4" cy="10.6" r="2.8" />
        <circle cx="14.7" cy="15.6" r="2.8" />
        <circle cx="9.3" cy="15.6" r="2.8" />
        <circle cx="7.6" cy="10.6" r="2.8" />
      </g>
      <circle cx="12" cy="12" r="1.5" style={{ fill: "var(--paper)" }} stroke="none" />
    </svg>
  );
}

export function IconArrowRight({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function IconTrash({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <path d="M4 7h16M10 4h4M6 7l1 13h10l1-13" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}

export function IconRestore({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <path d="M4 12a8 8 0 1 0 2.6-5.9" />
      <path d="M4 4v5h5" />
    </svg>
  );
}

export function IconMore({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconUser({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
    </svg>
  );
}

export function IconCheck({ size = 12 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

