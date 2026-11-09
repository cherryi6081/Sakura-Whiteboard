import type { AssetMime } from '@whiteboard/shared';

/**
 * 服务端图片内容校验（v1.1，§4.6 第二章）。
 *
 * 只解析文件头（magic number + 尺寸），**不信任**扩展名和请求的 `Content-Type`：
 * 路由必须用这里识别出的 mime 与声明值比对，不一致直接 415。
 * 不接收 SVG，因此这里也不做任何 XML 解析。
 */

export type DetectedImage = {
  mime: AssetMime;
  width: number;
  height: number;
};

const MAX_DIMENSION = 100_000;

function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  // 8 字节签名 + 4 字节长度 + 'IHDR'
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1] ?? 0;
    // 无长度的独立标记
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function gifSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function webpSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null;
  const chunk = buf.toString('ascii', 12, 16);

  if (chunk === 'VP8X') {
    // 24 位宽高（各减 1），小端
    return {
      width: 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)),
      height: 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)),
    };
  }

  if (chunk === 'VP8 ') {
    if (!(buf[20] === 0x9d && buf[21] === 0x01 && buf[22] === 0x2a)) return null;
    return {
      width: (buf[26]! | (buf[27]! << 8)) & 0x3fff,
      height: (buf[28]! | (buf[29]! << 8)) & 0x3fff,
    };
  }

  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const b1 = buf[21]!;
    const b2 = buf[22]!;
    const b3 = buf[23]!;
    const b4 = buf[24]!;
    return {
      width: 1 + ((b2 & 0x3f) << 8 | b1),
      height: 1 + ((b4 & 0x0f) << 10 | (b3 << 2) | (b2 >> 6)),
    };
  }

  return null;
}

function isSane(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION;
}

/** 识别图片；返回 `null` 表示不是受支持的真实图片内容。 */
export function detectImage(buf: Buffer): DetectedImage | null {
  if (buf.length < 10) return null;

  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const size = pngSize(buf);
    return size && isSane(size.width, size.height) ? { mime: 'image/png', ...size } : null;
  }

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const size = jpegSize(buf);
    return size && isSane(size.width, size.height) ? { mime: 'image/jpeg', ...size } : null;
  }

  const gifHeader = buf.toString('ascii', 0, 6);
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    const size = gifSize(buf);
    return size && isSane(size.width, size.height) ? { mime: 'image/gif', ...size } : null;
  }

  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const size = webpSize(buf);
    return size && isSane(size.width, size.height) ? { mime: 'image/webp', ...size } : null;
  }

  return null;
}
