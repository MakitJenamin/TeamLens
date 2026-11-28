import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError } from '../../../common/api-error.js';
import { parseArgs, truncateText } from './base-tool.js';

describe('truncateText', () => {
  it('giữ nguyên khi chưa vượt, cắt đúng độ dài khi vượt', () => {
    expect(truncateText('abc', 3)).toEqual({ text: 'abc', truncated: false });
    expect(truncateText('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
  });

  it('không chẻ đôi cặp surrogate (emoji) ở chỗ cắt', () => {
    const cut = truncateText('ab😀cd', 3); // 😀 chiếm 2 đơn vị UTF-16 nên chỗ cắt rơi vào giữa
    expect(cut).toEqual({ text: 'ab', truncated: true });
    expect(truncateText('ab😀cd', 4)).toEqual({ text: 'ab😀', truncated: true });
  });
});

describe('parseArgs', () => {
  const schema = z.strictObject({ n: z.number().int().min(1).default(5) });

  it('áp giá trị mặc định và chấp nhận args rỗng hoặc undefined', () => {
    expect(parseArgs(schema, {})).toEqual({ n: 5 });
    expect(parseArgs(schema, undefined)).toEqual({ n: 5 });
  });

  it('sai tham số thì 400 validation_error, có đường dẫn nhưng KHÔNG in giá trị', () => {
    try {
      parseArgs(schema, { n: 'bi-mat-khong-duoc-lo' });
      throw new Error('phải ném lỗi');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const body = (e as ApiError).getResponse() as { error: string; message: string };
      expect((e as ApiError).getStatus()).toBe(400);
      expect(body.error).toBe('validation_error');
      expect(body.message).toContain('n:');
      expect(body.message).not.toContain('bi-mat-khong-duoc-lo');
    }
  });

  it('tham số lạ bị từ chối (strictObject)', () => {
    expect(() => parseArgs(schema, { n: 1, la: true })).toThrow(ApiError);
  });
});
