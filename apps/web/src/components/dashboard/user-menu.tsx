"use client";

import { ChevronsUpDownIcon, LogOutIcon, UserIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { useRouter } from "@/i18n/navigation";
import { useLogout } from "@/lib/api/hooks";
import type { User } from "@/lib/api/types";

export function initials(name: string, email: string | null): string {
  const source = name.trim() || email || "?";
  const parts = source.split(/\s+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

export function UserMenu({ user }: { user: User }) {
  const t = useTranslations("nav");
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const logout = useLogout();

  async function onLogout() {
    try {
      await logout.mutateAsync();
    } catch {
      toast.error(t("logoutFailed"));
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
            <Avatar className="size-8 rounded-lg">
              <AvatarFallback className="rounded-lg">{initials(user.name, user.email)}</AvatarFallback>
            </Avatar>
            <span className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="text-muted-foreground truncate text-xs">{user.email}</span>
            </span>
            <ChevronsUpDownIcon className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <span className="block truncate font-medium">{user.name}</span>
                <span className="text-muted-foreground block truncate text-xs">{user.email}</span>
                {user.role === "leader" && <span className="text-muted-foreground text-xs">{t("roles.leader")}</span>}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                setOpenMobile(false);
                router.push("/me");
              }}
            >
              <UserIcon />
              {t("me")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onLogout} disabled={logout.isPending}>
              <LogOutIcon />
              {t("logout")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
