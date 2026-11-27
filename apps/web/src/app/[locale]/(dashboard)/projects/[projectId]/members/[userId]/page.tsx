import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link, redirect } from "@/i18n/navigation";
import { serverApiOrNull } from "@/lib/api/server";
import type { MeResponse } from "@/lib/api/types";
import { ProfileDashboard } from "./_components/profile-dashboard";

type Props = PageProps<"/[locale]/projects/[projectId]/members/[userId]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "profile" });
  return { title: t("title") };
}

/** Hồ sơ thành viên (M2.10): leader xem mọi người, member chỉ xem của mình (member khác bị chuyển về danh sách session). */
export default async function MemberProfilePage({ params }: Props) {
  const { locale, projectId, userId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("profile");

  const me = await serverApiOrNull<MeResponse>("/auth/me");
  if (!me) return redirect({ href: "/login", locale });
  if (me.user.role !== "leader" && me.user.id !== userId)
    return redirect({ href: `/projects/${projectId}/sessions`, locale });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        {me.user.role === "leader" && (
          <Link
            href={`/projects/${projectId}/members`}
            className="text-muted-foreground w-fit text-xs underline-offset-4 hover:underline"
          >
            {t("back")}
          </Link>
        )}
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground max-w-3xl text-sm leading-relaxed">{t("description")}</p>
      </div>
      <ProfileDashboard projectId={projectId} userId={userId} />
    </div>
  );
}
