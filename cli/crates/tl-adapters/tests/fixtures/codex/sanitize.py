#!/usr/bin/env python3
"""Rút gọn và che một rollout Codex thật thành fixture cho test (task M2.5).

Cách dùng (Python 3.9+, không cần thư viện ngoài):

    python sanitize.py <rollout-gốc.jsonl> <file-ra.jsonl> [--select 0-16,226-262]
        [--map cũ=mới ...] [--max-text 300]

Mọi nội dung tự do (prompt, câu trả lời, lệnh, output tool, dòng diff, input patch) đều
bị thay bằng chuỗi giữ chỗ `(… đã thay khi làm fixture #n)`, vì log nguồn là các dự án
cá nhân ngoài TeamLens. Chỉ giữ **cấu trúc** mà adapter dựa vào (chi tiết ở README.md):

- `session_meta`: id, forked_from_id, cwd, cli_version, originator, source, git.branch
  (bỏ `base_instructions`, `dynamic_tools`, commit, URL repo...).
- `turn_context`: turn_id, cwd, model, effort, approval_policy, sandbox_policy.type,
  collaboration_mode (mode + model + reasoning_effort) — bỏ instructions, permission_profile.
- `response_item`: loại item, role, call_id, tên tool; key của `arguments` (giá trị bị
  thay); output giữ 3 dòng đầu `Exit code` / `Wall time` / `Output:`; patch giữ dòng
  `*** ...` (tên file bị đổi), dấu `+`/`-`/`@@` đầu dòng; reasoning chỉ còn khung.
  Tin nhắn `user`/`developer` Codex tự chèn chỉ giữ dòng đầu (`<environment_context>`,
  `# AGENTS.md instructions`...) để test thấy adapter bỏ qua chúng.
- `event_msg`: user_message (prompt bị thay, số ảnh giữ nguyên bằng chuỗi giả),
  token_count (chỉ số token, bỏ rate_limits/plan), patch_apply_end (đường dẫn đổi tên,
  nội dung thay theo dòng), turn_aborted, thread_rolled_back; các event khác rút về
  `{type}`.
- `compacted`: `message` bị thay, `replacement_history` rỗng.
- Bản 0.172: `item_completed` giữ `turn_id`, `item.type` (nội dung thay);
  `token_usage_record` chỉ giữ số token; `additional_tools` rút về khung.

Cuối cùng thay trên toàn dòng: thư mục người dùng (`C:\\Users\\<tên>` mọi dạng) →
`C:\\Users\\dev`, tên máy → `DEV-PC`, email → `dev@example.com`, mẫu token →
`[REDACTED]`, các cặp `--map`; tự kiểm tra lại và thoát mã 1 nếu còn sót.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
]
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
EMAIL_ALLOWED = {"dev@example.com"}
INJECTED_PREFIXES = (
    "<environment_context>",
    "# AGENTS.md instructions",
    "<permissions instructions>",
    "<collaboration_mode>",
    "<skills_instructions>",
    "<apps_instructions>",
    "<plugins_instructions>",
    "<app-context>",
    "<recommended_plugins>",
    "<turn_aborted>",
    "# Context from my IDE setup",
    "# Files mentioned by the user",
)
IDE_MARKER = "## My request for Codex:"


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
        self.maps = [m.split("=", 1) for m in args.map]
        self.user = os.path.basename(os.environ.get("USERPROFILE") or os.path.expanduser("~"))
        self.host = os.environ.get("COMPUTERNAME") or ""
        self.counter = 0
        self.renamed: dict[str, str] = {}

    # ---- nội dung tự do -------------------------------------------------------

    def neutral(self) -> str:
        self.counter += 1
        return f"(… đã thay khi làm fixture #{self.counter})"

    def text(self, s: str | None) -> str | None:
        if not s:
            return s
        return self.neutral()

    def path(self, p: str) -> str:
        """Đổi tên file (giữ thư mục và phần mở rộng) để không lộ tên file của dự án."""
        cut = max(p.rfind("\\"), p.rfind("/"))
        head, name = p[: cut + 1], p[cut + 1 :]
        if not name:
            return p
        ext = name[name.rfind(".") :] if "." in name else ""
        if name not in self.renamed:
            self.renamed[name] = f"file{len(self.renamed) + 1}{ext}"
        return head + self.renamed[name]

    def lines_with_sign(self, s: str) -> str:
        """Diff/patch: giữ ký tự đầu (`+`, `-`, ` `), header `@@`, thay phần còn lại."""
        out = []
        for line in s.split("\n"):
            if line == "":
                out.append(line)
            elif line.startswith("@@"):
                out.append(re.sub(r"(@@[^@]*@@).*", r"\1", line))
            elif line[0] in "+- ":
                out.append(line[0] + self.neutral())
            else:
                out.append(self.neutral())
        return "\n".join(out)

    def patch_input(self, s: str) -> str:
        out = []
        for line in s.split("\n"):
            m = re.match(r"(\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: )(.*)", line)
            if m:
                out.append(m.group(1) + self.path(m.group(2).strip()))
            elif line.startswith("***") or line == "" or line.startswith("@@"):
                out.append("@@" if line.startswith("@@") else line)
            elif line[0] in "+- ":
                out.append(line[0] + self.neutral())
            else:
                out.append(self.neutral())
        return "\n".join(out)

    def tool_output(self, s: str) -> str:
        """Giữ 3 dòng đầu dạng `Exit code: N` / `Wall time: ...` / `Output:` nếu có."""
        if s.startswith("{"):
            try:
                v = json.loads(s)
                if isinstance(v, dict) and isinstance(v.get("output"), str):
                    meta = v.get("metadata") or {}
                    return json.dumps(
                        {"output": self.neutral(), "metadata": {"exit_code": meta.get("exit_code")}},
                        ensure_ascii=False,
                    )
            except ValueError:
                pass
        head = []
        rest = s.split("\n")
        while rest and re.match(r"(Exit code: -?\d+|Wall time: .*|Output:|Chunk ID: .*)$", rest[0].rstrip("\r")):
            head.append(rest.pop(0).rstrip("\r"))
        if not head:
            # Giữ vài tiền tố do chính Codex sinh để test trạng thái lỗi.
            for prefix in ("exec command rejected by user", "apply_patch verification failed", "Script failed"):
                if s.startswith(prefix):
                    return prefix + " " + self.neutral()
        return "\n".join(head + [self.neutral()])

    # ---- từng loại dòng -------------------------------------------------------

    def session_meta(self, p: dict) -> dict:
        git = p.get("git") or {}
        out = {
            "id": p.get("id"),
            "forked_from_id": p.get("forked_from_id"),
            "timestamp": p.get("timestamp"),
            "cwd": p.get("cwd"),
            "originator": p.get("originator"),
            "cli_version": p.get("cli_version"),
            "source": p.get("source"),
            "thread_source": p.get("thread_source"),
            "model_provider": p.get("model_provider"),
            "base_instructions": {"text": "(… đã bỏ khi làm fixture)"},
        }
        if git:
            out["git"] = {"branch": git.get("branch"), "commit_hash": "0" * 40}
        return {k: v for k, v in out.items() if k in ("forked_from_id",) or v is not None}

    def turn_context(self, p: dict) -> dict:
        cm = p.get("collaboration_mode") or {}
        settings = cm.get("settings") or {}
        out = {
            "turn_id": p.get("turn_id"),
            "cwd": p.get("cwd"),
            "approval_policy": p.get("approval_policy"),
            "sandbox_policy": {"type": (p.get("sandbox_policy") or {}).get("type")},
            "model": p.get("model"),
            "effort": p.get("effort"),
            "summary": p.get("summary"),
        }
        if cm:
            out["collaboration_mode"] = {
                "mode": cm.get("mode"),
                "settings": {"model": settings.get("model"), "reasoning_effort": settings.get("reasoning_effort")},
            }
        return out

    def content_items(self, items: list, injected_ok: bool) -> list:
        out = []
        for c in items:
            t = c.get("type")
            if t in ("input_text", "output_text", "text"):
                text = c.get("text") or ""
                prefix = next((x for x in INJECTED_PREFIXES if text.lstrip().startswith(x)), None)
                if injected_ok and prefix:
                    out.append({"type": t, "text": prefix + "\n" + self.neutral()})
                else:
                    out.append({"type": t, "text": self.neutral()})
            elif t == "input_image":
                out.append({"type": t, "image_url": "data:image/png;base64,AAAA"})
            else:
                out.append({"type": t})
        return out

    def response_item(self, p: dict) -> dict:
        t = p.get("type")
        if t == "message":
            role = p.get("role")
            return {"type": t, "role": role, "content": self.content_items(p.get("content") or [], role != "assistant")}
        if t == "reasoning":
            return {"type": t, "summary": [], "encrypted_content": "ENC_FIXTURE"}
        if t == "function_call":
            args = p.get("arguments")
            try:
                v = json.loads(args) if isinstance(args, str) else args
            except ValueError:
                v = None
            if isinstance(v, dict):
                v = {k: (self.neutral() if isinstance(x, (str, list)) else x) for k, x in v.items()}
                args = json.dumps(v, ensure_ascii=False)
            else:
                args = self.neutral()
            return {"type": t, "name": p.get("name"), "arguments": args, "call_id": p.get("call_id")}
        if t == "custom_tool_call":
            raw = p.get("input") or ""
            inp = self.patch_input(raw) if p.get("name") == "apply_patch" else self.neutral()
            return {"type": t, "status": p.get("status"), "call_id": p.get("call_id"), "name": p.get("name"), "input": inp}
        if t in ("function_call_output", "custom_tool_call_output", "tool_search_output"):
            o = p.get("output")
            if isinstance(o, str):
                o = self.tool_output(o)
            elif isinstance(o, list):
                o = [
                    {"type": c.get("type"), "text": self.tool_output(c.get("text") or "")}
                    if c.get("type") in ("input_text", "output_text", "text")
                    else self.content_items([c], False)[0]
                    for c in o
                ]
            else:
                o = self.neutral()
            return {"type": t, "call_id": p.get("call_id"), "output": o}
        if t == "web_search_call":
            action = p.get("action") or {}
            return {"type": t, "status": p.get("status"), "action": {"type": action.get("type"), "query": self.neutral()}}
        if t == "additional_tools":
            return {"type": t, "role": p.get("role"), "tools": []}
        return {"type": t, "call_id": p.get("call_id")} if p.get("call_id") else {"type": t}

    def event(self, p: dict) -> dict:
        t = p.get("type")
        if t == "user_message":
            msg = p.get("message") or ""
            text = self.neutral()
            if msg.lstrip().startswith("# Context from my IDE setup") and IDE_MARKER in msg:
                text = "# Context from my IDE setup:\n\n## Open tabs:\n- file.ts: file.ts\n\n" + IDE_MARKER + "\n" + text
            return {
                "type": t,
                "message": text,
                "images": ["data:image/png;base64,AAAA" for _ in p.get("images") or []],
                "local_images": ["C:\\Users\\dev\\image.png" for _ in p.get("local_images") or []],
                "text_elements": [],
            }
        if t == "token_count":
            return {"type": t, "info": p.get("info"), "rate_limits": None}
        if t == "patch_apply_end":
            changes = {}
            for path, ch in (p.get("changes") or {}).items():
                c = {"type": ch.get("type")}
                if "content" in ch:
                    c["content"] = self.lines_with_sign_content(ch.get("content") or "")
                if "unified_diff" in ch:
                    c["unified_diff"] = self.lines_with_sign(ch.get("unified_diff") or "")
                if "move_path" in ch:
                    c["move_path"] = self.path(ch["move_path"]) if ch.get("move_path") else None
                changes[self.path(path)] = c
            return {
                "type": t,
                "call_id": p.get("call_id"),
                "turn_id": p.get("turn_id"),
                "stdout": self.neutral(),
                "stderr": "",
                "success": p.get("success"),
                "changes": changes,
                "status": p.get("status"),
            }
        if t in ("turn_aborted", "thread_rolled_back", "context_compacted", "task_started"):
            return {k: v for k, v in p.items() if k in ("type", "turn_id", "reason", "num_turns", "started_at")}
        if t == "task_complete":
            return {"type": t, "turn_id": p.get("turn_id"), "last_agent_message": self.text(p.get("last_agent_message"))}
        if t == "item_completed":
            item = p.get("item") or {}
            content = [
                {"type": c.get("type"), "text": self.neutral()} if "text" in c else {"type": c.get("type")}
                for c in item.get("content") or []
            ]
            return {"type": t, "turn_id": p.get("turn_id"), "item": {"type": item.get("type"), "content": content}}
        if t == "agent_message":
            return {"type": t, "message": self.neutral(), "phase": p.get("phase")}
        return {"type": t}

    def lines_with_sign_content(self, s: str) -> str:
        """Nội dung file thêm/xóa: giữ số dòng, thay từng dòng."""
        lines = s.split("\n")
        trail = lines[-1] == ""
        body = [self.neutral() for _ in (lines[:-1] if trail else lines)]
        return "\n".join(body) + ("\n" if trail else "")

    def line(self, d: dict) -> dict:
        t = d.get("type")
        p = d.get("payload") or {}
        if t == "session_meta":
            p = self.session_meta(p)
        elif t == "turn_context":
            p = self.turn_context(p)
        elif t == "response_item":
            p = self.response_item(p)
        elif t == "event_msg":
            p = self.event(p)
        elif t == "compacted":
            p = {"message": self.text(p.get("message")) or "", "replacement_history": []}
        elif t == "token_usage_record":
            p = {"turn_id": p.get("turn_id"), "usage": p.get("usage"), "turn_token_usage": p.get("turn_token_usage")}
        elif t == "world_state":
            p = {"full": True}
        return {"timestamp": d.get("timestamp"), "type": t, "payload": p}

    # ---- thay trên toàn dòng --------------------------------------------------

    def scrub(self, s: str) -> str:
        if self.user:
            u = re.escape(self.user)
            s = re.sub(rf"([A-Za-z]:)(\\\\|\\|/)Users(\\\\|\\|/){u}", r"C:\2Users\3dev", s, flags=re.I)
            s = re.sub(rf"/[a-z]/Users/{u}", "/c/Users/dev", s, flags=re.I)
            s = re.sub(rf"C--Users-{u}", "C--Users-dev", s, flags=re.I)
        if self.host:
            s = re.sub(re.escape(self.host), "DEV-PC", s, flags=re.I)
        for pat in SECRET_PATTERNS:
            s = pat.sub("[REDACTED]", s)
        s = EMAIL.sub(lambda m: m.group(0) if m.group(0) in EMAIL_ALLOWED else "dev@example.com", s)
        for old, new in self.maps:
            s = re.sub(re.escape(old), lambda _m, new=new: new, s, flags=re.I)
        return s

    def check(self, s: str) -> list[str]:
        problems = []
        if self.user and re.search(re.escape(self.user), s, flags=re.I):
            problems.append(f"còn tên người dùng {self.user!r}")
        if self.host and re.search(re.escape(self.host), s, flags=re.I):
            problems.append("còn tên máy")
        for m in EMAIL.finditer(s):
            if m.group(0) not in EMAIL_ALLOWED:
                problems.append(f"còn email {m.group(0)!r}")
        for pat in SECRET_PATTERNS:
            if pat.search(s):
                problems.append(f"còn mẫu token {pat.pattern!r}")
        for old, _ in self.maps:
            if re.search(re.escape(old), s, flags=re.I):
                problems.append(f"còn {old!r}")
        return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("dest")
    ap.add_argument("--select")
    ap.add_argument("--map", action="append", default=[])
    args = ap.parse_args()
    keep = parse_select(args.select)
    san = Sanitizer(args)
    out = []
    with open(args.src, encoding="utf-8") as f:
        for i, raw in enumerate(f):
            if keep is not None and i not in keep:
                continue
            line = json.dumps(san.line(json.loads(raw)), ensure_ascii=False)
            out.append(san.scrub(line))
    text = "\n".join(out) + "\n"
    problems = san.check(text)
    if problems:
        print("Không ghi file vì: " + "; ".join(sorted(set(problems))), file=sys.stderr)
        return 1
    os.makedirs(os.path.dirname(os.path.abspath(args.dest)), exist_ok=True)
    with open(args.dest, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"Đã ghi {len(out)} dòng vào {args.dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
