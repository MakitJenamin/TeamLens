import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { serverApi } from "@/lib/api/server";
import type { Member, MeResponse } from "@/lib/api/types";
import { type MemberOption, SessionList } from "./_components/session-list";

type Props = PageProps<"/[locale]/projects/[projectId]/sessions">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "sessions" });
  return { title: t("list.title") };
}

/** Danh sách thành viên cho bộ lọc "người": chỉ leader mới cần (member chỉ thấy của mình). */
async function memberOptions(projectId: string): Promise<MemberOption[] | null> {
  try {
    const me = await serverApi<MeResponse>("/auth/me");
    if (me.user.role !== "leader") return null;
    const members = await serverApi<Member[]>(`/projects/${projectId}/members`);
    return members.map((m) => ({ id: m.userId, name: m.name }));
  } catch {
    // Không lấy được danh sách thì chỉ ẩn bộ lọc, trang vẫn dùng được.
    return null;
  }
}

export default async function ProjectSessionsPage({ params }: Props) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("sessions");
  const members = await memberOptions(projectId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("list.title")}</h1>
        <p className="text-muted-foreground max-w-3xl text-sm leading-relaxed">{t("list.description")}</p>
      </div>
      <SessionList projectId={projectId} members={members} />
    </div>
  );
}
