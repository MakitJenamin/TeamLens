"use client";

import { useRef, useTransition, type ComponentProps, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRouter, Link } from "@/i18n/navigation";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/hooks";
import {
  PASSWORD_MIN_LENGTH,
  type Member,
  type Project,
  type ProjectDetail,
  type ProjectSummary,
  type User,
} from "@/lib/api/types";

const panel = "space-y-4 rounded-xl border bg-card p-4 sm:p-5";
const row = "flex flex-wrap items-center justify-between gap-3 border-t py-3";
const select = "h-8 rounded-lg border bg-background px-2 text-sm";
const value = (data: FormData, key: string) => String(data.get(key) ?? "").trim();

function Field({ label, ...props }: ComponentProps<typeof Input> & { label: string }) {
  return (
    <label className="grid min-w-0 flex-[1_1_11rem] gap-1 text-sm font-medium">
      {label}
      <Input required {...props} />
    </label>
  );
}

function ActionForm({
  children,
  submit,
  label,
  confirm,
  reset = false,
  variant = "outline",
}: {
  children?: ReactNode;
  submit: (data: FormData) => Promise<unknown>;
  label: string;
  confirm?: string;
  reset?: boolean;
  variant?: "default" | "outline" | "destructive";
}) {
  const router = useRouter();
  const client = useQueryClient();
  const t = useTranslations("admin");
  const form = useRef<HTMLFormElement>(null);
  const [refreshing, startTransition] = useTransition();
  const mutation = useMutation({
    mutationFn: submit,
    onSuccess: () => {
      if (reset) form.current?.reset();
      void client.invalidateQueries({ queryKey: queryKeys.projects });
      startTransition(() => router.refresh());
      toast.success(t("saved"));
    },
  });
  return (
    <form
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        if (!confirm || window.confirm(confirm)) mutation.mutate(new FormData(event.currentTarget));
      }}
    >
      <fieldset
        disabled={mutation.isPending || refreshing}
        className="flex flex-wrap items-end gap-2"
      >
        {children}
        <Button type="submit" variant={variant}>
          {label}
        </Button>
      </fieldset>
      {mutation.error && (
        <p role="alert" className="mt-1 text-sm text-destructive">
          {mutation.error.message}
        </p>
      )}
    </form>
  );
}

/** Vai trò toàn server: leader làm mọi thứ, member chỉ dữ liệu của mình (SPEC 11.1). */
function roleLabel(t: ReturnType<typeof useTranslations<"admin">>, role: User["role"]) {
  return role === "leader" ? t("leader") : t("member");
}

export function UserAdmin({ users }: { users: User[] }) {
  const t = useTranslations("admin");
  return (
    <div className="space-y-5">
      <section className={panel}>
        <h2 className="text-lg font-semibold">{t("createLeader")}</h2>
        <p className="text-sm text-muted-foreground">{t("createLeaderHint")}</p>
        <ActionForm
          reset
          label={t("createLeader")}
          variant="default"
          submit={(data) =>
            api.post("/users", {
              name: value(data, "name"),
              email: value(data, "email"),
              password: String(data.get("password")),
            })
          }
        >
          <Field name="name" label={t("name")} autoComplete="off" />
          <Field name="email" label={t("email")} type="email" />
          <Field
            name="password"
            label={t("password")}
            type="password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
          />
        </ActionForm>
      </section>
      <section className={panel}>
        <h2 className="text-lg font-semibold">
          {t("users")} ({users.length})
        </h2>
        <ul>
          {users.map((user) => (
            <li key={user.id} className={row}>
              <div className="min-w-0 break-words">
                <strong>{user.name}</strong>
                <p className="text-sm text-muted-foreground">
                  {roleLabel(t, user.role)}
                  {user.email ? ` · ${user.email}` : ""}
                </p>
              </div>
              {user.role === "leader" ? (
                <ActionForm
                  label={t("makeMember")}
                  confirm={t("confirmMakeMember", { name: user.name })}
                  submit={() => api.patch(`/users/${user.id}`, { role: "member" })}
                />
              ) : (
                <ActionForm
                  label={t("makeLeader")}
                  submit={(data) => {
                    const email = value(data, "email");
                    const password = String(data.get("password") ?? "");
                    return api.patch(`/users/${user.id}`, {
                      role: "leader",
                      ...(email ? { email } : {}),
                      ...(password ? { password } : {}),
                    });
                  }}
                >
                  {!user.email && (
                    <>
                      <Field name="email" label={t("email")} type="email" />
                      <Field
                        name="password"
                        label={t("password")}
                        type="password"
                        autoComplete="new-password"
                        minLength={PASSWORD_MIN_LENGTH}
                      />
                    </>
                  )}
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function ProjectAdmin({
  projects,
  project,
  members,
  users,
}: {
  projects: ProjectSummary[];
  project: ProjectDetail | null;
  members: Member[];
  users: User[];
}) {
  const t = useTranslations("admin");
  const router = useRouter();
  return (
    <div className="grid items-start gap-5 md:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)]">
      <aside className={panel}>
        <h2 className="font-semibold">
          {t("projects")} ({projects.length})
        </h2>
        <ul className="space-y-1">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/admin?project=${p.id}`}
                aria-current={project?.id === p.id ? "page" : undefined}
                className="block break-words rounded-lg px-3 py-2 text-sm hover:bg-muted aria-[current=page]:bg-muted"
              >
                <strong>{p.name}</strong>
                <span className="block font-mono text-xs text-muted-foreground">{p.slug}</span>
              </Link>
            </li>
          ))}
        </ul>
        <details className="border-t pt-3" open={!projects.length || undefined}>
          <summary className="cursor-pointer text-sm font-medium">{t("createProject")}</summary>
          <div className="pt-3">
            <ActionForm
              reset
              variant="default"
              label={t("create")}
              submit={async (data) => {
                const created = await api.post<Project>("/projects", {
                  name: value(data, "name"),
                  slug: value(data, "slug"),
                });
                router.push(`/admin?project=${created.id}`);
              }}
            >
              <div className="grid w-full gap-2">
                <Field label={t("projectName")} name="name" />
                <Field
                  label={t("slug")}
                  name="slug"
                  pattern="[a-z0-9](([a-z0-9]|-){0,62}[a-z0-9])?"
                  placeholder="teamlens"
                />
              </div>
            </ActionForm>
          </div>
        </details>
      </aside>
      {project ? (
        <ProjectSettings project={project} members={members} users={users} />
      ) : (
        <p className="text-muted-foreground">{t("noProjects")}</p>
      )}
    </div>
  );
}

function ProjectSettings({
  project,
  members,
  users,
}: {
  project: ProjectDetail;
  members: Member[];
  users: User[];
}) {
  const t = useTranslations("admin");
  const path = `/projects/${project.id}`;
  const memberIds = new Set(members.map((m) => m.userId));
  const candidates = users.filter((u) => !memberIds.has(u.id));
  return (
    <div className="min-w-0 space-y-5">
      <section className={panel}>
        <h2 className="break-words text-xl font-semibold">{project.name}</h2>
        <ActionForm
          key={project.name}
          label={t("saveName")}
          submit={(data) => api.patch(path, { name: value(data, "name") })}
        >
          <Field name="name" label={t("projectName")} defaultValue={project.name} />
        </ActionForm>
      </section>
      <section className={panel}>
        <h2 className="text-lg font-semibold">
          {t("members")} ({members.length})
        </h2>
        <p className="text-sm text-muted-foreground">{t("membersHint")}</p>
        {candidates.length > 0 && (
          <ActionForm
            reset
            variant="default"
            label={t("addMember")}
            submit={(data) => api.post(path + "/members", { userId: value(data, "userId") })}
          >
            <label className="grid gap-1 text-sm font-medium">
              {t("pickUser")}
              <select className={select} name="userId" required>
                {candidates.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({roleLabel(t, u.role)})
                  </option>
                ))}
              </select>
            </label>
          </ActionForm>
        )}
        {members.length === 0 && <p className="text-sm text-muted-foreground">{t("noMembers")}</p>}
        <ul>
          {members.map((m) => (
            <li className={row} key={m.userId}>
              <div className="min-w-0 break-words">
                <strong>{m.name}</strong>
                <p className="text-sm text-muted-foreground">
                  {roleLabel(t, m.role)}
                  {m.email ? ` · ${m.email}` : ""}
                </p>
              </div>
              <ActionForm
                variant="destructive"
                label={t("remove")}
                confirm={t("confirmMember", { name: m.name })}
                submit={() => api.delete(path + "/members/" + m.userId)}
              />
            </li>
          ))}
        </ul>
      </section>
      <section className={panel}>
        <h2 className="text-lg font-semibold">
          {t("repos")} ({project.repos.length})
        </h2>
        <ActionForm
          reset
          variant="default"
          label={t("addRepo")}
          submit={(data) => api.post(path + "/repos", { remotePattern: value(data, "pattern") })}
        >
          <Field label={t("pattern")} name="pattern" placeholder="github.com/acme/*" />
        </ActionForm>
        {project.repos.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("noRepos")}</p>
        )}
        <ul>
          {project.repos.map((repo) => (
            <li key={repo.id} className={row}>
              <code className="break-all text-sm">{repo.remotePattern}</code>
              <ActionForm
                variant="destructive"
                label={t("remove")}
                confirm={t("confirmRepo", { name: repo.remotePattern })}
                submit={() => api.delete(path + "/repos/" + repo.id)}
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
