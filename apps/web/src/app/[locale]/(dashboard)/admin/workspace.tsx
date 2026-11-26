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
  type Role,
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

function RoleSelect({ initial = "member", label }: { initial?: Role; label: string }) {
  const t = useTranslations("admin");
  return (
    <label className="grid gap-1 text-sm font-medium">
      {label}
      <select className={select} name="role" defaultValue={initial}>
        <option value="member">{t("member")}</option>
        <option value="leader">{t("leader")}</option>
      </select>
    </label>
  );
}

export function UserAdmin({ users }: { users: User[] }) {
  const t = useTranslations("admin");
  return (
    <div className="space-y-5">
      <section className={panel}>
        <h2 className="text-lg font-semibold">{t("createUser")}</h2>
        <ActionForm
          reset
          label={t("createUser")}
          variant="default"
          submit={(data) =>
            api.post("/users", {
              name: value(data, "name"),
              email: value(data, "email"),
              password: String(data.get("password")),
              isAdmin: data.has("isAdmin"),
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
          <label className="flex h-8 items-center gap-2 text-sm">
            <input type="checkbox" name="isAdmin" />
            {t("adminRole")}
          </label>
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
                <p className="text-sm text-muted-foreground">{user.email}</p>
              </div>
              <span className="text-sm">{t(user.isAdmin ? "adminRole" : "userRole")}</span>
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
}: {
  projects: ProjectSummary[];
  project: ProjectDetail | null;
  members: Member[];
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
        <ProjectSettings project={project} members={members} />
      ) : (
        <p className="text-muted-foreground">{t("noProjects")}</p>
      )}
    </div>
  );
}

function ProjectSettings({ project, members }: { project: ProjectDetail; members: Member[] }) {
  const t = useTranslations("admin");
  const path = `/projects/${project.id}`;
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
        <ActionForm
          reset
          variant="default"
          label={t("addMember")}
          submit={(data) =>
            api.post(path + "/members", { email: value(data, "email"), role: value(data, "role") })
          }
        >
          <Field label={t("email")} name="email" type="email" />
          <RoleSelect label={t("role")} />
        </ActionForm>
        {members.length === 0 && <p className="text-sm text-muted-foreground">{t("noMembers")}</p>}
        <ul>
          {members.map((m) => (
            <li className={row} key={m.userId}>
              <div className="min-w-0 break-words">
                <strong>{m.name}</strong>
                <p className="text-sm text-muted-foreground">{m.email}</p>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <ActionForm
                  key={m.role}
                  label={t("saveRole")}
                  submit={(data) =>
                    api.patch(path + "/members/" + m.userId, { role: value(data, "role") })
                  }
                >
                  <RoleSelect label={t("roleFor", { name: m.name })} initial={m.role} />
                </ActionForm>
                <ActionForm
                  variant="destructive"
                  label={t("remove")}
                  confirm={t("confirmMember", { name: m.email })}
                  submit={() => api.delete(path + "/members/" + m.userId)}
                />
              </div>
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
