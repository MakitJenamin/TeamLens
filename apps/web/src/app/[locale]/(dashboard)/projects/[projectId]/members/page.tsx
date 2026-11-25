import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PagePlaceholder } from "@/components/dashboard/page-placeholder";

export async function generateMetadata({ params }: PageProps<"/[locale]/projects/[projectId]/members">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "members" });
  return { title: t("title") };
}

export default async function ProjectMembersPage({ params }: PageProps<"/[locale]/projects/[projectId]/members">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("members");

  return <PagePlaceholder title={t("title")} description={t("description")} task="M4.2" />;
}
