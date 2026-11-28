import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { serverApi } from "@/lib/api/server";
import type { MeResponse } from "@/lib/api/types";
import { PromptLibrary } from "./_components/prompt-library";

type Props = PageProps<"/[locale]/projects/[projectId]/prompt-library">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "promptLibrary" });
  return { title: t("title") };
}

/** Leader có thêm khu tìm ứng viên và nút gỡ; lỗi khi lấy vai trò thì coi như member (API vẫn chặn đúng quyền). */
async function isLeader(): Promise<boolean> {
  try {
    const me = await serverApi<MeResponse>("/auth/me");
    return me.user.role === "leader";
  } catch {
    return false;
  }
}

export default async function ProjectPromptLibraryPage({ params }: Props) {
  const { locale, projectId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("promptLibrary");
  const leader = await isLeader();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground max-w-3xl text-sm">{t("description")}</p>
      </div>
      <PromptLibrary projectId={projectId} isLeader={leader} />
    </div>
  );
}
