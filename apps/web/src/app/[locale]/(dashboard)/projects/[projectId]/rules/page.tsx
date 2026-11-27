import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { serverApiOrNull } from "@/lib/api/server";
import type { MeResponse } from "@/lib/api/types";
import { RulesPanel } from "./rules-panel";

export async function generateMetadata({ params }: PageProps<"/[locale]/projects/[projectId]/rules">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "rules" });
  return { title: t("title") };
}

export default async function ProjectRulesPage({ params }: PageProps<"/[locale]/projects/[projectId]/rules">) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("rules");
  const me = await serverApiOrNull<MeResponse>("/auth/me");
  if (!me) return redirect({ href: "/login", locale });
  if (me.user.role !== "leader") return redirect({ href: `/projects/${projectId}/sessions`, locale });

  return <div className="space-y-6">
    <div><h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-muted-foreground mt-2 max-w-3xl text-sm leading-relaxed">{t("description")}</p></div>
    <RulesPanel projectId={projectId} />
  </div>;
}
