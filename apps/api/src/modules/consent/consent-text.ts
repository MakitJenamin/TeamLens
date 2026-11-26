/**
 * Văn bản đồng ý hiển thị trên màn hình `tl join` / `tl consent` (SPEC 4.3).
 * Nguồn duy nhất trong API; sau này có thể chuyển sang bảng `settings`.
 *
 * Đổi nội dung thì phải đổi `CONSENT_TEXT_VERSION`: thiết bị đồng ý bản cũ sẽ bị ingest
 * trả 403 `consent_required` cho tới khi đồng ý lại.
 */
export const CONSENT_TEXT_VERSION = '2026-11-27';

export const CONSENT_TEXT = `TeamLens sẽ thu thập lịch sử làm việc với AI coding agent (Claude Code, Codex) trên máy này và gửi lên server của nhóm.

Dữ liệu được gửi:
- Toàn bộ prompt bạn gõ, câu trả lời của agent, các lệnh/tool agent gọi và diff code agent tạo ra.
- Output của tool bị cắt ngắn trước khi gửi.
- Thông tin đi kèm: tên agent, model, số token, thời gian, repo và nhánh git.

Dữ liệu được che trước khi rời máy:
- Secret (API key, token, mật khẩu, khóa bí mật, chuỗi kết nối...) được thay bằng ký hiệu che.
- Đường dẫn cá nhân trên máy được rút gọn.

Phạm vi:
- Chỉ session trong các repo đã đăng ký của project mới được gửi. Session ở repo khác không bao giờ rời máy, kể cả thông tin mô tả.
- Bạn chỉ xem được dữ liệu của chính mình; leader của nhóm xem được dữ liệu của mọi thành viên.

Quyền của bạn:
- Bạn có thể tạm dừng (\`tl pause\`) hoặc rút đồng ý bất cứ lúc nào (\`tl consent\`); khi rút, máy này dừng gửi ngay.
- Bạn có thể gỡ TeamLens khỏi máy bằng \`tl uninstall\`.`;
