# Module `prompt-library` — Thư viện prompt mẫu (Mốc 6, Người 3, M6.14, C2)

Contract: `packages/schema/openapi/prompt-library.yaml`. Thiết kế: [docs/AI_PLAN.md](../../../../../docs/AI_PLAN.md) mục 3.2 "C2".

Leader tìm prompt mẫu (heuristic + AI viết lý do), duyệt vài mục vào thư viện; mọi thành viên của project xem thư viện. Đây là **ngoại lệ duy nhất** của nguyên tắc "kết quả AI là riêng của người bấm" và cũng là chỗ duy nhất prompt của người này tới tay người khác, nên mỗi mục phải do leader duyệt.

| File | Nội dung |
| --- | --- |
| `prompt-library.service.ts` | `PromptLibraryService`: xem (`list`), duyệt (`add`), gỡ (`remove`). Che tên, `sessionId`, `turnSeq` theo người xem. |
| `prompt-candidates.service.ts` | `PromptCandidatesService`: chọn ứng viên bằng heuristic, gọi AI qua `LlmService`, lưu kết quả đã lọc. |
| `prompt-candidates-prompts.ts` | Thuần: câu lệnh hệ thống, schema zod đầu ra, `candidateBlocks`, `normalizeCandidates`. Test ở `prompt-candidates-prompts.spec.ts`. |
| `prompt-library.controller.ts` | `GET|POST /api/v1/projects/:projectId/prompt-library`, `DELETE .../:itemId`, `GET|POST .../ai/prompt-candidates`. |

## Chọn ứng viên (không tốn tiền)

Trong khoảng `from`/`to` (mặc định 30 ngày, tối đa 90, dung sai 1 phút), lấy các **session gốc** của project có:

- điểm trung bình các nhóm kỹ năng (`session_scores`) từ **70** trở lên;
- **không có finding mức `high`** (join `findings` với `rules.severity`);
- chưa nằm trong thư viện;
- prompt đầu tiên dài 30 đến 1500 ký tự và không phải prompt rác (`keywordsOf` của Skill Finder phải ra từ khóa).

Xếp theo điểm rồi theo độ mới, lấy tối đa 10 (từ 40 session đầu của truy vấn). Ứng viên luôn là **prompt đầu tiên** của session.

## AI

Key BYO của leader (`LlmService`, kind `prompt_candidates`, subject `project`). Mỗi ứng viên là một khối `untrusted_data` (nhãn chỉ có mã `candidate p1`...). AI trả `picks: [{candidate, title, why}]` và có thể bỏ ứng viên không đáng. Server chỉ giữ mã hợp lệ, không trùng; **id session, người gõ, điểm, nội dung do server điền**, không lấy từ AI. Kết quả đã lọc mới được lưu (`ai_results`, chỉ leader đọc).

- Chưa có key thì 409 `llm_key_missing` **trước** khi đụng dữ liệu (không audit). Không session nào đạt thì 409 `no_candidates` (không gọi AI).
- Leader gửi prompt của người khác cho nhà cung cấp LLM nên ghi audit `prompt_library.candidates` (target là project).
- `subject_user_id` của kết quả là `null` (ứng viên của nhiều người). **Giới hạn đã biết:** khi M5.6 xóa dữ liệu một người, trích đoạn prompt của họ trong kết quả tìm cũ của leader không bị xóa theo; chúng mất khi leader tìm lại (ghi đè) hoặc hết retention.

## Thư viện

- **Duyệt (leader):** `sessionId` phải là session gốc của project. `turnSeq` là `seq` của một prompt người dùng; bỏ trống thì dùng prompt đầu tiên (server luôn lưu `turnSeq` cụ thể). Sai turn thì 400 `invalid_turn`, trùng thì 409 `already_in_library`. Ghi audit `prompt_library.add` (không ghi nội dung prompt).
- **Gỡ (leader):** audit `prompt_library.remove`.
- **Xem:** mọi thành viên của project. Nội dung prompt đọc từ `turns` mỗi lần (đã che secret ở máy thành viên), cắt ở 4000 ký tự, không sao chép sang bảng khác. Mục `hideAuthor` thì thành viên không thấy tên (`author: null`); thành viên **không bao giờ** thấy `sessionId` và `turnSeq` (chỉ leader, để mở session gốc). `note` hiện với mọi người nên đừng ghi tên người vào đó (nút "Thêm vào thư viện" ở web dùng lý do của AI, vốn được dặn không nhắc tên).
- Mục bị xóa theo khi session gốc bị xóa (khóa ngoại `ON DELETE CASCADE`: hết retention hoặc leader xóa dữ liệu).
- Session đã duyệt không còn hiện làm ứng viên.

## Dùng ở đâu

- Web: `apps/web/src/app/[locale]/(dashboard)/projects/[projectId]/prompt-library/` (link "Thư viện prompt" ở sidebar). Leader có thêm khu tìm ứng viên và nút gỡ.
- MCP: tool `get_prompt_library` (`mcp/tools/prompt-library-tools.ts`, cùng quyền và cùng cách ẩn tên).

Test: `test/prompt-library.e2e-spec.ts` (heuristic loại đúng, AI theo mã, audit, ẩn tên, quyền, trùng, turn sai, gỡ, xóa session kéo theo mục, tool MCP khớp `outputSchema`).
