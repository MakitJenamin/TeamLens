"use client";

import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Logo } from "@/components/logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Link, usePathname } from "@/i18n/navigation";
import type { ProjectSummary, User } from "@/lib/api/types";
import { generalNavItems, isActivePath, projectNavItems, type NavItem } from "./nav-items";
import { ProjectSwitcher } from "./project-switcher";
import { UserMenu } from "./user-menu";

function NavLinks({ items }: { items: NavItem[] }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();

  return (
    <SidebarMenu>
      {items.map((item) => {
        const label = t(item.key);
        return (
          <SidebarMenuItem key={item.key}>
            <SidebarMenuButton
              isActive={isActivePath(pathname, item.href)}
              tooltip={label}
              render={<Link href={item.href} onClick={() => setOpenMobile(false)} />}
            >
              <item.icon />
              <span>{label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

export function AppSidebar({ user, projects }: { user: User; projects: ProjectSummary[] }) {
  const t = useTranslations("nav");
  const params = useParams<{ projectId?: string }>();
  // Đang ở trang chung (/me, /admin) thì dùng project đầu tiên cho nhóm link project.
  // (giống trang chủ: ưu tiên project mình là thành viên).
  const currentProjectId =
    params.projectId ?? (projects.find((p) => p.role !== null) ?? projects[0])?.id;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link href="/" className="flex h-8 items-center px-2 group-data-[collapsible=icon]:px-0">
          <Logo className="group-data-[collapsible=icon]:[&>span:last-child]:hidden" />
        </Link>
        <ProjectSwitcher projects={projects} currentProjectId={currentProjectId} />
      </SidebarHeader>
      <SidebarContent>
        {currentProjectId && (
          <SidebarGroup>
            <SidebarGroupLabel>{t("project")}</SidebarGroupLabel>
            <SidebarGroupContent>
              <NavLinks items={projectNavItems(currentProjectId)} />
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        <SidebarGroup>
          <SidebarGroupLabel>{t("general")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <NavLinks items={generalNavItems(user.isAdmin)} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <UserMenu user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
