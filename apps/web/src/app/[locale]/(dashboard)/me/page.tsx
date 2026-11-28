import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { serverApiOrNull } from "@/lib/api/server";
import type { MeResponse } from "@/lib/api/types";
import { MyDataPanel } from "./my-data-panel";

export async function generateMetadata({ params }: PageProps<"/[locale]/me">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "me" });
  return { title: t("title") };
}

export default async function MePage({ params }: PageProps<"/[locale]/me">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("me");
  const me = await serverApiOrNull<MeResponse>("/auth/me");
  if (!me) return redirect({ href: "/login", locale });

  return <div className="space-y-6">
    <div><h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-muted-foreground mt-2 max-w-3xl text-sm">{t("description")}</p></div>
    <MyDataPanel name={me.user.name} role={me.user.role} />
  </div>;
}
