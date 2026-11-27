import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PagePlaceholder } from "@/components/dashboard/page-placeholder";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/settings/ai">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "aiSettings" });
  return { title: t("title") };
}

export default async function AiSettingsPage({ params }: PageProps<"/[locale]/settings/ai">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("aiSettings");

  return <PagePlaceholder title={t("title")} description={t("description")} task="M6.2" />;
}
