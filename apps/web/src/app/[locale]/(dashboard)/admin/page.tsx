import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link, redirect } from "@/i18n/navigation";
import { serverApi, serverApiOrNull } from "@/lib/api/server";
import type { Member, MeResponse, ProjectDetail, ProjectSummary, User } from "@/lib/api/types";
import { ProjectAdmin, UserAdmin } from "./workspace";
import { AuditPanel } from "./audit-panel";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/admin">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin" });
  return { title: t("title") };
}

export default async function AdminPage({ params, searchParams }: PageProps<"/[locale]/admin">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("admin");

  const me = await serverApiOrNull<MeResponse>("/auth/me");
  if (!me) return redirect({ href: "/login", locale });
  if (me.user.role !== "leader") return redirect({ href: "/", locale });
  const query = await searchParams;
  const tab = query.tab === "users" || query.tab === "audit" ? query.tab : "projects";
  let panel;
  if (tab === "audit") {
    panel = <AuditPanel />;
  } else if (tab === "users") {
    panel = <UserAdmin users={await serverApi<User[]>("/users")} />;
  } else {
    const projects = await serverApi<ProjectSummary[]>("/projects");
    const selected = projects.find((p) => p.id === query.project) ?? projects[0];
    const [project, members, users] = selected
      ? await Promise.all([
          serverApi<ProjectDetail>(`/projects/${selected.id}`),
          serverApi<Member[]>(`/projects/${selected.id}/members`),
          serverApi<User[]>("/users"),
        ])
      : [null, [], []];
    panel = (
      <ProjectAdmin
        key={project?.id}
        projects={projects}
        project={project}
        members={members}
        users={users}
      />
    );
  }
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
      <nav aria-label={t("title")} className="flex gap-6 border-b">
        {(["projects", "users", "audit"] as const).map((item) => (
          <Link
            key={item}
            href={item === "projects" ? "/admin" : `/admin?tab=${item}`}
            aria-current={tab === item ? "page" : undefined}
            className="border-b-2 border-transparent pb-2 text-sm text-muted-foreground aria-[current=page]:border-primary aria-[current=page]:font-semibold aria-[current=page]:text-foreground"
          >
            {t(item)}
          </Link>
        ))}
      </nav>
      {panel}
    </main>
  );
}
