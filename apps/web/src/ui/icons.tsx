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

export function IconArrowRight({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} className="wb-icon" style={{ width: size, height: size }}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
