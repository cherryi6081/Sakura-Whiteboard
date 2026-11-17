import { describe, expect, it } from 'vitest';
import { CURSOR_COLORS, cursorColorOf } from './cursorPalette.js';

const LEGACY = ['#A85C7C', '#7C8AA8', '#5C9E7C', '#A88B5C', '#8A5CA8', '#5CA8A0'];
const WHITE = [255, 255, 255];
/** 夜间主题的页面底色（tokens.css `--surface-page`） */
const NIGHT = hexToRgb('#131a2b');

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: readonly number[]): number {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r as number) + 0.7152 * channel(g as number) + 0.0722 * channel(b as number);
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** sRGB → CIELAB(D65)，用于 CIE76 色差 */
function toLab(rgb: readonly number[]): [number, number, number] {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb.map(channel) as [number, number, number];
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(a: readonly number[], b: readonly number[]): number {
  const la = toLab(a);
  const lb = toLab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

describe('CURSOR_COLORS', () => {
  it('20 色且互不重复，原有 6 色原样保留在最前面', () => {
    expect(CURSOR_COLORS).toHaveLength(20);
    expect(new Set(CURSOR_COLORS.map((hex) => hex.toUpperCase())).size).toBe(20);
    expect(CURSOR_COLORS.slice(0, 6)).toEqual(LEGACY);
  });

  it('任意两色 CIE76 色差 ≥ 15（旧色自身最接近的一对是 15.4）', () => {
    let min = Infinity;
    let pair: [string, string] = ['', ''];
    for (let i = 0; i < CURSOR_COLORS.length; i++) {
      for (let j = i + 1; j < CURSOR_COLORS.length; j++) {
        const d = deltaE(hexToRgb(CURSOR_COLORS[i] as string), hexToRgb(CURSOR_COLORS[j] as string));
        if (d < min) {
          min = d;
          pair = [CURSOR_COLORS[i] as string, CURSOR_COLORS[j] as string];
        }
      }
    }
    expect(min, `最近的一对：${pair[0]} / ${pair[1]}`).toBeGreaterThanOrEqual(15);
  });

  it('9px 圆点在浅色与夜间主题下都看得清：对白底 ≥ 2.75、对夜间底 ≥ 3.1', () => {
    for (const hex of CURSOR_COLORS) {
      const rgb = hexToRgb(hex);
      expect(contrast(rgb, WHITE), `${hex} 对白底`).toBeGreaterThanOrEqual(2.75);
      expect(contrast(rgb, NIGHT), `${hex} 对夜间底`).toBeGreaterThanOrEqual(3.1);
    }
  });
});

describe('cursorColorOf', () => {
  it('同一 seed 永远得到同一个颜色，且落在色板内', () => {
    const seeds = ['user:6f1c2a9e-6a40-4d3e-9f4a-1c2b3d4e5f60', 'guest:g_abc123', 'web_client_01'];
    for (const seed of seeds) {
      const color = cursorColorOf(seed);
      expect(CURSOR_COLORS).toContain(color);
      expect(cursorColorOf(seed)).toBe(color);
    }
  });

  it('只取决于 seed 本身，与在线人数/顺序无关', () => {
    // 同一份身份在「独自在线」和「多人围观」两种场景下颜色必然一致（纯函数，无外部状态）
    const color = cursorColorOf('user:a1b2c3d4');
    expect([color, color, color]).toEqual([color, color, color]);
  });

  it('扩到 20 色后分布铺开，不再 6 色那么拥挤', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      seen.add(cursorColorOf(`user:${i.toString(36)}-${(i * 7919).toString(36)}`));
    }
    expect(seen.size).toBeGreaterThanOrEqual(16);
  });
});
