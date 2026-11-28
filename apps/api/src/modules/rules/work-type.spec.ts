import { describe, expect, it } from 'vitest';
import type { RuleTurn } from './session-engine.js';
import { classifyWorkType } from './work-type.js';

let seq = 0;
const prompt = (text: string): RuleTurn => ({ seq: ++seq, role: 'user', kind: 'prompt', text });
const reply = (text: string): RuleTurn => ({ seq: ++seq, role: 'assistant', kind: 'reply', text });
const edit = (path: string, added = 10, removed = 0): RuleTurn => ({
  seq: ++seq,
  role: 'assistant',
  kind: 'tool_call',
  tool: { name: 'Edit', status: 'ok' },
  diff: { path, added, removed },
});
const read = (): RuleTurn => ({ seq: ++seq, role: 'assistant', kind: 'tool_call', tool: { name: 'Read', status: 'ok' } });

describe('classifyWorkType: từ khóa tiếng Việt và tiếng Anh', () => {
  it.each([
    ['Sửa lỗi đăng nhập khi mật khẩu có ký tự đặc biệt', 'bugfix'],
    ['Fix the crash when the cart is empty', 'bugfix'],
    ['Trang giỏ hàng bị lỗi 500 khi bấm thanh toán', 'bugfix'],
    ['Thêm tính năng xuất báo cáo ra CSV', 'feature'],
    ['Implement a new endpoint to list invoices', 'feature'],
    ['Refactor the payment module and rename the helpers', 'refactor'],
    ['Tái cấu trúc module thanh toán, tách hàm tính thuế ra file riêng', 'refactor'],
    ['Viết unit test cho hàm tính thuế, tăng độ phủ', 'test'],
    ['Cập nhật tài liệu hướng dẫn cài đặt trong README', 'docs'],
    ['Deploy the app with docker compose and fix the CI pipeline config', 'ops'],
    ['Triển khai lên máy chủ bằng Docker và cấu hình nginx', 'ops'],
  ])('%s → %s', (text, expected) => {
    // Có sửa file ở một đường dẫn trung tính để chỉ từ khóa quyết định.
    expect(classifyWorkType([prompt(text), edit('src/app.ts'), reply('xong')])).toBe(expected);
  });

  it('không phân biệt hoa thường và chữ có dấu dạng NFD', () => {
    const nfd = 'SỬA LỖI đăng nhập'.normalize('NFD');
    expect(classifyWorkType([prompt(nfd), edit('src/a.ts')])).toBe('bugfix');
  });

  it('chỉ khớp nguyên từ: "prefix" không phải "fix", "additional" không phải "add"', () => {
    expect(classifyWorkType([prompt('Look at the prefix handling and additional casing'), edit('src/a.ts')])).toBe('other');
  });

  it('prompt đầu nặng hơn các prompt sau', () => {
    const turns = [
      prompt('Thêm tính năng đăng nhập bằng Google'),
      edit('src/a.ts'),
      prompt('sửa lỗi nhỏ'),
      prompt('sửa lỗi nữa'),
    ];
    // feature: 3 (prompt đầu) ; bugfix: 1 + 1 = 2
    expect(classifyWorkType(turns)).toBe('feature');
  });

  it('điểm bằng nhau thì theo thứ tự ưu tiên bugfix > refactor > feature', () => {
    expect(classifyWorkType([prompt('sửa lỗi và thêm cái mới'), edit('src/a.ts')])).toBe('bugfix');
    expect(classifyWorkType([prompt('refactor và thêm'), edit('src/a.ts')])).toBe('refactor');
  });

  it('không có từ khóa nào thì "other"; chỉ xét prompt của người dùng, không xét lời assistant', () => {
    expect(classifyWorkType([prompt('hãy làm như hôm qua'), reply('Tôi đã sửa lỗi và thêm test'), edit('src/a.ts')])).toBe('other');
  });
});

describe('classifyWorkType: hỏi đáp', () => {
  it('không sửa file mà prompt đầu là câu hỏi → question', () => {
    expect(classifyWorkType([prompt('Hàm này hoạt động thế nào?'), read(), reply('Nó...')])).toBe('question');
    expect(classifyWorkType([prompt('Giải thích giúp mình luồng đăng nhập'), read(), reply('...')])).toBe('question');
    expect(classifyWorkType([prompt('Why does the cache return stale data'), read()])).toBe('question');
  });

  it('có sửa file thì không còn là question dù prompt có dấu hỏi', () => {
    expect(classifyWorkType([prompt('Tại sao test này fail? Sửa lỗi giúp mình'), edit('src/a.ts')])).toBe('bugfix');
  });

  it('không sửa file, không phải câu hỏi, có từ khóa thì theo từ khóa', () => {
    expect(classifyWorkType([prompt('fix the failing build'), read()])).toBe('bugfix');
  });

  it('không sửa file, không câu hỏi, không từ khóa → other', () => {
    expect(classifyWorkType([prompt('chạy thử ứng dụng giúp mình'), read()])).toBe('other');
  });
});

describe('classifyWorkType: đường dẫn file bị sửa', () => {
  it('phần lớn dòng đổi ở file test → test, bất kể từ khóa', () => {
    const turns = [prompt('Sửa lỗi đăng nhập'), edit('src/login.ts', 5), edit('src/login.test.ts', 40), edit('test/e2e/login.e2e-spec.ts', 30)];
    expect(classifyWorkType(turns)).toBe('test');
  });

  it('nhận diện nhiều kiểu tên file test', () => {
    for (const path of ['src/a.spec.ts', 'tests/a.py', 'pkg/__tests__/a.js', 'a_test.go', 'test_a.py', 'src/a.e2e-spec.ts'])
      expect(classifyWorkType([prompt('cập nhật code'), edit(path)])).toBe('test');
  });

  it('toàn tài liệu → docs; lẫn một ít code (dưới 90%) thì theo từ khóa', () => {
    expect(classifyWorkType([prompt('cập nhật'), edit('README.md'), edit('docs/setup.md')])).toBe('docs');
    expect(classifyWorkType([prompt('thêm tính năng mới'), edit('README.md', 50), edit('src/a.ts', 10)])).toBe('feature');
  });

  it('phần lớn ở file hạ tầng → ops', () => {
    const turns = [prompt('cập nhật'), edit('Dockerfile', 20), edit('.github/workflows/ci.yml', 30), edit('src/a.ts', 5)];
    expect(classifyWorkType(turns)).toBe('ops');
  });

  it('diff không có số dòng thì tính theo số file', () => {
    const turns = [prompt('cập nhật'), edit('a.test.ts', 0), edit('b.test.ts', 0), edit('c.test.ts', 0), edit('d.ts', 0)];
    expect(classifyWorkType(turns)).toBe('test');
  });

  it('đường dẫn Windows cũng nhận diện', () => {
    expect(classifyWorkType([prompt('cập nhật'), edit('src\\__tests__\\a.ts')])).toBe('test');
  });
});

describe('classifyWorkType: trường hợp biên', () => {
  it('không có prompt của người dùng → null', () => {
    expect(classifyWorkType([])).toBeNull();
    expect(classifyWorkType([reply('xin chào'), edit('a.ts')])).toBeNull();
    expect(classifyWorkType([{ seq: 1, role: 'user', kind: 'prompt', text: '   ' }])).toBeNull();
    expect(classifyWorkType([{ seq: 1, role: 'user', kind: 'prompt', text: null }])).toBeNull();
  });

  it('tool sửa file mà không có diff vẫn tính là có sửa (không phải question)', () => {
    const toolOnly: RuleTurn = { seq: 9, role: 'assistant', kind: 'tool_call', tool: { name: 'apply_patch' } };
    expect(classifyWorkType([prompt('Tại sao lỗi này xảy ra?'), toolOnly])).not.toBe('question');
  });

  it('một từ khóa lặp rất nhiều lần không lấn át (mỗi prompt tối đa 3 lần đếm)', () => {
    const spam = 'fix '.repeat(50);
    expect(classifyWorkType([prompt(`thêm tính năng mới, thêm trang, tạo endpoint ${spam}`), edit('a.ts')])).toBe('bugfix');
  });

  it('kết quả ổn định: gọi lại cho cùng kết quả', () => {
    const turns = [prompt('Sửa lỗi crash khi mở app'), edit('a.ts')];
    expect(classifyWorkType(turns)).toBe(classifyWorkType(turns));
  });
});
