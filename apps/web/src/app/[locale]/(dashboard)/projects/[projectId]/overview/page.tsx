import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PagePlaceholder } from "@/components/dashboard/page-placeholder";

export async function generateMetadata({ params }: PageProps<"/[locale]/projects/[projectId]/overview">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "overview" });
  return { title: t("title") };
}

export default async function ProjectOverviewPage({ params }: PageProps<"/[locale]/projects/[projectId]/overview">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("overview");

  return <PagePlaceholder title={t("title")} description={t("description")} task="B9" />;
}
