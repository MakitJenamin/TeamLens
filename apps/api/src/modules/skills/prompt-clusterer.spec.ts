import { describe, expect, it } from 'vitest';
import {
  clusterPrompts,
  EXCERPT_MAX,
  fingerprintOf,
  keywordsOf,
  LABEL_MAX,
  type PromptInput,
} from './prompt-clusterer.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
let seq = 0;
const at = (day: number) => new Date(Date.UTC(2026, 10, day, 9, 0, 0));
const prompt = (text: string, over: Partial<PromptInput> = {}): PromptInput => ({
  userId: U1,
  sessionId: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  turnSeq: 1,
  ts: at(10),
  text,
  ...over,
});

describe('keywordsOf', () => {
  it('giữ nguyên chữ có dấu tiếng Việt và bỏ từ dừng', () => {
    const keywords = keywordsOf('Chạy pnpm test rồi sửa lỗi lint trong file này giúp mình nhé');
    expect(keywords).toEqual(['chạy', 'pnpm', 'test', 'sửa', 'lỗi', 'lint', 'trong', 'file']);
  });

  it('chuẩn hóa NFC: chuỗi tổ hợp (NFD) cho đúng kết quả như dạng dựng sẵn (NFC)', () => {
    const nfc = 'Chạy pnpm test rồi sửa lỗi lint trong file này';
    expect(keywordsOf(nfc.normalize('NFD'))).toEqual(keywordsOf(nfc.normalize('NFC')));
  });

  it('bỏ khối code, code nội dòng, URL, đường dẫn, tên file, chuỗi trong ngoặc kép và từ có chữ số', () => {
    const noisy = [
      'Sửa lỗi build trong `foo()` theo https://example.com/docs/v2 ở src/app/cart.ts và file index.tsx,',
      'đọc "thông điệp lỗi gốc" rồi thử lại 3 lần với node18',
      '```ts\nconst bi_mat = 1;\n```',
    ].join(' ');
    const keywords = keywordsOf(noisy);
    expect(keywords).toEqual(['sửa', 'lỗi', 'build', 'trong', 'theo', 'file', 'đọc', 'thử', 'lần']);
    for (const dropped of ['foo', 'example', 'cart', 'index', 'gốc', 'bi_mat', 'node18', 'const']) {
      expect(keywords).not.toContain(dropped);
    }
  });

  it('loại prompt quá ngắn, quá dài, rác và prompt ít hơn 3 từ khóa', () => {
    expect(keywordsOf('sửa lỗi này')).toBeNull(); // dưới 15 ký tự
    expect(keywordsOf('tiếp tục')).toBeNull();
    expect(keywordsOf('continue please, thanks!')).toBeNull(); // ít từ khóa sau khi bỏ từ dừng
    expect(keywordsOf('ok')).toBeNull();
    expect(keywordsOf('làm đi')).toBeNull();
    expect(keywordsOf(`${'viết test cho hàm này '.repeat(120)}`)).toBeNull(); // trên 2000 ký tự
    expect(keywordsOf('Cảm ơn bạn rất nhiều nhé!')).toBeNull();
  });

  it('không trùng từ khóa', () => {
    expect(keywordsOf('test test test lỗi lỗi sửa sửa sửa')).toEqual(['test', 'lỗi', 'sửa']);
  });
});

describe('fingerprintOf', () => {
  it('là 4 từ đầu sau khi sắp xếp theo mã ký tự, không phụ thuộc thứ tự gõ', () => {
    expect(fingerprintOf(['sửa', 'lỗi', 'chạy', 'test', 'lint', 'file'])).toBe('chạy file lint lỗi');
    expect(fingerprintOf(['file', 'lint', 'sửa', 'chạy', 'lỗi', 'test'])).toBe('chạy file lint lỗi');
  });
  it('ít hơn 4 từ thì dùng hết', () => {
    expect(fingerprintOf(['b', 'a', 'c'])).toBe('a b c');
  });
});

describe('clusterPrompts', () => {
  const variants = [
    'Chạy pnpm test rồi sửa lỗi lint trong file src/cart.ts giúp mình nhé',
    'chạy pnpm test và sửa lỗi lint trong file src/checkout/index.tsx nhé',
    'Hãy chạy PNPM test, sửa lỗi lint trong file "orders.ts" lần 2'.replace(' lần 2', ' 2'),
  ];

  it('gom các cách gõ khác nhau về tên file, số, dấu câu, hoa thường thành một cụm', () => {
    const result = clusterPrompts(variants.map((text, i) => prompt(text, { ts: at(10 + i) })));
    expect(result.clusterCount).toBe(1);
    expect(result.promptsAnalyzed).toBe(3);
    expect(result.promptsClustered).toBe(3);
    expect(result.clusters[0]).toMatchObject({ count: 3, userCount: 1, fingerprint: 'chạy file lint lỗi' });
  });

  it('dạng NFD và NFC của cùng một prompt vào cùng cụm', () => {
    const text = 'Chạy pnpm test rồi sửa lỗi lint trong file src/cart.ts giúp mình nhé';
    const result = clusterPrompts([
      prompt(text.normalize('NFC')),
      prompt(text.normalize('NFD')),
      prompt(text.toUpperCase()),
    ]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].count).toBe(3);
  });

  it('chỉ lặp 2 lần thì chưa thành cụm; ngưỡng lặp chỉnh được', () => {
    const two = variants.slice(0, 2).map((t) => prompt(t));
    expect(clusterPrompts(two).clusters).toEqual([]);
    expect(clusterPrompts(two).promptsAnalyzed).toBe(2);
    expect(clusterPrompts(two, { minRepeats: 2 }).clusters).toHaveLength(1);
  });

  it('prompt rác và prompt ngắn không vào cụm dù gõ rất nhiều lần', () => {
    const junk = Array.from({ length: 10 }, () => prompt('tiếp tục đi'));
    const result = clusterPrompts([...junk, ...Array.from({ length: 5 }, () => prompt('ok'))]);
    expect(result).toMatchObject({ promptsAnalyzed: 0, clusterCount: 0, clusters: [] });
  });

  it('đếm người gõ và sắp xếp người gõ nhiều nhất trước', () => {
    const result = clusterPrompts([
      prompt(variants[0], { userId: U2 }),
      prompt(variants[1], { userId: U1 }),
      prompt(variants[2], { userId: U1 }),
    ]);
    expect(result.clusters[0].userCount).toBe(2);
    expect(result.clusters[0].users).toEqual([
      { userId: U1, count: 2 },
      { userId: U2, count: 1 },
    ]);
  });

  it('ví dụ là 3 lần gần nhất theo thời gian giảm dần; có mốc đầu và mốc cuối', () => {
    const texts = [...variants, variants[0], variants[1]];
    const result = clusterPrompts(texts.map((text, i) => prompt(text, { ts: at(1 + i), turnSeq: i })));
    const cluster = result.clusters[0];
    expect(cluster.count).toBe(5);
    expect(cluster.examples.map((e) => e.turnSeq)).toEqual([4, 3, 2]);
    expect(cluster.firstSeenAt).toEqual(at(1));
    expect(cluster.lastSeenAt).toEqual(at(5));
  });

  it('nhãn là prompt có độ dài vừa, gộp khoảng trắng, cắt ở 200 ký tự; đoạn trích cắt ở 160', () => {
    // Phần thêm nằm trong ngoặc kép nên bị bỏ khi tách từ khóa: cùng dấu vân tay nhưng dài hơn nhiều.
    const long = `${variants[0]} ${'"ghi chú dài dòng thêm vào" '.repeat(20)}`;
    const result = clusterPrompts([prompt(variants[0]), prompt(variants[1]), prompt(long)]);
    const cluster = result.clusters[0];
    expect(Array.from(cluster.label).length).toBeLessThanOrEqual(LABEL_MAX);
    // độ dài vừa: không phải prompt quá dài, cũng không phải quá ngắn
    expect(cluster.label).toBe(variants[1]);
    const excerpts = cluster.examples.map((e) => Array.from(e.excerpt).length);
    expect(Math.max(...excerpts)).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(cluster.examples.some((e) => e.excerpt.endsWith('…'))).toBe(true);
  });

  it('không chẻ đôi ký tự ngoài BMP (emoji) khi cắt đoạn trích', () => {
    const emoji = `${variants[0]} ${'🙂'.repeat(200)}`;
    const result = clusterPrompts([prompt(emoji), prompt(variants[1]), prompt(variants[2])]);
    for (const e of result.clusters[0].examples) {
      expect(e.excerpt).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    }
  });

  it('sắp xếp cụm theo số lần lặp giảm dần và giới hạn số cụm trả về', () => {
    const other = (n: number) => `Viết unit test cho module thanh toán phiên bản ${n} bằng vitest`;
    const inputs = [
      ...variants.map((t) => prompt(t)),
      ...[1, 2, 3, 4].map((n) => prompt(other(n))),
    ];
    const all = clusterPrompts(inputs);
    expect(all.clusters.map((c) => c.count)).toEqual([4, 3]);
    const limited = clusterPrompts(inputs, { maxClusters: 1 });
    expect(limited.clusters).toHaveLength(1);
    expect(limited.clusterCount).toBe(2);
    expect(limited.promptsClustered).toBe(7);
  });

  it('kết quả ổn định: cùng đầu vào, thứ tự xáo trộn vẫn ra cùng cụm', () => {
    const inputs = [...variants, ...variants].map((t, i) => prompt(t, { ts: at(1 + (i % 4)), turnSeq: i }));
    const a = clusterPrompts(inputs);
    const b = clusterPrompts([...inputs].reverse());
    expect(b.clusters.map((c) => [c.fingerprint, c.count, c.label])).toEqual(
      a.clusters.map((c) => [c.fingerprint, c.count, c.label]),
    );
  });

  it('đầu vào rỗng cho kết quả rỗng', () => {
    expect(clusterPrompts([])).toEqual({ promptsAnalyzed: 0, promptsClustered: 0, clusterCount: 0, clusters: [] });
  });
});
