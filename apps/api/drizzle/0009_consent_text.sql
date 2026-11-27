INSERT INTO "settings" ("key", "value") VALUES ('consent_text', jsonb_build_object('version', '2026-11-27.3', 'text', $teamlens_consent$TeamLens sẽ thu thập lịch sử làm việc với AI coding agent (Claude Code, Codex) trên máy này và gửi lên server của nhóm.

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
- Tạm dừng thu thập bất cứ lúc nào bằng `tl pause` (`tl resume` để tiếp tục).
- Rút đồng ý bất cứ lúc nào bằng `tl consent revoke`: máy dừng gửi ngay, hàng đợi chưa gửi trên máy bị xóa và server ghi nhận bạn đã rút. Muốn gửi lại thì chạy `tl consent` để đồng ý lại.
- Gỡ TeamLens khỏi máy bằng `tl uninstall` (báo server, gỡ tác vụ tự chạy, xóa cấu hình và token); `tl logout` chỉ thu hồi riêng máy này.
- Dữ liệu đã gửi vẫn nằm trên server theo thời hạn lưu của nhóm. Muốn xóa, nhờ leader xóa toàn bộ dữ liệu của bạn.$teamlens_consent$)) ON CONFLICT ("key") DO NOTHING;
