import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PagePlaceholder } from "@/components/dashboard/page-placeholder";

export async function generateMetadata({ params }: PageProps<"/[locale]/admin">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin" });
  return { title: t("title") };
}

export default async function AdminPage({ params }: PageProps<"/[locale]/admin">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("admin");

  return <PagePlaceholder title={t("title")} description={t("description")} task="B1/B5" />;
}
