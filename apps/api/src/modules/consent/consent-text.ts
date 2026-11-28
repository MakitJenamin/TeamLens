/**
 * Văn bản đồng ý hiển thị trên màn hình `tl join` và trang `/i/<mã>` (SPEC 4.3).
 * Chỉ nhắc lệnh CLI đã có thật (`tl pause`, `tl consent`, `tl consent revoke`, `tl uninstall`,
 * `tl logout`); thêm lệnh mới thì thêm vào văn bản và tăng phiên bản khi phát hành.
 * Chỉ dùng để khởi tạo migration và test; runtime đọc bảng `settings` qua ConsentTextService.
 *
 * Đổi nội dung thì phải đổi `CONSENT_TEXT_VERSION`: thiết bị đồng ý bản cũ sẽ bị ingest
 * trả 403 `consent_required` cho tới khi đồng ý lại.
 */
export const CONSENT_TEXT_VERSION = '2026-11-28.1';

export const CONSENT_TEXT = `Gửi lên server của nhóm (từ Claude Code, Codex trên máy này):
- Toàn bộ prompt, câu trả lời của agent, lệnh và tool agent gọi, diff code.
- Output của tool, đã cắt ngắn.
- Agent, model, số token, thời gian, repo, nhánh git.

Trước khi gửi:
- Secret (API key, token, mật khẩu, khóa bí mật, chuỗi kết nối...) bị che.
- Thư mục home trong đường dẫn được rút gọn thành ~. Tên thư mục và file bên dưới vẫn được gửi.

Phạm vi:
- Chỉ gửi session trong repo đã đăng ký của project. Session ở repo khác không rời máy, kể cả metadata.
- Bạn chỉ xem được dữ liệu của mình. Leader xem được dữ liệu của mọi thành viên.

Quyền của bạn, bất cứ lúc nào:
- Tạm dừng: \`tl pause\`. Tiếp tục: \`tl resume\`.
- Rút đồng ý: \`tl consent revoke\`. Máy dừng gửi ngay, server được báo, hàng đợi chưa gửi bị xóa. Đồng ý lại: \`tl consent\`.
- Gỡ TeamLens: \`tl uninstall\`. Báo server, thu hồi máy này, xóa cấu hình và token trên máy. Chỉ thu hồi máy này: \`tl logout\`.
- Dữ liệu đã gửi vẫn ở trên server theo thời hạn lưu. Muốn xóa toàn bộ dữ liệu của bạn, nhờ leader.`;
