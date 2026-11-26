#!/usr/bin/env python3
"""Rút gọn và che một transcript Claude Code thật thành fixture cho test (task M1.3).

Cách dùng (chạy từ bất kỳ đâu, Python 3.9+, không cần thư viện ngoài):

    python sanitize.py <file-gốc.jsonl> <file-ra.jsonl> [--select 0-40,120-152]
        [--neutral] [--map cũ=mới ...] [--replace-text DÒNG=VĂN_BẢN ...] [--max-text 300]

Script làm gì (chi tiết xem README.md cùng thư mục):

- Chỉ giữ các dòng trong `--select` (chỉ số dòng gốc, đếm từ 0, khoảng đóng).
- Dòng meta (`api-request*`, `attachment`, `session-owner`, ...) rút về khung
  `{type, sessionId, timestamp?}` để test vẫn thấy adapter bỏ qua chúng, nhưng không
  mang theo prompt hệ thống, account id hay nội dung đính kèm.
- Dòng `user`/`assistant` chỉ giữ các khóa adapter cần (danh sách trắng `KEEP_KEYS`),
  `usage` chỉ giữ 4 số token, `thinking` bị xóa nội dung, chữ ký thay bằng chuỗi giả,
  `toolUseResult` chỉ giữ `type`/`filePath`/`structuredPatch`/`content` (đã cắt).
- Mọi chuỗi dài hơn `--max-text` ký tự bị cắt.
- `--neutral`: thay toàn bộ nội dung tự do (prompt, reply, input/output tool, dòng diff)
  bằng chuỗi giữ chỗ — dùng cho log của dự án khác ngoài TeamLens.
- Cuối cùng thay trên toàn bộ dòng JSON: thư mục người dùng Windows (`C:\\Users\\<tên>`
  → `C:\\Users\\dev`, cả dạng `/c/Users/<tên>` và dạng mã hóa `C--Users-<tên>`), tên máy
  (`COMPUTERNAME`), email, các mẫu token (`sk-`, `ghp_`, `gho_`, `github_pat_`, `AKIA`...),
  và các cặp `--map`. Tên người dùng/tên máy lấy từ biến môi trường, không ghi cứng.
- Sau khi ghi, tự kiểm tra lại: còn tên người dùng, tên máy, email hay mẫu token nào thì
  báo lỗi và thoát mã 1.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

KEEP_KEYS = [
    "parentUuid",
    "isSidechain",
    "type",
    "message",
    "isMeta",
    "uuid",
    "timestamp",
    "permissionMode",
    "origin",
    "promptSource",
    "toolUseResult",
    "sourceToolAssistantUUID",
    "interruptedMessageId",
    "userType",
    "entrypoint",
    "cwd",
    "sessionId",
    "version",
    "gitBranch",
]
MESSAGE_KEYS = ["model", "id", "type", "role", "content", "stop_reason"]
USAGE_KEYS = [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
]
# Chuỗi do chính Claude Code sinh ra, không phải nội dung riêng: giữ nguyên khi --neutral.
HARNESS_PREFIXES = (
    "[Request interrupted",
    "The user doesn't want to proceed",
    "<command-name>",
    "<local-command-caveat>",
    "<local-command-stdout>",
)
SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
]
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
EMAIL_ALLOWED = {"noreply@anthropic.com", "dev@example.com"}


def parse_select(spec: str | None) -> set[int] | None:
    if not spec:
        return None
    out: set[int] = set()
    for part in spec.split(","):
        a, _, b = part.partition("-")
        out.update(range(int(a), int(b or a) + 1))
    return out


class Sanitizer:
    def __init__(self, args: argparse.Namespace) -> None:
        self.max_text = args.max_text
        self.neutral = args.neutral
        self.maps = [m.split("=", 1) for m in args.map]
        self.user = os.path.basename(os.environ.get("USERPROFILE") or os.path.expanduser("~"))
        self.host = os.environ.get("COMPUTERNAME") or ""
        self.counter = 0
        self.renamed: dict[str, str] = {}

    def path(self, p: str) -> str:
        """--neutral: đổi tên file (giữ thư mục và phần mở rộng) để không lộ tên file của dự án khác."""
        if not self.neutral:
            return p
        cut = max(p.rfind("\\"), p.rfind("/"))
        head, name = p[: cut + 1], p[cut + 1 :]
        ext = name[name.rfind(".") :] if "." in name else ""
        if name not in self.renamed:
            self.renamed[name] = f"file{len(self.renamed) + 1}{ext}"
        return head + self.renamed[name]

    # ---- nội dung tự do -------------------------------------------------------

    def cut(self, s: str) -> str:
        if len(s) <= self.max_text:
            return s
        return s[: self.max_text] + " …[cắt khi làm fixture]"

    def free_text(self, s: str, label: str) -> str:
        if self.neutral and not s.lstrip().startswith(HARNESS_PREFIXES):
            self.counter += 1
            return f"({label} đã thay khi làm fixture #{self.counter})"
        return self.cut(s)

    def tool_input(self, value):
        if isinstance(value, dict):
            return {k: (self.path(v) if k in ("file_path", "path") and isinstance(v, str) else self.tool_input(v))
                    for k, v in value.items()}
        if isinstance(value, list):
            return [self.tool_input(v) for v in value[:5]]
        if isinstance(value, str):
            return self.free_text(value, "input")
        return value

    def block(self, b: dict) -> dict:
        t = b.get("type")
        b = dict(b)
        b.pop("caller", None)
        if t == "text":
            b["text"] = self.free_text(b.get("text", ""), "văn bản")
        elif t == "thinking":
            b["thinking"] = ""
            b["signature"] = "SIG_FIXTURE"
        elif t == "tool_use":
            b["input"] = self.tool_input(b.get("input", {}))
        elif t == "tool_result":
            c = b.get("content")
            if isinstance(c, str):
                b["content"] = self.free_text(c, "output")
            elif isinstance(c, list):
                b["content"] = [self.block(x) for x in c[:3]]
        elif t == "image":
            b["source"] = {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}
        return b

    def patch_lines(self, lines: list[str]) -> list[str]:
        kept = lines[:12]
        if self.neutral:
            return [ln[:1] + " (dòng đã thay)" for ln in kept]
        return [self.cut(ln) for ln in kept]

    def tool_use_result(self, r):
        if not isinstance(r, dict):
            return None
        out = {}
        if "type" in r:
            out["type"] = r["type"]
        if isinstance(r.get("filePath"), str):
            out["filePath"] = self.path(r["filePath"])
        if isinstance(r.get("structuredPatch"), list):
            out["structuredPatch"] = [
                {**{k: h[k] for k in ("oldStart", "oldLines", "newStart", "newLines") if k in h},
                 "lines": self.patch_lines(h.get("lines", []))}
                for h in r["structuredPatch"][:3]
            ]
        if r.get("type") == "create" and isinstance(r.get("content"), str):
            lines = r["content"].split("\n")[:12]
            if self.neutral:
                out["content"] = "\n".join("(dòng đã thay)" for _ in lines)
            else:
                out["content"] = "\n".join(self.cut(ln) for ln in lines)
        return out or None

    # ---- từng dòng ------------------------------------------------------------

    def line(self, o: dict) -> dict:
        t = o.get("type")
        if t not in ("user", "assistant"):
            stub = {"type": t}
            for k in ("sessionId", "timestamp", "permissionMode", "subtype"):
                if k in o:
                    stub[k] = o[k]
            return stub
        out = {k: o[k] for k in KEEP_KEYS if k in o}
        msg = o.get("message", {})
        m = {k: msg[k] for k in MESSAGE_KEYS if k in msg}
        if isinstance(msg.get("usage"), dict):
            m["usage"] = {k: msg["usage"][k] for k in USAGE_KEYS if k in msg["usage"]}
        c = msg.get("content")
        if isinstance(c, str):
            m["content"] = self.free_text(c, "văn bản")
        elif isinstance(c, list):
            m["content"] = [self.block(b) for b in c]
        out["message"] = m
        if "toolUseResult" in out:
            r = self.tool_use_result(out["toolUseResult"])
            if r is None:
                del out["toolUseResult"]
            else:
                out["toolUseResult"] = r
        if isinstance(out.get("origin"), dict):
            out["origin"] = {"kind": out["origin"].get("kind")}
        return out

    # ---- thay toàn cục --------------------------------------------------------

    def scrub(self, s: str) -> str:
        u = re.escape(self.user)
        s = re.sub(rf"([A-Za-z]:(?:\\\\|\\|/)Users(?:\\\\|\\|/)){u}", r"\1dev", s, flags=re.I)
        s = re.sub(rf"(/[a-z]/Users/){u}", r"\1dev", s, flags=re.I)
        s = re.sub(rf"([A-Za-z]--Users-){u}", r"\1dev", s, flags=re.I)
        for old, new in self.maps:
            s = s.replace(old, new)
        if self.host:
            s = re.sub(re.escape(self.host), "DEV-PC", s, flags=re.I)
        s = EMAIL.sub(lambda m: m.group(0) if m.group(0) in EMAIL_ALLOWED else "dev@example.com", s)
        for p in SECRET_PATTERNS:
            s = p.sub("[REDACTED]", s)
        return s

    def verify(self, text: str) -> list[str]:
        problems = []
        if re.search(re.escape(self.user), text, re.I):
            problems.append(f"còn tên người dùng '{self.user}'")
        if self.host and re.search(re.escape(self.host), text, re.I):
            problems.append("còn tên máy")
        for m in EMAIL.finditer(text):
            if m.group(0) not in EMAIL_ALLOWED:
                problems.append(f"còn email {m.group(0)}")
        for p in SECRET_PATTERNS:
            if p.search(text):
                problems.append(f"còn mẫu token {p.pattern}")
        return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--select", help="khoảng dòng gốc cần giữ, vd. 0-40,120-152")
    ap.add_argument("--neutral", action="store_true", help="thay mọi nội dung tự do bằng chuỗi giữ chỗ")
    ap.add_argument("--map", action="append", default=[], help="thay chuỗi CŨ=MỚI trên toàn dòng")
    ap.add_argument("--replace-text", action="append", default=[],
                    help="DÒNG=VĂN_BẢN: thay nội dung prompt của dòng gốc DÒNG")
    ap.add_argument("--max-text", type=int, default=300)
    args = ap.parse_args()

    select = parse_select(args.select)
    replace = {int(k): v for k, v in (r.split("=", 1) for r in args.replace_text)}
    san = Sanitizer(args)
    out_lines = []
    with open(args.src, encoding="utf-8") as f:
        for i, raw in enumerate(f):
            if select is not None and i not in select:
                continue
            try:
                o = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if i in replace:
                o.setdefault("message", {})["content"] = replace[i]
            o = san.line(o)
            if i in replace:
                o["message"]["content"] = replace[i]
            out_lines.append(san.scrub(json.dumps(o, ensure_ascii=False, separators=(",", ":"))))
    text = "\n".join(out_lines) + "\n"
    problems = san.verify(text)
    if problems:
        print("KHÔNG ghi file, còn dữ liệu cần che:", *problems, sep="\n  ", file=sys.stderr)
        return 1
    with open(args.dst, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"đã ghi {len(out_lines)} dòng vào {args.dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
