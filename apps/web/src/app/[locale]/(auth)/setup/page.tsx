import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { SetupForm } from "@/components/auth/setup-form";
import { redirect } from "@/i18n/navigation";
import { fetchNeedsSetup } from "@/lib/api/server";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/setup">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: t("setup.title") };
}

export default async function SetupPage({ params }: PageProps<"/[locale]/setup">) {
  const { locale } = await params;
  setRequestLocale(locale);

  // Chỉ hiện khi máy chủ chưa có user nào. Không gọi được API thì vẫn hiện form,
  // API sẽ trả 409 already_setup nếu đã thiết lập.
  if ((await fetchNeedsSetup()) === false) {
    redirect({ href: "/login", locale });
  }

  return <SetupForm />;
}
