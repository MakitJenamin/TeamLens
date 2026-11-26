"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Một dòng chữ cần copy (link mời, câu lệnh) kèm nút sao chép.
 * Dùng cho wizard /setup, quản lý link mời và trang /i/<mã>.
 */
export function CopyField({ label, value }: { label: string; value: string }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border bg-muted px-2 py-1.5 font-mono text-xs">
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copy}
          aria-label={`${copied ? t("copied") : t("copy")}: ${label}`}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span className="sr-only sm:not-sr-only">{copied ? t("copied") : t("copy")}</span>
        </Button>
      </div>
    </div>
  );
}

/** Câu lệnh tham gia khi máy đã có `tl`. */
export function joinCommand(url: string): string {
  return `tl join ${url}`;
}
