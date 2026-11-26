import { AlertCircleIcon } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApiError } from "@/lib/api/client";
import { serverApi } from "@/lib/api/server";
import type { SessionDetail } from "@/lib/api/types";
import { SessionDetailView } from "../_components/session-detail";

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

  return <SessionDetailView session={session} />;
}
