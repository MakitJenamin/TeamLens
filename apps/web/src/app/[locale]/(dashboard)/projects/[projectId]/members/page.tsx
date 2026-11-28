import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { MemberStatusList } from "@teamlens/schema";
import { redirect } from "@/i18n/navigation";
import { serverApi, serverApiOrNull } from "@/lib/api/server";
import type { MeResponse, User } from "@/lib/api/types";
import { MembersPanel } from "./_components/members-panel";

type Props = PageProps<"/[locale]/projects/[projectId]/members">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "members" });
  return { title: t("title") };
}

/** Trang Thành viên (M4.2): chỉ leader. Member được đưa về danh sách session của chính mình. */
export default async function ProjectMembersPage({ params }: Props) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("members");

  const me = await serverApiOrNull<MeResponse>("/auth/me");
  if (!me) return redirect({ href: "/login", locale });
  if (me.user.role !== "leader") return redirect({ href: `/projects/${projectId}/sessions`, locale });

  const [status, users] = await Promise.all([
    serverApi<MemberStatusList>(`/projects/${projectId}/member-status`),
    serverApi<User[]>("/users"),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      </div>
      <MembersPanel projectId={projectId} currentUserId={me.user.id} initialData={status} users={users} />
    </div>
  );
}
