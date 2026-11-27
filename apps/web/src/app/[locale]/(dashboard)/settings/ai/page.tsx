import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AgentTokensCard } from "./_components/agent-tokens-card";
import { LlmKeyCard } from "./_components/llm-key-card";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/settings/ai">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "aiSettings" });
  return { title: t("title") };
}

/** Cài đặt AI (M6.2, AI_PLAN mục 4): API key BYO của tôi + token `tlp_` cho agent. Leader và member như nhau. */
export default async function AiSettingsPage({ params }: PageProps<"/[locale]/settings/ai">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("aiSettings");

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <LlmKeyCard />
      <AgentTokensCard />
    </main>
  );
}
