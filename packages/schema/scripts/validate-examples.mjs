// Kiểm tra mọi file JSON trong examples/ khớp session.v1.schema.json (JSON Schema draft 2020-12).
// Kèm vài ca "phải bị từ chối" để chắc schema đủ chặt (trường lạ, đường dẫn tuyệt đối...).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(root, 'session.v1.schema.json'), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
addFormats(ajv);
const validate = ajv.compile(schema);

let failed = 0;

// 1. Mọi file mẫu phải hợp lệ.
const examplesDir = join(root, 'examples');
const files = readdirSync(examplesDir).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
  console.error('✗ Không có file mẫu nào trong examples/');
  process.exit(1);
}
const examples = {};
for (const file of files) {
  const data = JSON.parse(readFileSync(join(examplesDir, file), 'utf8'));
  examples[file] = data;
  if (validate(data)) {
    console.log(`✓ examples/${file}`);
  } else {
    failed++;
    console.error(`✗ examples/${file}`);
    for (const err of validate.errors ?? []) {
      console.error(`    ${err.instancePath || '/'} ${err.message} ${JSON.stringify(err.params)}`);
    }
  }
}

// 2. Các biến thể sai phải bị từ chối.
const base = examples['claude-code-simple.json'];
const mutate = (fn) => {
  const copy = structuredClone(base);
  fn(copy);
  return copy;
};
const firstSession = (b) => b.sessions[0].session;
const firstTurn = (b) => b.sessions[0].turns[0];

const negatives = [
  ['schema_version khác 1', (b) => (b.schema_version = 2)],
  ['batch_id không phải UUID', (b) => (b.batch_id = 'abc')],
  ['batch rỗng', (b) => (b.sessions = [])],
  ['trường lạ ở gốc batch', (b) => (b.extra = true)],
  ['trường lạ trong session', (b) => (firstSession(b).cwd = 'C:\\Users\\a\\repo')],
  ['cwd_relative tuyệt đối (Windows)', (b) => (firstSession(b).cwd_relative = 'C:\\Users\\a\\repo')],
  ['cwd_relative tuyệt đối (POSIX)', (b) => (firstSession(b).cwd_relative = '/home/a/repo')],
  ['repo_remote còn scheme', (b) => (firstSession(b).repo_remote = 'https://github.com/acme/shop-api')],
  ['repo_remote chữ hoa', (b) => (firstSession(b).repo_remote = 'github.com/Acme/shop-api')],
  ['agent không hỗ trợ', (b) => (firstSession(b).agent = 'cursor')],
  ['thiếu parent_source_id', (b) => delete firstSession(b).parent_source_id],
  ['role sai', (b) => (firstTurn(b).role = 'bot')],
  ['kind sai', (b) => (firstTurn(b).kind = 'thinking')],
  ['seq âm', (b) => (firstTurn(b).seq = -1)],
  ['ts không phải date-time', (b) => (firstTurn(b).ts = 'hôm qua')],
  ['trường lạ trong turn', (b) => (firstTurn(b).raw = {})],
  ['trường lạ trong tool', (b) => (b.sessions[0].turns[2].tool.extra = 1)],
  ['trường lạ trong diff', (b) => (b.sessions[0].turns[2].diff.lang = 'ts')],
  ['diff path tuyệt đối', (b) => (b.sessions[0].turns[2].diff.path = 'D:\\code\\a.ts')],
  ['usage âm', (b) => (b.sessions[0].turns[1].usage.input = -5)],
  ['output thiếu truncated', (b) => delete b.sessions[0].turns[4].output.truncated],
  ['permission_mode không hỗ trợ', (b) => (firstSession(b).permission_mode = 'yolo')],
  ['permission_mode null', (b) => (firstSession(b).permission_mode = null)],
  ['instruction_files không phải mảng', (b) => (firstSession(b).instruction_files = 'CLAUDE.md')],
  ['instruction_files path tuyệt đối (Windows)', (b) => (firstSession(b).instruction_files[0].path = 'C:\\repo\\CLAUDE.md')],
  ['instruction_files path tuyệt đối (POSIX)', (b) => (firstSession(b).instruction_files[0].path = '/home/a/repo/CLAUDE.md')],
  ['instruction_files path rỗng', (b) => (firstSession(b).instruction_files[0].path = '')],
  ['instruction_files thiếu bytes', (b) => delete firstSession(b).instruction_files[0].bytes],
  ['instruction_files bytes âm', (b) => (firstSession(b).instruction_files[0].bytes = -1)],
  ['instruction_files kèm nội dung', (b) => (firstSession(b).instruction_files[0].content = '# Hướng dẫn')],
  ['interrupted không phải boolean', (b) => (b.sessions[0].turns[1].interrupted = 'yes')],
  ['reasoning_effort không phải chuỗi', (b) => (b.sessions[0].turns[1].reasoning_effort = 3)],
];
for (const [name, fn] of negatives) {
  if (validate(mutate(fn))) {
    failed++;
    console.error(`✗ Phải bị từ chối nhưng lại hợp lệ: ${name}`);
  } else {
    console.log(`✓ Từ chối đúng: ${name}`);
  }
}

// 3. tool.input cho phép trường tùy ý.
const freeInput = mutate((b) => {
  b.sessions[0].turns[2].tool.input = { anything: { nested: [1, 'a', null] }, more: true };
});
if (validate(freeInput)) {
  console.log('✓ tool.input chấp nhận trường tùy ý');
} else {
  failed++;
  console.error('✗ tool.input phải chấp nhận trường tùy ý');
}

// 4. JSON Schema của tool MCP (mcp/*.json) phải đủ trường và compile được.
const mcpDir = join(root, 'mcp');
const mcpFiles = readdirSync(mcpDir).filter((f) => f.endsWith('.json')).sort();
for (const file of mcpFiles) {
  const tool = JSON.parse(readFileSync(join(mcpDir, file), 'utf8'));
  const problems = [];
  if (`${tool.name}.json` !== file) problems.push('`name` phải trùng tên file');
  if (typeof tool.description !== 'string' || tool.description.length === 0) problems.push('thiếu `description`');
  for (const key of ['inputSchema', 'outputSchema']) {
    if (tool[key]?.type !== 'object') {
      problems.push(`\`${key}\` phải là schema kiểu object`);
      continue;
    }
    try {
      ajv.compile(tool[key]);
    } catch (err) {
      problems.push(`\`${key}\` không compile được: ${err.message}`);
    }
  }
  if (problems.length > 0) {
    failed++;
    console.error(`✗ mcp/${file}: ${problems.join('; ')}`);
  } else {
    console.log(`✓ mcp/${file}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} kiểm tra thất bại.`);
  process.exit(1);
}
console.log(`\nTất cả ${files.length} file mẫu hợp lệ, ${negatives.length + 1} ca kiểm tra độ chặt đều đúng.`);
