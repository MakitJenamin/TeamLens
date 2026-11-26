"use client";

import { CheckIcon, ChevronsUpDownIcon, FolderKanbanIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { useRouter } from "@/i18n/navigation";
import type { ProjectSummary } from "@/lib/api/types";

export function ProjectSwitcher({
  projects,
  currentProjectId,
}: {
  projects: ProjectSummary[];
  currentProjectId?: string;
}) {
  const t = useTranslations("nav");
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const current = projects.find((p) => p.id === currentProjectId);

  function roleLabel(p: ProjectSummary) {
    return p.isMember ? t("roles.member") : t("notMember");
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" aria-label={t("selectProject")} />}
            disabled={projects.length === 0}
          >
            <span className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
              <FolderKanbanIcon className="size-4" />
            </span>
            <span className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">
                {current?.name ?? (projects.length ? t("selectProject") : t("noProjects"))}
              </span>
              <span className="text-muted-foreground truncate text-xs">
                {current ? roleLabel(current) : t("project")}
              </span>
            </span>
            <ChevronsUpDownIcon className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("project")}</DropdownMenuLabel>
              {projects.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() => {
                    setOpenMobile(false);
                    router.push(`/projects/${encodeURIComponent(p.id)}/overview`);
                  }}
                >
                  <span className="flex flex-1 flex-col">
                    <span className="truncate">{p.name}</span>
                    <span className="text-muted-foreground text-xs">{roleLabel(p)}</span>
                  </span>
                  {p.id === currentProjectId && <CheckIcon />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
