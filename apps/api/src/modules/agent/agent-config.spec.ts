import {
  DEFAULT_TRUNCATION,
  mergeTruncation,
  parseRedactionPatterns,
} from './agent-config.js';

describe('parseRedactionPatterns', () => {
  it('thiếu hoặc sai kiểu → []', () => {
    expect(parseRedactionPatterns(undefined)).toEqual([]);
    expect(parseRedactionPatterns(null)).toEqual([]);
    expect(parseRedactionPatterns({ id: 'x', regex: 'y' })).toEqual([]);
  });

  it('giữ phần tử hợp lệ, bỏ phần tử sai dạng và trường thừa', () => {
    expect(
      parseRedactionPatterns([
        { id: 'acme_internal_token', regex: 'acme_[A-Za-z0-9]{32}', note: 1 },
        { id: '', regex: 'x' },
        { id: 'no_regex' },
        'chuỗi',
        null,
        { id: 'b', regex: 'b+' },
      ]),
    ).toEqual([
      { id: 'acme_internal_token', regex: 'acme_[A-Za-z0-9]{32}' },
      { id: 'b', regex: 'b+' },
    ]);
  });
});

describe('mergeTruncation', () => {
  it('thiếu setting → mặc định', () => {
    expect(mergeTruncation(undefined)).toEqual(DEFAULT_TRUNCATION);
    expect(mergeTruncation([1, 2])).toEqual(DEFAULT_TRUNCATION);
  });

  it('ghi đè từng trường hợp lệ, bỏ giá trị âm, lẻ, sai kiểu và key lạ', () => {
    expect(
      mergeTruncation({
        tool_input_bytes: 100,
        output_head_bytes: -1,
        output_tail_bytes: 1.5,
        diff_bytes: '9',
        thinking_bytes: 0,
        other: 5,
      }),
    ).toEqual({
      ...DEFAULT_TRUNCATION,
      tool_input_bytes: 100,
      thinking_bytes: 0,
    });
  });

  it('không làm đổi hằng số mặc định', () => {
    mergeTruncation({ tool_input_bytes: 1 });
    expect(DEFAULT_TRUNCATION.tool_input_bytes).toBe(4096);
  });
});
