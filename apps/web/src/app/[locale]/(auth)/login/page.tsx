import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { LoginForm } from "@/components/auth/login-form";
import { redirect } from "@/i18n/navigation";
import { fetchNeedsSetup, serverApiOrNull } from "@/lib/api/server";
import type { MeResponse } from "@/lib/api/types";
import { SESSION_COOKIE, resolveNextPath, safeNextPath } from "@/lib/auth-paths";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/login">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: t("login.title") };
}

export default async function LoginPage({ params, searchParams }: PageProps<"/[locale]/login">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { next } = await searchParams;
  const nextPath = typeof next === "string" ? safeNextPath(next) : undefined;

  // Máy chủ chưa có user nào → chuyển sang trang tạo admin đầu tiên.
  if ((await fetchNeedsSetup()) === true) {
    redirect({ href: "/setup", locale });
  }

  // Đã đăng nhập (cookie còn hiệu lực) thì không cần hiện form.
  if ((await cookies()).has(SESSION_COOKIE)) {
    const me = await serverApiOrNull<MeResponse>("/auth/me").catch(() => null);
    if (me) {
      // ?next= đã có sẵn prefix locale: tách ra rồi redirect đúng locale đó.
      if (nextPath) redirect(resolveNextPath(nextPath));
      redirect({ href: "/", locale });
    }
  }

  return <LoginForm next={nextPath} />;
}
