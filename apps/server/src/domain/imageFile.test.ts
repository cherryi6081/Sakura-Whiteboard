import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { detectImage } from './imageFile.js';

/** 用真实 PNG 头构造（检测只看 IHDR，不校验 CRC）。 */
function pngBytes(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // RGBA
  const idat = Buffer.from(deflateSync(Buffer.from([0, 0, 0, 0, 0])));
  return Buffer.concat([signature, ihdr, idat]);
}

function jpegBytes(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(16);
  app0.writeUInt16BE(0x0010, 0); // 段长（含自身 2 字节）
  app0.writeUInt16BE(0x0001, 2); // APP0
  const sof = Buffer.alloc(17);
  sof.writeUInt16BE(0x0011, 0);
  sof[2] = 8; // 精度
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0]),
    app0,
    Buffer.from([0xff, 0xc0]),
    sof,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function gifBytes(width: number, height: number): Buffer {
  const head = Buffer.alloc(10);
  head.write('GIF89a', 0, 'ascii');
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return Buffer.concat([head, Buffer.from([0x3b])]);
}

function webpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf[24] = (width - 1) & 0xff;
  buf[25] = ((width - 1) >> 8) & 0xff;
  buf[26] = ((width - 1) >> 16) & 0xff;
  buf[27] = (height - 1) & 0xff;
  buf[28] = ((height - 1) >> 8) & 0xff;
  buf[29] = ((height - 1) >> 16) & 0xff;
  return buf;
}

describe('detectImage', () => {
  it('识别 PNG 并读出尺寸', () => {
    expect(detectImage(pngBytes(120, 80))).toEqual({ mime: 'image/png', width: 120, height: 80 });
  });

  it('识别 JPEG（SOF0）并读出尺寸', () => {
    expect(detectImage(jpegBytes(64, 48))).toEqual({ mime: 'image/jpeg', width: 64, height: 48 });
  });

  it('识别 GIF89a 并读出尺寸', () => {
    expect(detectImage(gifBytes(32, 24))).toEqual({ mime: 'image/gif', width: 32, height: 24 });
  });

  it('识别 WebP（VP8X 容器）并读出尺寸', () => {
    expect(detectImage(webpVp8x(200, 150))).toEqual({ mime: 'image/webp', width: 200, height: 150 });
  });

  it('拒绝 SVG 与纯文本（不能只信扩展名/Content-Type）', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(detectImage(svg)).toBeNull();
    expect(detectImage(Buffer.from('hello world'))).toBeNull();
  });

  it('拒绝伪造扩展名：PNG 签名但尺寸非法', () => {
    expect(detectImage(pngBytes(0, 0))).toBeNull();
    expect(detectImage(pngBytes(200_000, 10))).toBeNull();
  });

  it('拒绝被截断的文件头', () => {
    expect(detectImage(pngBytes(10, 10).subarray(0, 12))).toBeNull();
  });
});
