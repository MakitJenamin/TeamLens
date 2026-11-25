# Fixtures log mẫu

Log mẫu của từng agent, dùng cho snapshot test của adapter. Mỗi agent một thư mục con,
đặt tên theo phiên bản agent đã sinh ra log, ví dụ:

```
fixtures/
├── claude_code/2.1.4/<tên-tình-huống>.jsonl
└── codex/0.50.0/<tên-tình-huống>.jsonl
```

**Bắt buộc trước khi commit** (AGENTS.md gốc, mục 5):

- Che hết secret (API key, token, mật khẩu, connection string...).
- Thay đường dẫn cá nhân (`C:\Users\<tên>`), tên máy, email thật bằng giá trị giả.
- Không đưa log thật chưa che vào repo, kể cả tạm thời.

Fixtures Claude Code thuộc task M1.3, Codex thuộc task M2.5.
