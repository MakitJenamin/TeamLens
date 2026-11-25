import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

export default function LocaleNotFound() {
  const t = useTranslations("common");
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-muted-foreground font-mono text-sm">404</p>
      <h1 className="text-2xl font-semibold">{t("notFound.title")}</h1>
      <p className="text-muted-foreground max-w-sm text-sm">{t("notFound.description")}</p>
      <Button render={<Link href="/" />} className="mt-2">
        {t("backHome")}
      </Button>
    </div>
  );
}
