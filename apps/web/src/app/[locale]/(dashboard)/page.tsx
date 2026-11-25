import { FolderOpenIcon } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link, redirect } from "@/i18n/navigation";
import { serverApi } from "@/lib/api/server";
import type { MeResponse, ProjectSummary } from "@/lib/api/types";

export default async function DashboardHome({ params }: PageProps<"/[locale]">) {
  const { locale } = await params;
  setRequestLocale(locale);

  const projects = await serverApi<ProjectSummary[]>("/projects");
  if (projects.length > 0) {
    // Ưu tiên project mà mình là thành viên, rồi mới tới project bất kỳ (admin).
    const first = projects.find((p) => p.role !== null) ?? projects[0];
    redirect({ href: `/projects/${encodeURIComponent(first.id)}/overview`, locale });
  }

  const [t, tNav, me] = await Promise.all([
    getTranslations("common"),
    getTranslations("nav"),
    serverApi<MeResponse>("/auth/me"),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 items-center">
      <Card className="w-full text-center">
        <CardHeader className="items-center">
          <FolderOpenIcon className="text-muted-foreground mx-auto mb-2 size-10" />
          <CardTitle className="text-xl">{t("home.noProjectsTitle")}</CardTitle>
          <CardDescription>
            {me.user.isAdmin ? t("home.noProjectsAdmin") : t("home.noProjectsDescription")}
          </CardDescription>
          {me.user.isAdmin && (
            <Button render={<Link href="/admin" />} className="mx-auto mt-4">
              {tNav("admin")}
            </Button>
          )}
        </CardHeader>
      </Card>
    </div>
  );
}
