import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PagePlaceholder } from "@/components/dashboard/page-placeholder";

type Props = PageProps<"/[locale]/projects/[projectId]/sessions/[sessionId]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "sessions" });
  return { title: t("detail.title") };
}

export default async function SessionDetailPage({ params }: Props) {
  const { locale, sessionId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("sessions");

  return (
    <PagePlaceholder title={t("detail.title")} description={t("detail.description")} task="A8">
      <p className="text-muted-foreground font-mono text-xs">{t("detail.sessionId", { id: sessionId })}</p>
    </PagePlaceholder>
  );
}
