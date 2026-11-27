import { useTranslations } from "next-intl";
import { CopyField } from "@/components/copy-field";
import { installCommand, installCommandCmd, joinCommand } from "@/lib/invite-commands";

/**
 * Hai bước để thành viên tham gia: (1) cài `tl` bằng lệnh chung (PowerShell hoặc CMD),
 * (2) `tl join <link mời>`. Dùng cho trang /i/<mã>, wizard /setup và quản lý link mời.
 */
export function InstallSteps({
  inviteUrl,
  headingLevel = "h3",
}: {
  inviteUrl: string;
  headingLevel?: "h2" | "h3" | "h4";
}) {
  const t = useTranslations("common.installSteps");
  const Heading = headingLevel;
  return (
    <div className="flex flex-col gap-5">
      <section className="space-y-2">
        <Heading className="text-sm font-semibold">{t("installTitle")}</Heading>
        <p className="text-muted-foreground text-xs">{t("installHint")}</p>
        <CopyField label={t("powershell")} value={installCommand} />
        <CopyField label={t("cmd")} value={installCommandCmd} />
      </section>
      <section className="space-y-2">
        <Heading className="text-sm font-semibold">{t("joinTitle")}</Heading>
        <p className="text-muted-foreground text-xs">{t("joinHint")}</p>
        <CopyField label={t("joinCommand")} value={joinCommand(inviteUrl)} />
      </section>
    </div>
  );
}
