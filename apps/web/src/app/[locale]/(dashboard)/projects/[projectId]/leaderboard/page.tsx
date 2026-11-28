import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PagePlaceholder } from "@/components/dashboard/page-placeholder";

export async function generateMetadata({ params }: PageProps<"/[locale]/projects/[projectId]/leaderboard">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "leaderboard" });
  return { title: t("title") };
}

export default async function ProjectLeaderboardPage({ params }: PageProps<"/[locale]/projects/[projectId]/leaderboard">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("leaderboard");

  return <PagePlaceholder title={t("title")} task="M4.3" />;
}
