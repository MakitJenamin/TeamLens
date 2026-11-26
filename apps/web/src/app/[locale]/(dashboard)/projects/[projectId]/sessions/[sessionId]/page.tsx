import { AlertCircleIcon } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApiError } from "@/lib/api/client";
import { serverApi, serverApiOrNull } from "@/lib/api/server";
import type { MeResponse, SessionDetail } from "@/lib/api/types";
import { SessionDetailView } from "../_components/session-detail";
import type { NoteViewer } from "../_components/session-notes";

type Props = PageProps<"/[locale]/projects/[projectId]/sessions/[sessionId]">;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "sessions" });
  return { title: t("detail.title") };
}

export default async function SessionDetailPage({ params }: Props) {
  const { locale, sessionId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("sessions");

  let session: SessionDetail;
  try {
    session = await serverApi<SessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`);
  } catch (err) {
    if (!(err instanceof ApiError) || (err.status !== 403 && err.status !== 404)) throw err;
    return (
      <Alert variant="destructive" className="max-w-2xl">
        <AlertCircleIcon />
        <AlertTitle>{t("detail.errorTitle")}</AlertTitle>
        <AlertDescription>
          <p>{err.status === 403 ? t("detail.forbidden") : t("detail.notFound")}</p>
          <p className="font-mono text-xs">{t("detail.sessionId", { id: sessionId })}</p>
        </AlertDescription>
      </Alert>
    );
  }

  // Người xem: quyết định có hiện nút thêm/xóa ghi chú (API vẫn kiểm tra quyền).
  const me = await serverApiOrNull<MeResponse>("/auth/me");
  const viewer: NoteViewer | null = me ? { id: me.user.id, isLeader: me.user.role === "leader" } : null;

  return <SessionDetailView session={session} viewer={viewer} />;
}
