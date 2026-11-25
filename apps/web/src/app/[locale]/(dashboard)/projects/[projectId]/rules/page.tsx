import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PagePlaceholder } from "@/components/dashboard/page-placeholder";

export async function generateMetadata({ params }: PageProps<"/[locale]/projects/[projectId]/rules">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "rules" });
  return { title: t("title") };
}

export default async function ProjectRulesPage({ params }: PageProps<"/[locale]/projects/[projectId]/rules">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("rules");

  return <PagePlaceholder title={t("title")} description={t("description")} task="M4-Y1" />;
}
