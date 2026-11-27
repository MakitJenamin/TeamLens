import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { serverApiOrNull } from "@/lib/api/server";
import type { MeResponse } from "@/lib/api/types";
import { OverviewDashboard } from "./_components/overview-dashboard";

type Props = PageProps<"/[locale]/projects/[projectId]/overview">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "overview" });
  return { title: t("title") };
}

/** Tổng quan project (M2.9): chỉ leader. Member được đưa về danh sách session của chính mình. */
export default async function ProjectOverviewPage({ params }: Props) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("overview");

  const me = await serverApiOrNull<MeResponse>("/auth/me");
  if (!me) return redirect({ href: "/login", locale });
  if (me.user.role !== "leader") return redirect({ href: `/projects/${projectId}/sessions`, locale });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground max-w-3xl text-sm leading-relaxed">{t("description")}</p>
      </div>
      <OverviewDashboard projectId={projectId} />
    </div>
  );
}
