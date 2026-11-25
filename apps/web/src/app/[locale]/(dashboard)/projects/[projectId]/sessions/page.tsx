import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PagePlaceholder } from "@/components/dashboard/page-placeholder";

export async function generateMetadata({ params }: PageProps<"/[locale]/projects/[projectId]/sessions">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "sessions" });
  return { title: t("list.title") };
}

export default async function ProjectSessionsPage({ params }: PageProps<"/[locale]/projects/[projectId]/sessions">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("sessions");

  return <PagePlaceholder title={t("list.title")} description={t("list.description")} task="A8" />;
}
