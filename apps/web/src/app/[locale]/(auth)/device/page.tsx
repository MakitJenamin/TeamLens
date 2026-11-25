import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DeviceForm } from "@/components/auth/device-form";
import { getPathname, redirect } from "@/i18n/navigation";
import { serverApiOrNull } from "@/lib/api/server";
import type { MeResponse } from "@/lib/api/types";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/device">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "device" });
  return { title: t("title") };
}

export default async function DevicePage({ params, searchParams }: PageProps<"/[locale]/device">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { code } = await searchParams;
  const initialCode = typeof code === "string" ? code : "";

  // Proxy đã chặn trường hợp thiếu cookie; ở đây kiểm tra cookie còn hiệu lực.
  // Nếu API không phản hồi thì vẫn hiện form (lỗi sẽ hiện khi bấm xác nhận).
  const me = await serverApiOrNull<MeResponse>("/auth/me").catch(() => undefined);
  if (me === null) {
    const devicePath = getPathname({
      href: { pathname: "/device", query: initialCode ? { code: initialCode } : {} },
      locale,
    });
    redirect({ href: { pathname: "/login", query: { next: devicePath } }, locale });
  }

  return <DeviceForm initialCode={initialCode} />;
}
