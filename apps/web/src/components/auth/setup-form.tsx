"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api/client";
import { useSetup } from "@/lib/api/hooks";
import { PASSWORD_MIN_LENGTH as PASSWORD_MIN } from "@/lib/api/types";
import { localizePath } from "@/lib/auth-paths";

export function SetupForm() {
  const t = useTranslations("auth");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const setup = useSetup();
  const [formError, setFormError] = useState<string | null>(null);
  const [alreadySetup, setAlreadySetup] = useState(false);

  const schema = z
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
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
  });

  async function onSubmit({ name, email, password }: Values) {
    setFormError(null);
    try {
      await setup.mutateAsync({ name, email, password });
      router.replace(localizePath("/", locale));
      router.refresh();
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

  const { errors, isSubmitting } = form.formState;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{t("setup.title")}</CardTitle>
        <CardDescription>{t("setup.description")}</CardDescription>
      </CardHeader>
      <CardContent>
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
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FieldGroup>
              {formError && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              )}
              <Field data-invalid={!!errors.name}>
                <FieldLabel htmlFor="name">{t("setup.name")}</FieldLabel>
                <Input id="name" autoComplete="name" autoFocus aria-invalid={!!errors.name} {...form.register("name")} />
                <FieldError errors={[errors.name]} />
              </Field>
              <Field data-invalid={!!errors.email}>
                <FieldLabel htmlFor="email">{t("setup.email")}</FieldLabel>
                <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...form.register("email")} />
                <FieldError errors={[errors.email]} />
              </Field>
              <Field data-invalid={!!errors.password}>
                <FieldLabel htmlFor="password">{t("setup.password")}</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={!!errors.password}
                  {...form.register("password")}
                />
                <FieldError errors={[errors.password]} />
              </Field>
              <Field data-invalid={!!errors.confirmPassword}>
                <FieldLabel htmlFor="confirmPassword">{t("setup.confirmPassword")}</FieldLabel>
                <Input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={!!errors.confirmPassword}
                  {...form.register("confirmPassword")}
                />
                <FieldError errors={[errors.confirmPassword]} />
              </Field>
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? t("setup.submitting") : t("setup.submit")}
              </Button>
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
