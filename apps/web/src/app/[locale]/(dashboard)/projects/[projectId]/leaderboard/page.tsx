import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { serverApiOrNull } from "@/lib/api/server";
import type { MeResponse } from "@/lib/api/types";
import { LeaderboardPanel } from "./leaderboard-panel";

export async function generateMetadata({ params }: PageProps<"/[locale]/projects/[projectId]/leaderboard">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "leaderboard" });
  return { title: t("title") };
}

export default async function ProjectLeaderboardPage({ params }: PageProps<"/[locale]/projects/[projectId]/leaderboard">) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("leaderboard");
  const me = await serverApiOrNull<MeResponse>("/auth/me");
  if (!me) return redirect({ href: "/login", locale });

  return <div className="flex flex-col gap-6">
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-muted-foreground max-w-3xl text-sm leading-relaxed">{t("description")}</p>
    </div>
    <LeaderboardPanel projectId={projectId} isLeader={me.user.role === "leader"} />
  </div>;
}
