# Module `skills` — Skill Finder (Mốc 6, Người 3)

Contract: `packages/schema/openapi/skills.yaml`. Thiết kế: [docs/AI_PLAN.md](../../../../../docs/AI_PLAN.md) mục 3.2.

| Mốc | Việc | Trạng thái |
| --- | --- | --- |
| M6.11 | S0: gom cụm prompt lặp lại (heuristic, không gọi LLM) + trang Skill Finder + tool MCP `get_skill_clusters` | xong |
| M6.12 | S1 triage cụm (AI), S2 sinh `SKILL.md` + nút ở web + prompt MCP `find-skills` | xong |
| M6.13 | S3 catalog nhiều nguồn cấu hình được, AI chọn skill có sẵn, nút và quản lý nguồn ở web | xong |

| File | Nội dung |
| --- | --- |
| `prompt-clusterer.ts` | Thuần, không đọc DB, không log: `keywordsOf`, `fingerprintOf`, `clusterPrompts`. Test ở `prompt-clusterer.spec.ts`. |
| `skills.service.ts` | `SkillsService.list`: quyền, khoảng thời gian, truy vấn prompt, gom cụm, tên người, audit. `clusterIdOf`. |
| `skills.controller.ts` | `GET /api/v1/projects/:projectId/skill-clusters` (`userId`, `from`, `to`, `limit`). |
| `skills-ai.service.ts`, `skills-ai.controller.ts` | Nút AI (M6.12): `GET|POST /api/v1/projects/:projectId/skill-clusters/:clusterId/ai[/triage|/skill]`. Dùng `LlmService` với key BYO của người bấm. |
| `skill-catalog.service.ts`, `skill-catalog.controller.ts` | Nguồn catalog (M6.13): `GET|POST /api/v1/skill-catalog-sources`, `PATCH|DELETE .../{sourceId}`; đọc catalog từ GitHub, bộ nhớ đệm 6 giờ. |
| `skills-catalog-ai.service.ts`, `skills-catalog-ai.controller.ts` | S3: `GET|POST /api/v1/projects/:projectId/ai/catalog-picks`. |
| `catalog-github.ts`, `skill-md.ts`, `catalog-shortlist.ts`, `skills-catalog-prompts.ts` | Thuần, không đọc DB hay mạng: kiểm URL GitHub, đọc front matter `SKILL.md`, lọc sơ ứng viên, prompt và chuẩn hóa gợi ý. Test ở `catalog.spec.ts`. |
| `skills-ai-prompts.ts` | Câu lệnh hệ thống, schema zod đầu ra, `clusterBlocks` (khối dữ liệu không đáng tin), chuẩn hóa (`slugify`, `assembleSkillMarkdown`). Test ở `skills-ai-prompts.spec.ts`. |

## Cách gom cụm (S0)

Chỉ dùng prompt của **session gốc** (prompt trong session con do agent viết, SPEC 9.1). Mỗi prompt:

1. Bỏ nếu rác (`ok`, `tiếp tục`, `continue`...), dưới 15 hoặc trên 2000 ký tự.
2. Chuẩn hóa **NFC** (giữ chữ có dấu; bản gốc của ai-engineering-coach xóa mọi ký tự ngoài `a-z` nên làm hỏng tiếng Việt).
3. Bỏ khối code, code nội dòng, URL, đường dẫn, tên file, chuỗi trong ngoặc kép; tách từ theo `\p{L}`; bỏ từ có chữ số, từ một ký tự và từ dừng tiếng Việt và tiếng Anh. Còn dưới 3 từ khóa thì bỏ.
4. **Dấu vân tay** = 4 từ khóa đầu tiên sau khi sắp xếp theo mã ký tự. Prompt cùng dấu vân tay vào một cụm; cụm cần từ 3 lần lặp. Tối đa 200 cụm.

**Giới hạn đã biết:** dấu vân tay chỉ bắt được các prompt chia sẻ cùng những từ khóa đứng đầu bảng chữ cái. Hai cách nói cùng một việc nhưng khác từ thì không vào cùng cụm, và thêm một từ khóa mới ở đầu bảng chữ cái làm đổi dấu vân tay. Đây là gợi ý gần đúng; bước lọc bằng AI (S1) làm sau.

## Quy tắc

- **Quyền:** leader thấy cả team (lọc theo `userId`); member chỉ thấy prompt của mình (đặt `userId` người khác trả 403). Leader xem dữ liệu của người khác ghi audit `skill_clusters.view` (target là project); xem của chính mình thì không.
- **Khoảng thời gian:** mặc định 30 ngày, tối đa 90 (dung sai 1 phút để `from = bây giờ - 90 ngày` với `to` mặc định vẫn hợp lệ). Tối đa 20000 prompt được xét (lấy mới nhất, `stats.truncated`). Chỉ có prompt còn được lưu (retention).
- **Mã cụm** (`id`): UUID sinh từ project và dấu vân tay, **không** phụ thuộc bộ lọc người hay khoảng thời gian; M6.12 dùng làm `subjectId` (`skill_cluster`) cho kết quả AI.
- **Đoạn trích** (`excerpt`, tối đa 160 ký tự) và `label` (tối đa 200) lấy từ nội dung prompt đã che secret ở máy thành viên; cắt theo ký tự Unicode, không chẻ cặp surrogate.
- Nội dung prompt không bao giờ được log.

## Dùng ở đâu

- Web: `apps/web/src/app/[locale]/(dashboard)/projects/[projectId]/skills/` (link "Skill Finder" ở sidebar).
- MCP: tool `get_skill_clusters` (`mcp/tools/skill-tools.ts`, cùng quyền và audit).

## Nút AI (S1, S2)

- Server **dựng lại cụm** từ prompt người bấm xem được (cùng `SkillsService.collect` với danh sách), nên client chỉ gửi `locale`, `userId`, `from`, `to`; không gửi nội dung prompt. Cụm không còn trong khoảng thời gian thì 404 `cluster_not_found`.
- Gửi cho LLM tối đa 8 prompt mới nhất của cụm (mỗi prompt cắt 600 ký tự) trong các khối `untrusted_data`. Member không bao giờ gửi prompt của người khác; leader gửi prompt của người khác thì ghi audit `skill_clusters.ai`.
- Chưa có key thì 409 `llm_key_missing` **trước** khi đụng dữ liệu (không gọi LLM, không audit).
- Kết quả **chuẩn hóa rồi mới lưu** vào `ai_results` (`skill_triage`, `skill_content`, subject `skill_cluster`): tên kebab-case, S2 có thêm `markdown` do server ghép (front matter `name` và `description` nháy kép một dòng). Nhờ vậy tool MCP `get_my_ai_results` trả đúng nội dung web thấy. Server không ghi file nào; người dùng sao chép hoặc tải `SKILL.md` ở web.
- Kết quả chỉ người bấm đọc được, bấm lại thì ghi đè.

## Catalog và gợi ý skill có sẵn (S3)

- **Nguồn** (`skill_catalog_sources`): toàn server, mọi người xem, chỉ leader thêm, bật, tắt, xóa (ghi audit `skill_catalog.add|update|remove`, `details.url`). Hai nguồn mặc định `anthropics/skills` và `github/awesome-copilot` được thêm **đúng một lần** ở lần đọc danh sách đầu tiên (cờ `skill_catalog_seeded` trong `settings`); leader xóa rồi thì không tự thêm lại. Không cần migration.
- **Chỉ nhận repo GitHub công khai** `https://github.com/{owner}/{repo}` (chuẩn hóa bỏ `.git`, `/`, `/tree/<nhánh>`). Server chỉ gọi `api.github.com` (một request lấy cây thư mục, nhánh mặc định `HEAD`) và `raw.githubusercontent.com` (đầu mỗi `SKILL.md`, header `Range` 2 KB), với `owner/repo` đã kiểm bằng regex, nên người dùng không điều khiển được host đích (không SSRF). Không dùng token GitHub: giới hạn 60 request mỗi giờ của API chỉ bị tính một lần mỗi nguồn mỗi 6 giờ.
- **Catalog** = các `SKILL.md` có `description` trong front matter, tối đa 600 mỗi nguồn (theo thứ tự đường dẫn), đọc song song 8 file. Lưu trong bộ nhớ tiến trình 6 giờ (mất khi khởi động lại), lỗi không được nhớ. Một nguồn lỗi thì bỏ qua; không còn gì đọc được thì `502 catalog_unavailable`. Thật đo được: 320 skill từ hai nguồn mặc định trong khoảng 2 giây, lần sau 4 ms.
- **Chọn skill:** server dựng cụm của người bấm (8 cụm lặp nhiều nhất, như S1), xếp catalog theo độ trùng từ khóa, lấy 100 ứng viên rồi gửi LLM (hai khối `untrusted_data`: `workflows` và `catalog`). Catalog là chữ của bên thứ ba nên cũng bị coi là không đáng tin. AI chỉ trả **mã ứng viên** (`s12`) kèm lý do; server bỏ mã không có, mã trùng, tối đa 5, và tự điền tên, mô tả, link từ catalog. Kết quả đã lọc mới được lưu vào `ai_results` (kind `catalog_picks`, subject `project`, subjectId là `projectId`).
- **Quyền và audit** như S1: member chỉ dùng prompt của mình; leader dùng prompt của người khác thì ghi `skill_clusters.ai`. Chưa có key thì 409 `llm_key_missing` **trước** khi gọi GitHub hay đụng prompt; chưa có cụm lặp nào thì 409 `no_clusters` (không gọi GitHub, không gọi LLM); catalog lỗi thì 502 và không audit.
- **Giới hạn đã biết:** bước xếp sơ chỉ so từ khóa nên hầu như không giúp khi prompt tiếng Việt còn catalog tiếng Anh (điểm 0 không bị loại, lấy 100 mục đầu theo thứ tự); với catalog lớn hơn 100 skill thì AI chỉ thấy 100 mục đó. Muốn tốt hơn cần dịch từ khóa hoặc tìm kiếm ngữ nghĩa. Gợi ý chỉ là tên và link: không có gì được cài tự động, người dùng phải tự đọc `SKILL.md` (mã bên thứ ba).

Test: `skills-catalog.e2e-spec.ts` (nguồn, GitHub giả, quyền, dữ liệu gửi đi, bộ nhớ đệm, audit, lỗi, injection). `skills-ai.e2e-spec.ts` (quyền, dữ liệu gửi đi, audit, ghi đè, lỗi, injection, tool MCP). `skills.e2e-spec.ts` (`test/`): quyền, bộ lọc, khoảng thời gian, session con và lượt trả lời bị bỏ qua, audit, tool MCP khớp `outputSchema`.
