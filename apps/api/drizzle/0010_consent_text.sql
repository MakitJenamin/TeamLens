INSERT INTO "settings" ("key", "value") VALUES ('consent_text', jsonb_build_object('version', '2026-11-28.1', 'text', $teamlens_consent$Gửi lên server của nhóm (từ Claude Code, Codex trên máy này):
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
- Tạm dừng: `tl pause`. Tiếp tục: `tl resume`.
- Rút đồng ý: `tl consent revoke`. Máy dừng gửi ngay, server được báo, hàng đợi chưa gửi bị xóa. Đồng ý lại: `tl consent`.
- Gỡ TeamLens: `tl uninstall`. Báo server, thu hồi máy này, xóa cấu hình và token trên máy. Chỉ thu hồi máy này: `tl logout`.
- Dữ liệu đã gửi vẫn ở trên server theo thời hạn lưu. Muốn xóa toàn bộ dữ liệu của bạn, nhờ leader.$teamlens_consent$)) ON CONFLICT ("key") DO NOTHING;
