import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { CliLogin } from "@/components/auth/cli-login";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/auth/cli">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: t("cli.title"), robots: { index: false } };
}

/** Đích của `tl open`: `/auth/cli?ticket=<ticket một lần>` (SPEC 7.1, J.6). Trang công khai. */
export default async function CliAuthPage({ params, searchParams }: PageProps<"/[locale]/auth/cli">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { ticket } = await searchParams;
  return <CliLogin ticket={typeof ticket === "string" ? ticket : ""} />;
}
