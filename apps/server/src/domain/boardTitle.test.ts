import { describe, expect, it } from 'vitest';
import { BOARD_TITLE_MAX, uniqueBoardTitle } from './boardTitle.js';

describe('uniqueBoardTitle', () => {
  it('不冲突时原样返回（保留用户输入的首尾空格之外的内容）', () => {
    expect(uniqueBoardTitle('Q4 竞品拆解', ['产品评审'])).toBe('Q4 竞品拆解');
  });

  it('同名（忽略首尾空格与大小写）时从（2）开始递增', () => {
    expect(uniqueBoardTitle('Roadmap', ['roadmap'])).toBe('Roadmap（2）');
    expect(uniqueBoardTitle('Roadmap', ['Roadmap', 'Roadmap（2）'])).toBe('Roadmap（3）');
  });

  it('空标题回落「未命名白板」', () => {
    expect(uniqueBoardTitle('   ', [])).toBe('未命名白板');
  });

  it('长标题拼后缀后仍不超过 80 字符', () => {
    const long = '长'.repeat(BOARD_TITLE_MAX);
    const result = uniqueBoardTitle(long, [long]);
    expect(result.length).toBeLessThanOrEqual(BOARD_TITLE_MAX);
    expect(result.endsWith('（2）')).toBe(true);
  });
});
