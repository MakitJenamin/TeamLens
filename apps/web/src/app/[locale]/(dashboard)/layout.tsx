import { setRequestLocale } from "next-intl/server";
import { AppSidebar } from "@/components/dashboard/app-sidebar";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { redirect } from "@/i18n/navigation";
import { serverApi, serverApiOrNull } from "@/lib/api/server";
import type { MeResponse, ProjectSummary } from "@/lib/api/types";

export default async function DashboardLayout({
  children,
  params,
}: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  setRequestLocale(locale);

  // Cookie hết hạn hoặc bị thu hồi → về trang đăng nhập.
  const me = await serverApiOrNull<MeResponse>("/auth/me");
  if (!me) {
    return redirect({ href: "/login", locale });
  }
  const projects = await serverApi<ProjectSummary[]>("/projects");

  return (
    <SidebarProvider>
      <AppSidebar user={me.user} projects={projects} />
      <SidebarInset>
        <header className="bg-background/95 supports-backdrop-filter:bg-background/80 sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur sm:px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          <div className="flex-1" />
          <LocaleSwitcher />
        </header>
        <div className="flex flex-1 flex-col p-4 sm:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
