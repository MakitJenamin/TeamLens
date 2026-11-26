import type { Metadata } from "next";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { CopyField, joinCommand } from "@/components/copy-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchInvitePreview } from "@/lib/api/server";

const KNOWN_ERRORS = [
  "invite_not_found",
  "invite_expired",
  "invite_used_up",
  "invite_revoked",
  "rate_limited",
] as const;
type KnownError = (typeof KNOWN_ERRORS)[number];

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/i/[code]">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "invite" });
  return { title: t("pageTitle"), robots: { index: false } };
}

/**
 * Trang công khai của link mời `/i/<mã>` (SPEC 7.1). Không có form đăng nhập/đăng ký:
 * chỉ cho biết project, repo sẽ thu thập và câu lệnh để tham gia.
 */
export default async function InvitePage({ params }: PageProps<"/[locale]/i/[code]">) {
  const { locale, code } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("invite");
  const format = await getFormatter();
  const result = await fetchInvitePreview(code);

  if (!result.ok) {
    const key: KnownError | "generic" = (KNOWN_ERRORS as readonly string[]).includes(result.error)
      ? (result.error as KnownError)
      : "generic";
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>{t("errorTitle")}</AlertTitle>
        <AlertDescription>{t(`errors.${key}`)}</AlertDescription>
      </Alert>
    );
  }

  const { preview } = result;
  const origin = preview.serverUrl.replace(/\/+$/, "");
  const inviteUrl = `${origin}/i/${code}`;
  const installCommand = `irm ${origin}/install.ps1?code=${code} | iex`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl break-words">
          {t("title", { project: preview.project.name })}
        </CardTitle>
        <CardDescription>{t("description", { project: preview.project.name })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">{t("repos")}</h2>
          {preview.repoPatterns.length ? (
            <ul className="space-y-1">
              {preview.repoPatterns.map((pattern) => (
                <li key={pattern}>
                  <code className="break-all font-mono text-xs">{pattern}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">{t("noRepos")}</p>
          )}
          <p className="text-muted-foreground text-xs">{t("reposHint")}</p>
        </section>
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">{t("newMachine")}</h2>
          <p className="text-muted-foreground text-xs">{t("newMachineHint")}</p>
          <CopyField label={t("installCommand")} value={installCommand} />
        </section>
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">{t("hasTl")}</h2>
          <p className="text-muted-foreground text-xs">{t("hasTlHint")}</p>
          <CopyField label={t("joinCommand")} value={joinCommand(inviteUrl)} />
        </section>
        <p className="text-muted-foreground text-xs">
          {t("expiresAt", {
            date: format.dateTime(new Date(preview.expiresAt), {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </p>
      </CardContent>
    </Card>
  );
}
