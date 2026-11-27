/**
 * Văn bản đồng ý hiển thị trên màn hình `tl join` và trang `/i/<mã>` (SPEC 4.3).
 * Chỉ nhắc lệnh CLI đã có thật (`tl pause`, `tl consent`, `tl consent revoke`, `tl uninstall`,
 * `tl logout`); thêm lệnh mới thì thêm vào văn bản và tăng phiên bản khi phát hành.
 * Nguồn duy nhất trong API; sau này có thể chuyển sang bảng `settings`.
 *
 * Đổi nội dung thì phải đổi `CONSENT_TEXT_VERSION`: thiết bị đồng ý bản cũ sẽ bị ingest
 * trả 403 `consent_required` cho tới khi đồng ý lại.
 */
export const CONSENT_TEXT_VERSION = '2026-11-28.1';

export const CONSENT_TEXT = `Gửi lên server của nhóm (từ Claude Code, Codex trên máy này):
- Prompt, câu trả lời của agent, lệnh và tool agent gọi, diff code.
- Output của tool, đã cắt ngắn.
- Agent, model, số token, thời gian, repo, nhánh git.

Che trước khi gửi:
- Secret (API key, token, mật khẩu, chuỗi kết nối...).
- Đường dẫn cá nhân trên máy.

Phạm vi:
- Chỉ gửi session trong repo đã đăng ký của project. Session ở repo khác không rời máy, kể cả metadata.
- Bạn xem dữ liệu của mình. Leader xem dữ liệu của mọi thành viên.

Quyền của bạn:
- Tạm dừng: \`tl pause\`. Tiếp tục: \`tl resume\`.
- Rút đồng ý: \`tl consent revoke\`. Hàng đợi chưa gửi bị xóa. Đồng ý lại: \`tl consent\`.
- Gỡ khỏi máy: \`tl uninstall\`. Chỉ thu hồi máy này: \`tl logout\`.
- Dữ liệu đã gửi vẫn ở trên server theo thời hạn lưu. Muốn xóa, nhờ leader.`;
