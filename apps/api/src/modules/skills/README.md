# Module `skills` — Skill Finder (Mốc 6, Người 3)

Contract: `packages/schema/openapi/skills.yaml`. Thiết kế: [docs/AI_PLAN.md](../../../../../docs/AI_PLAN.md) mục 3.2.

| Mốc | Việc | Trạng thái |
| --- | --- | --- |
| M6.11 | S0: gom cụm prompt lặp lại (heuristic, không gọi LLM) + trang Skill Finder + tool MCP `get_skill_clusters` | xong |
| M6.12 | S1 triage cụm (AI), S2 sinh `SKILL.md` | chưa làm |
| M6.13 | S3 catalog nhiều nguồn, chọn skill | chưa làm |

| File | Nội dung |
| --- | --- |
| `prompt-clusterer.ts` | Thuần, không đọc DB, không log: `keywordsOf`, `fingerprintOf`, `clusterPrompts`. Test ở `prompt-clusterer.spec.ts`. |
| `skills.service.ts` | `SkillsService.list`: quyền, khoảng thời gian, truy vấn prompt, gom cụm, tên người, audit. `clusterIdOf`. |
| `skills.controller.ts` | `GET /api/v1/projects/:projectId/skill-clusters` (`userId`, `from`, `to`, `limit`). |

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

Test: `skills.e2e-spec.ts` (`test/`): quyền, bộ lọc, khoảng thời gian, session con và lượt trả lời bị bỏ qua, audit, tool MCP khớp `outputSchema`.
