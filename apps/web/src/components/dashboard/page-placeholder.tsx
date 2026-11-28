import { ConstructionIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Khung tạm cho màn hình chưa làm: tiêu đề + mô tả (spec mục 10) + mã task phụ trách.
 * Người làm task thay nội dung trang bằng màn hình thật.
 */
export function PagePlaceholder({
  title,
  description,
  task,
  children,
}: {
  title: string;
  description?: string;
  task: string;
  children?: React.ReactNode;
}) {
  const t = useTranslations("common");
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <Badge variant="secondary">{t("taskLabel", { code: task })}</Badge>
        </div>
        {description && <p className="text-muted-foreground max-w-3xl text-sm leading-relaxed">{description}</p>}
        {children}
      </div>
      <Card className="border-dashed">
        <CardContent className="text-muted-foreground flex flex-col items-center gap-2 py-12 text-sm">
          <ConstructionIcon className="size-6" />
          <span>{t("comingSoon")}</span>
        </CardContent>
      </Card>
    </div>
  );
}
