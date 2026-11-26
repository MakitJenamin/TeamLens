"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { PlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
import { CopyField } from "@/components/copy-field";
import { joinCommand } from "@/lib/invite-commands";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api/client";
import { useSetup } from "@/lib/api/hooks";
import {
  PASSWORD_MIN_LENGTH as PASSWORD_MIN,
  type CreatedInvite,
  type SetupRequest,
} from "@/lib/api/types";

/** Giống `ProjectSlug` trong contract. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_PATTERNS = 20;

/** Gợi ý slug từ tên project: bỏ dấu tiếng Việt, chữ thường, nối bằng "-". */
export function suggestSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

type Step = "account" | "project" | "done";
type Account = Pick<SetupRequest, "name" | "email" | "password">;

function StepIndicator({ step }: { step: Step }) {
  const t = useTranslations("auth.setup");
  const steps: Step[] = ["account", "project", "done"];
  const current = steps.indexOf(step);
  return (
    <ol className="flex gap-2 text-xs" aria-label={t("stepsLabel")}>
      {steps.map((s, i) => (
        <li
          key={s}
          aria-current={i === current ? "step" : undefined}
          className="flex-1 border-t-2 border-muted pt-1 text-muted-foreground aria-[current=step]:border-primary aria-[current=step]:font-semibold aria-[current=step]:text-foreground data-[done=true]:border-primary/50"
          data-done={i < current}
        >
          {i + 1}. {t(`steps.${s}`)}
        </li>
      ))}
    </ol>
  );
}

/**
 * Wizard `/setup` (SPEC 7.1): (1) tài khoản leader, (2) project đầu tiên (có thể bỏ qua),
 * (3) gửi `POST /setup` rồi hiện link mời để gửi cho cả nhóm.
 */
export function SetupForm() {
  const t = useTranslations("auth");
  const tc = useTranslations("common");
  const router = useRouter();
  const setup = useSetup();
  const [step, setStep] = useState<Step>("account");
  const [account, setAccount] = useState<Account | null>(null);
  const [invite, setInvite] = useState<CreatedInvite | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [alreadySetup, setAlreadySetup] = useState(false);

  const accountSchema = z
    .object({
      name: z.string().trim().min(1, t("validation.nameRequired")),
      email: z.email(t("validation.emailInvalid")),
      password: z.string().min(PASSWORD_MIN, t("validation.passwordMin", { min: PASSWORD_MIN })),
      confirmPassword: z.string(),
    })
    .refine((v) => v.password === v.confirmPassword, {
      message: t("validation.passwordMismatch"),
      path: ["confirmPassword"],
    });
  type AccountValues = z.infer<typeof accountSchema>;

  const projectSchema = z.object({
    projectName: z.string().trim().min(1, t("validation.projectNameRequired")),
    slug: z.string().trim().regex(SLUG_PATTERN, t("validation.slugInvalid")),
    patterns: z
      .array(z.object({ value: z.string().trim() }))
      .refine((items) => items.some((p) => p.value.length > 0), {
        message: t("validation.patternRequired"),
      }),
  });
  type ProjectValues = z.infer<typeof projectSchema>;

  const accountForm = useForm<AccountValues>({
    resolver: zodResolver(accountSchema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
  });
  const projectForm = useForm<ProjectValues>({
    resolver: zodResolver(projectSchema),
    defaultValues: { projectName: "", slug: "", patterns: [{ value: "" }] },
  });
  const patterns = useFieldArray({ control: projectForm.control, name: "patterns" });
  // Slug tự theo tên cho tới khi người dùng sửa tay.
  const [slugTouched, setSlugTouched] = useState(false);

  function goToDashboard() {
    router.replace("/");
    router.refresh();
  }

  async function submit(project?: SetupRequest["project"]) {
    if (!account) return;
    setFormError(null);
    try {
      const res = await setup.mutateAsync({ ...account, ...(project ? { project } : {}) });
      if (res.invite) {
        setInvite(res.invite);
        setStep("done");
      } else {
        goToDashboard();
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "already_setup") {
        setAlreadySetup(true);
      } else if (err instanceof ApiError && err.code === "network_error") {
        setFormError(tc("errors.network"));
      } else {
        setFormError(err instanceof ApiError ? err.message : tc("errors.generic"));
      }
    }
  }

  function onAccount({ name, email, password }: AccountValues) {
    setAccount({ name: name.trim(), email, password });
    setFormError(null);
    setStep("project");
  }

  function onProject({ projectName, slug, patterns: items }: ProjectValues) {
    const repoPatterns = [...new Set(items.map((p) => p.value).filter(Boolean))];
    return submit({ name: projectName, slug, repoPatterns });
  }

  const accountErrors = accountForm.formState.errors;
  const projectErrors = projectForm.formState.errors;
  const pending = setup.isPending;

  const errorAlert = formError && (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{formError}</AlertDescription>
    </Alert>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{t("setup.title")}</CardTitle>
        <CardDescription>{t(`setup.descriptions.${step}`)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {alreadySetup ? (
          <div className="flex flex-col gap-4">
            <Alert>
              <AlertDescription>{t("setup.alreadySetup")}</AlertDescription>
            </Alert>
            <Button render={<Link href="/login" />} className="w-full">
              {t("setup.goToLogin")}
            </Button>
          </div>
        ) : (
          <>
            <StepIndicator step={step} />
            {step === "account" && (
              <form onSubmit={accountForm.handleSubmit(onAccount)} noValidate>
                <FieldGroup>
                  <Field data-invalid={!!accountErrors.name}>
                    <FieldLabel htmlFor="name">{t("setup.name")}</FieldLabel>
                    <Input
                      id="name"
                      autoComplete="name"
                      autoFocus
                      aria-invalid={!!accountErrors.name}
                      {...accountForm.register("name")}
                    />
                    <FieldError errors={[accountErrors.name]} />
                  </Field>
                  <Field data-invalid={!!accountErrors.email}>
                    <FieldLabel htmlFor="email">{t("setup.email")}</FieldLabel>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      aria-invalid={!!accountErrors.email}
                      {...accountForm.register("email")}
                    />
                    <FieldError errors={[accountErrors.email]} />
                  </Field>
                  <Field data-invalid={!!accountErrors.password}>
                    <FieldLabel htmlFor="password">{t("setup.password")}</FieldLabel>
                    <Input
                      id="password"
                      type="password"
                      autoComplete="new-password"
                      aria-invalid={!!accountErrors.password}
                      {...accountForm.register("password")}
                    />
                    <FieldError errors={[accountErrors.password]} />
                  </Field>
                  <Field data-invalid={!!accountErrors.confirmPassword}>
                    <FieldLabel htmlFor="confirmPassword">{t("setup.confirmPassword")}</FieldLabel>
                    <Input
                      id="confirmPassword"
                      type="password"
                      autoComplete="new-password"
                      aria-invalid={!!accountErrors.confirmPassword}
                      {...accountForm.register("confirmPassword")}
                    />
                    <FieldError errors={[accountErrors.confirmPassword]} />
                  </Field>
                  <Button type="submit" className="w-full">
                    {t("setup.next")}
                  </Button>
                </FieldGroup>
              </form>
            )}

            {step === "project" && (
              <form onSubmit={projectForm.handleSubmit(onProject)} noValidate>
                <FieldGroup>
                  {errorAlert}
                  <Field data-invalid={!!projectErrors.projectName}>
                    <FieldLabel htmlFor="projectName">{t("setup.projectName")}</FieldLabel>
                    <Input
                      id="projectName"
                      autoFocus
                      autoComplete="off"
                      aria-invalid={!!projectErrors.projectName}
                      {...projectForm.register("projectName", {
                        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                          if (!slugTouched) {
                            projectForm.setValue("slug", suggestSlug(e.target.value));
                          }
                        },
                      })}
                    />
                    <FieldError errors={[projectErrors.projectName]} />
                  </Field>
                  <Field data-invalid={!!projectErrors.slug}>
                    <FieldLabel htmlFor="slug">{t("setup.slug")}</FieldLabel>
                    <Input
                      id="slug"
                      autoComplete="off"
                      placeholder="acme-web"
                      aria-invalid={!!projectErrors.slug}
                      {...projectForm.register("slug", { onChange: () => setSlugTouched(true) })}
                    />
                    <FieldError errors={[projectErrors.slug]} />
                  </Field>
                  <fieldset className="flex flex-col gap-2" data-invalid={!!projectErrors.patterns}>
                    <legend className="mb-1 text-sm font-medium">{t("setup.repoPatterns")}</legend>
                    <p className="text-muted-foreground text-xs">{t("setup.repoPatternsHint")}</p>
                    {patterns.fields.map((field, index) => (
                      <div key={field.id} className="flex gap-2">
                        <Input
                          aria-label={t("setup.repoPatternN", { n: index + 1 })}
                          placeholder="github.com/acme/*"
                          autoComplete="off"
                          {...projectForm.register(`patterns.${index}.value`)}
                        />
                        {patterns.fields.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={t("setup.removePattern", { n: index + 1 })}
                            onClick={() => patterns.remove(index)}
                          >
                            <XIcon />
                          </Button>
                        )}
                      </div>
                    ))}
                    {patterns.fields.length < MAX_PATTERNS && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="self-start"
                        onClick={() => patterns.append({ value: "" })}
                      >
                        <PlusIcon />
                        {t("setup.addPattern")}
                      </Button>
                    )}
                    <FieldError errors={[projectErrors.patterns?.root ?? projectErrors.patterns]} />
                  </fieldset>
                  <Button type="submit" className="w-full" disabled={pending}>
                    {pending ? t("setup.submitting") : t("setup.submit")}
                  </Button>
                  <div className="flex flex-wrap justify-between gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => {
                        setFormError(null);
                        setStep("account");
                      }}
                    >
                      {t("setup.back")}
                    </Button>
                    <Button type="button" variant="ghost" disabled={pending} onClick={() => submit()}>
                      {t("setup.skipProject")}
                    </Button>
                  </div>
                </FieldGroup>
              </form>
            )}

            {step === "done" && invite && (
              <div className="flex flex-col gap-4">
                <Alert>
                  <AlertDescription>{t("setup.inviteExplain")}</AlertDescription>
                </Alert>
                <CopyField label={t("setup.inviteUrl")} value={invite.url} />
                <CopyField label={t("setup.installCommand")} value={invite.installCommand} />
                <CopyField label={t("setup.joinCommand")} value={joinCommand(invite.url)} />
                <p className="text-muted-foreground text-xs">{t("setup.inviteLater")}</p>
                <Button className="w-full" onClick={goToDashboard}>
                  {t("setup.goToDashboard")}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
