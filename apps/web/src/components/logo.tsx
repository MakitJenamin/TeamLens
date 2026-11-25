import { ScanEyeIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function Logo({ className, showText = true }: { className?: string; showText?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold", className)}>
      <span className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md">
        <ScanEyeIcon className="size-4" />
      </span>
      {showText && <span>TeamLens</span>}
    </span>
  );
}
