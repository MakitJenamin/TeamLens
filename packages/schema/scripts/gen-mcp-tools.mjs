// Sinh packages/schema/mcp/<tool>.json cho M6.15 từ OpenAPI đã dereference (không gõ tay lại schema dài).
// Chạy: pnpm --filter @teamlens/schema generate:mcp (bundle OpenAPI đã dereference rồi chạy file này).
// Các file sinh ra: mọi tool trong `tools` bên dưới (KHÔNG sửa tay file .json của chúng, sửa ở đây rồi sinh lại);
// `whoami.json` viết tay, không đụng tới.
// Dùng trực tiếp: node scripts/gen-mcp-tools.mjs <deref.json> <thư mục mcp/>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , derefPath, outDir] = process.argv;
const spec = JSON.parse(readFileSync(derefPath, 'utf8'));
const S = spec.components.schemas;
const SCHEMA = 'https://json-schema.org/draft/2020-12/schema';

const DROP = new Set(['example', 'discriminator', 'xml', 'externalDocs', 'nullable']);

function mergeAllOf(node) {
  const merged = { type: 'object', properties: {}, required: [] };
  for (const part of node.allOf) {
    const p = part.allOf ? mergeAllOf(part) : part;
    Object.assign(merged.properties, p.properties ?? {});
    for (const r of p.required ?? []) if (!merged.required.includes(r)) merged.required.push(r);
    if (p.description && !node.description) merged.description = p.description;
  }
  for (const [k, v] of Object.entries(node)) if (k !== 'allOf') merged[k] = v;
  return merged;
}

/** OpenAPI 3.1 → JSON Schema 2020-12 chặt: bỏ từ khóa riêng của OpenAPI, gộp allOf, object kín. */
function clean(node) {
  if (Array.isArray(node)) return node.map(clean);
  if (node === null || typeof node !== 'object') return node;
  if (node.allOf) node = mergeAllOf(node);
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP.has(k) || k.startsWith('x-')) continue;
    if (k === 'properties') {
      out[k] = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, clean(s)]));
    } else if (k === 'enum' || k === 'required' || k === 'type' || k === 'const' || k === 'examples') {
      out[k] = v;
    } else {
      out[k] = clean(v);
    }
  }
  if (out.type === 'object' && out.properties && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  return out;
}

const uuid = (description) => ({ type: 'string', format: 'uuid', ...(description ? { description } : {}) });
const dateTime = (description) => ({ type: 'string', format: 'date-time', description });
const obj = (properties, required = []) => ({
  type: 'object',
  required,
  additionalProperties: false,
  properties,
});
const root = (schema) => ({ $schema: SCHEMA, ...schema });
const nullable = (schema) => ({ oneOf: [schema, { type: 'null' }] });

const RANGE_NOTE =
  '`from` (>=) và `to` (<) theo `startedAt` của session, ISO 8601; server làm tròn ra biên tuần UTC (thứ Hai 00:00) và trả khoảng thực tế ở `range`.';

// --- Turn rút gọn cho agent (get_session) -------------------------------------------------
const TEXT_MAX = 2000;
const mcpTurn = obj(
  {
    seq: { type: 'integer', minimum: 0 },
    role: { type: 'string', enum: ['user', 'assistant', 'system'] },
    kind: { type: 'string', enum: ['prompt', 'reply', 'tool_call', 'tool_result', 'compaction'] },
    ts: dateTime('Thời điểm của turn.'),
    model: { type: ['string', 'null'] },
    text: {
      type: ['string', 'null'],
      description: `Nội dung (đã che secret), cắt còn tối đa ${TEXT_MAX} ký tự.`,
    },
    textTruncated: { type: 'boolean', description: `true khi \`text\` đã bị cắt ở ${TEXT_MAX} ký tự.` },
    tool: nullable(
      obj({ name: { type: 'string' }, status: { type: ['string', 'null'], enum: ['ok', 'error', null] } }, [
        'name',
        'status',
      ]),
    ),
    output: nullable(
      obj(
        {
          text: { type: 'string', description: `Output của tool, cắt còn tối đa ${TEXT_MAX} ký tự.` },
          truncated: { type: 'boolean', description: 'true khi output đã bị cắt (ở CLI hoặc ở đây).' },
        },
        ['text', 'truncated'],
      ),
    ),
    diff: nullable(
      obj(
        {
          path: { type: 'string' },
          added: { type: 'integer', minimum: 0 },
          removed: { type: 'integer', minimum: 0 },
        },
        ['path', 'added', 'removed'],
      ),
    ),
    usage: nullable(
      obj({ input: { type: 'integer', minimum: 0 }, output: { type: 'integer', minimum: 0 } }, ['input', 'output']),
    ),
    interrupted: { type: 'boolean' },
  },
  ['seq', 'role', 'kind', 'ts', 'model', 'text', 'textTruncated', 'tool', 'output', 'diff', 'usage', 'interrupted'],
);

const sessionDetail = clean(S.SessionDetail);
delete sessionDetail.properties.turns;
sessionDetail.required = sessionDetail.required.filter((r) => r !== 'turns');
sessionDetail.description = 'Thông tin session (như `SessionDetail` của dashboard, không gồm turn; turn ở `turns`).';

const aiResult = clean(S.AiResult);

const ruleSummary = {
  key: { type: 'string', examples: ['no-test-after-edit'] },
  category: { type: 'string', description: 'Nhóm kỹ năng của rule.' },
  severity: { type: 'string', enum: ['low', 'medium', 'high'] },
  enabled: { type: 'boolean' },
  version: { type: 'integer', minimum: 1 },
  scope: {
    type: 'string',
    enum: ['default', 'project'],
    description: '`default`: rule mặc định toàn server; `project`: rule riêng của project (ghi đè rule mặc định cùng `key`).',
  },
};
const ruleSummaryReq = ['key', 'category', 'severity', 'enabled', 'version', 'scope'];

// --- Tool ghi (M6.16): chỉ chỉnh rule session có sẵn, KHÔNG đổi `match` (logic, regex) -------------------------
const overrideProps = {
  severity: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Mức độ mới của rule.' },
  thresholds: {
    type: 'object',
    minProperties: 1,
    additionalProperties: { type: 'number', minimum: 0 },
    description:
      'Ngưỡng cần đổi (chỉ các khóa rule đã có, ví dụ `min`); khóa không nêu thì giữ nguyên. `min` phải >= 1.',
  },
  message: { type: 'string', minLength: 1, maxLength: 500, description: 'Thông điệp mới (có thể dùng `{{count}}`).' },
  advice: { type: 'string', minLength: 1, maxLength: 1000, description: 'Lời khuyên mới.' },
};
const overrideNote =
  'Chỉ chỉnh rule **session** có sẵn (ngưỡng, mức độ, thông điệp, lời khuyên); không đổi logic `match`, không tạo rule mới, không áp dụng cho rule tuần.';
const changeItem = obj(
  {
    field: { type: 'string', description: 'Trường đổi: `severity`, `message`, `advice` hoặc `thresholds.<khóa>`.' },
    from: { description: 'Giá trị hiện hành.' },
    to: { description: 'Giá trị mới.' },
  },
  ['field', 'from', 'to'],
);
const ruleTestItem = obj(
  {
    name: { type: 'string' },
    expect: { type: 'string', enum: ['triggered', 'clean'] },
    actual: { type: 'string', enum: ['triggered', 'clean'] },
    passed: { type: 'boolean' },
  },
  ['name', 'expect', 'actual', 'passed'],
);
const candidateRule = obj(
  {
    key: { type: 'string' },
    category: { type: 'string' },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    thresholds: { type: 'object', additionalProperties: { type: 'number' } },
    message: { type: 'string' },
    advice: { type: 'string' },
  },
  ['key', 'category', 'severity', 'thresholds', 'message', 'advice'],
);
const sessionNote = clean(S.SessionNote);

const tools = {
  list_projects: {
    description:
      'Liệt kê project người gọi xem được (member: project mình tham gia; leader: mọi project). Dùng `id` ở đây cho các tool khác cần `projectId`.',
    inputSchema: obj({}),
    outputSchema: obj(
      {
        projects: {
          type: 'array',
          items: obj({ id: uuid(), slug: { type: 'string' }, name: { type: 'string' } }, ['id', 'slug', 'name']),
        },
      },
      ['projects'],
    ),
  },
  list_members: {
    description:
      'Liệt kê thành viên của một project (id, tên, vai trò; không có email). Member chỉ thấy chính mình; leader thấy cả project.',
    inputSchema: obj({ projectId: uuid('Project cần xem (từ `list_projects`).') }, ['projectId']),
    outputSchema: obj(
      {
        members: {
          type: 'array',
          items: obj(
            { userId: uuid(), name: { type: 'string' }, role: { type: 'string', enum: ['leader', 'member'] } },
            ['userId', 'name', 'role'],
          ),
        },
      },
      ['members'],
    ),
  },
  get_overview: {
    description:
      'Tổng quan một project theo tuần: điểm 5 nhóm kỹ năng, số session, token, chi phí ước tính, các nhận xét phổ biến nhất. CHỈ LEADER (giống dashboard); member nhận lỗi quyền. Chi phí là ước tính từ bảng giá cố định, không phải hóa đơn.',
    inputSchema: obj(
      {
        projectId: uuid('Project cần xem.'),
        from: dateTime(`Chỉ tính session từ mốc này. ${RANGE_NOTE} Mặc định: 8 tuần gần nhất.`),
        to: dateTime('Chỉ tính session trước mốc này.'),
      },
      ['projectId'],
    ),
    outputSchema: clean(S.ProjectOverview),
  },
  get_member_profile: {
    description:
      'Hồ sơ một thành viên trong một project: điểm theo nhóm kỹ năng so với trung bình team, diễn biến theo tuần, các mẫu lỗi hay gặp kèm lời khuyên và ví dụ (đã che secret). Member chỉ xem được hồ sơ của chính mình; leader xem được mọi thành viên (có ghi audit).',
    inputSchema: obj(
      {
        userId: uuid('Thành viên cần xem (từ `list_members`).'),
        projectId: uuid('Project để tính hồ sơ.'),
        from: dateTime(`${RANGE_NOTE} Mặc định: 2 tuần gần nhất.`),
        to: dateTime('Chỉ tính session trước mốc này.'),
      },
      ['userId', 'projectId'],
    ),
    outputSchema: clean(S.MemberProfile),
  },
  search_sessions: {
    description:
      'Tìm và liệt kê session của một project, mới nhất trước, có phân trang. Lọc theo người, agent, khoảng ngày, từ khóa trong nội dung (full-text, cú pháp kiểu web search). Member chỉ thấy session của mình; leader thấy mọi session. Kết quả gồm `nextCursor` (null khi hết); truyền lại làm `cursor` để lấy trang kế.',
    inputSchema: obj(
      {
        projectId: uuid('Project cần tìm.'),
        userId: uuid('Chỉ session của người này (member chỉ được đặt chính mình).'),
        agent: { type: 'string', enum: S.AgentKind.enum, description: 'Chỉ session của agent này.' },
        from: dateTime('Chỉ session bắt đầu từ mốc này (ISO 8601).'),
        to: dateTime('Chỉ session bắt đầu trước mốc này.'),
        q: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'Từ khóa trong nội dung session (full-text). Nội dung prompt, không đưa thông tin nhạy cảm.',
        },
        includeSubagents: { type: 'boolean', default: false, description: 'Gồm cả session con (subagent).' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Số session mỗi trang.' },
        cursor: { type: 'string', minLength: 1, maxLength: 500, description: '`nextCursor` của trang trước.' },
      },
      ['projectId'],
    ),
    outputSchema: clean(S.SessionPage),
  },
  get_session: {
    description:
      `Chi tiết một session kèm các turn theo thứ tự \`seq\`, phân trang để không tràn ngữ cảnh: mặc định 20 turn, tối đa 50. Mỗi đoạn văn dài bị cắt ở ${TEXT_MAX} ký tự (có cờ \`truncated\`); diff chỉ có đường dẫn và số dòng. Muốn trang kế, đặt \`fromSeq\` bằng \`page.nextFromSeq\`. Xem session của người khác (leader) được ghi audit.`,
    inputSchema: obj(
      {
        sessionId: uuid('Session cần xem (từ `search_sessions`).'),
        fromSeq: { type: 'integer', minimum: 0, default: 0, description: 'Lấy turn có `seq` >= giá trị này.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Số turn tối đa.' },
      },
      ['sessionId'],
    ),
    outputSchema: obj(
      {
        session: sessionDetail,
        turns: { type: 'array', items: mcpTurn },
        page: obj(
          {
            fromSeq: { type: 'integer', minimum: 0 },
            returned: { type: 'integer', minimum: 0 },
            totalTurns: { type: 'integer', minimum: 0 },
            nextFromSeq: {
              type: ['integer', 'null'],
              description: '`seq` để gọi trang kế; null khi đã hết turn.',
            },
          },
          ['fromSeq', 'returned', 'totalTurns', 'nextFromSeq'],
        ),
      },
      ['session', 'turns', 'page'],
    ),
  },
  get_findings: {
    description:
      'Các nhận xét (finding) mà rule chấm điểm đã ghi cho một session: rule nào, mức độ, thông điệp, turn nào và đoạn trích. Danh sách rỗng khi chưa có nhận xét. Member xem session của mình; leader xem mọi session (có ghi audit).',
    inputSchema: obj({ sessionId: uuid('Session cần xem.') }, ['sessionId']),
    outputSchema: clean(S.SessionFindings),
  },
  list_rules: {
    description:
      'Liệt kê rule chấm điểm đang áp dụng (khóa, nhóm, mức độ, bật hay tắt, phiên bản; không gồm định nghĩa, dùng `get_rule`). Bỏ `projectId` thì chỉ rule mặc định; có `projectId` thì rule hiệu lực của project (rule riêng của project ghi đè rule mặc định cùng khóa).',
    inputSchema: obj({ projectId: uuid('Project cần xem rule hiệu lực (từ `list_projects`).') }),
    outputSchema: obj(
      { rules: { type: 'array', items: obj(ruleSummary, ruleSummaryReq) } },
      ['rules'],
    ),
  },
  get_rule: {
    description:
      'Chi tiết một rule: thông tin tóm tắt và định nghĩa JSON khai báo (điều kiện, ngưỡng, thông điệp, lời khuyên). Có `projectId` thì lấy bản hiệu lực của project.',
    inputSchema: obj(
      {
        key: { type: 'string', minLength: 1, maxLength: 100, description: 'Khóa rule (từ `list_rules`).' },
        projectId: uuid('Lấy bản hiệu lực của project này.'),
      },
      ['key'],
    ),
    outputSchema: obj(
      {
        rule: obj(
          {
            ...ruleSummary,
            definition: { type: 'object', additionalProperties: true, description: 'Định nghĩa rule (JSON khai báo).' },
            updatedAt: dateTime('Lần sửa gần nhất.'),
          },
          [...ruleSummaryReq, 'definition', 'updatedAt'],
        ),
      },
      ['rule'],
    ),
  },
  get_my_ai_results: {
    description:
      'Kết quả AI (tóm tắt, đánh giá, giải thích finding...) mà CHÍNH người gọi đã tạo bằng các nút AI trên dashboard cho một đối tượng. Không bao giờ trả kết quả của người khác. Rỗng khi chưa bấm nút AI nào.',
    inputSchema: obj(
      {
        subjectType: { type: 'string', enum: S.AiSubjectType.enum, description: 'Loại đối tượng.' },
        subjectId: uuid('Id của đối tượng (vd. id session).'),
        kind: { type: 'string', enum: S.AiKind.enum, description: 'Chỉ loại kết quả này.' },
        locale: { type: 'string', enum: S.AiLocale.enum, description: 'Chỉ ngôn ngữ này.' },
      },
      ['subjectType', 'subjectId'],
    ),
    outputSchema: obj({ results: { type: 'array', items: aiResult } }, ['results']),
  },
  get_skill_clusters: {
    description:
      'Các cụm prompt lặp lại trong project (Skill Finder S0, heuristic, không gọi LLM): prompt tiêu biểu, số lần lặp, ai gõ, ví dụ gần nhất. Gợi ý để biến việc lặp đi lặp lại thành skill hoặc chỉ dẫn dùng chung. Member chỉ thấy prompt của chính mình; leader thấy cả team và lọc được theo người (có audit). Mặc định 30 ngày gần nhất, tối đa 90 ngày.',
    inputSchema: obj(
      {
        projectId: uuid('Project cần xem (từ `list_projects`).'),
        userId: uuid('Chỉ prompt của người này (member chỉ được đặt chính mình).'),
        from: dateTime('Chỉ prompt từ mốc này (ISO 8601).'),
        to: dateTime('Chỉ prompt trước mốc này.'),
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Số cụm tối đa (lặp nhiều nhất trước).' },
      },
      ['projectId'],
    ),
    outputSchema: clean(S.SkillClusterList),
  },
  // --- Tool ghi cho leader (M6.16) ---
  draft_rule: {
    description:
      'Soạn thử một thay đổi cho rule và kiểm tra, KHÔNG lưu gì. Trả rule sau khi đổi, danh sách thay đổi, và kết quả chạy các `tests` nội tuyến của rule với cấu hình mới. Chỉ LEADER. ' +
      overrideNote,
    inputSchema: obj(
      { key: { type: 'string', minLength: 1, maxLength: 100, description: 'Khóa rule (từ `list_rules`).' }, projectId: uuid('Project áp dụng.'), ...overrideProps },
      ['key', 'projectId'],
    ),
    outputSchema: obj(
      {
        rule: candidateRule,
        changes: { type: 'array', items: changeItem },
        tests: { type: 'array', items: ruleTestItem },
        allPassed: { type: 'boolean', description: 'true khi mọi `tests` nội tuyến vẫn đúng với cấu hình mới.' },
      },
      ['rule', 'changes', 'tests', 'allPassed'],
    ),
  },
  test_rule: {
    description:
      'Chạy thử cấu hình rule mới trên tối đa 50 session gốc gần nhất của project và so với cấu hình hiện hành: có bao nhiêu session sẽ bị gắn nhận xét. KHÔNG lưu gì và KHÔNG trả nội dung turn (chỉ id session, số turn, số lần); muốn đọc thì mở session bằng `get_session` (có audit). Chỉ LEADER. ' +
      overrideNote,
    inputSchema: obj(
      { key: { type: 'string', minLength: 1, maxLength: 100, description: 'Khóa rule.' }, projectId: uuid('Project cần thử.'), ...overrideProps },
      ['key', 'projectId'],
    ),
    outputSchema: obj(
      {
        sessionsEvaluated: { type: 'integer', minimum: 0, description: 'Số session đã chấm thử (chỉ session còn đủ turn).' },
        baselineTriggered: { type: 'integer', minimum: 0, description: 'Số session bị gắn nhận xét với cấu hình hiện hành.' },
        candidateTriggered: { type: 'integer', minimum: 0, description: 'Số session bị gắn nhận xét với cấu hình mới.' },
        samples: {
          type: 'array',
          maxItems: 5,
          description: 'Tối đa 5 session bị gắn nhận xét với cấu hình mới (không có nội dung).',
          items: obj(
            {
              sessionId: uuid(),
              turnSeq: { type: ['integer', 'null'], minimum: 0 },
              count: { type: 'integer', minimum: 0 },
            },
            ['sessionId', 'turnSeq', 'count'],
          ),
        },
      },
      ['sessionsEvaluated', 'baselineTriggered', 'candidateTriggered', 'samples'],
    ),
  },
  save_rule: {
    description:
      'Lưu thay đổi cho rule thành bản riêng của project rồi chấm lại điểm (chạy nền). Từ chối khi các `tests` nội tuyến không còn đúng. Ghi audit giá trị cũ và mới. Chỉ LEADER. ' +
      overrideNote,
    inputSchema: obj(
      { key: { type: 'string', minLength: 1, maxLength: 100, description: 'Khóa rule.' }, projectId: uuid('Project áp dụng.'), ...overrideProps },
      ['key', 'projectId'],
    ),
    outputSchema: obj(
      {
        rule: obj(
          {
            ...ruleSummary,
            definition: { type: 'object', additionalProperties: true, description: 'Định nghĩa rule sau khi lưu.' },
            updatedAt: dateTime('Lần sửa gần nhất.'),
          },
          [...ruleSummaryReq, 'definition', 'updatedAt'],
        ),
        changes: { type: 'array', items: changeItem },
        rescore: { type: 'string', enum: ['queued'], description: 'Đã xếp job chấm lại điểm cho project.' },
      },
      ['rule', 'changes', 'rescore'],
    ),
  },
  set_rule_enabled: {
    description:
      'Bật hoặc tắt một rule (cả rule session lẫn rule tuần) cho một project, rồi chấm lại điểm (chạy nền). Làm đổi điểm của cả team nên chỉ LEADER; ghi audit giá trị cũ và mới, đảo lại được bằng cách gọi lại hoặc trên dashboard.',
    inputSchema: obj(
      {
        key: { type: 'string', minLength: 1, maxLength: 100, description: 'Khóa rule.' },
        projectId: uuid('Project áp dụng.'),
        enabled: { type: 'boolean', description: 'true để bật, false để tắt.' },
      },
      ['key', 'projectId', 'enabled'],
    ),
    outputSchema: obj(
      {
        rule: obj(ruleSummary, ruleSummaryReq),
        previousEnabled: { type: 'boolean', description: 'Trạng thái trước khi đổi.' },
        rescore: { type: 'string', enum: ['queued'], description: 'Đã xếp job chấm lại điểm cho project.' },
      },
      ['rule', 'previousEnabled', 'rescore'],
    ),
  },
  add_session_note: {
    description:
      'Thêm ghi chú của leader vào một session, gắn vào một turn hoặc cả session. Ghi chú hiện trên trang session cho người xem được session đó. Chỉ LEADER; có audit.',
    inputSchema: obj(
      {
        sessionId: uuid('Session cần ghi chú.'),
        turnSeq: { type: ['integer', 'null'], minimum: 0, description: '`seq` của turn; bỏ trống hoặc null là ghi chú chung.' },
        body: { type: 'string', minLength: 1, maxLength: 4000, description: 'Nội dung ghi chú.' },
      },
      ['sessionId', 'body'],
    ),
    outputSchema: obj({ note: sessionNote }, ['note']),
  },
};

for (const [name, def] of Object.entries(tools)) {
  const file = {
    name,
    description: def.description,
    inputSchema: root(def.inputSchema),
    outputSchema: root(def.outputSchema),
  };
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(file, null, 2) + '\n', 'utf8');
  console.log('ghi', name);
}
