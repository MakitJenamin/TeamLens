import {
  ActivityIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  ShieldIcon,
  TrophyIcon,
  UserIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  /** khóa dịch trong namespace "nav" */
  key: "overview" | "members" | "sessions" | "leaderboard" | "rules" | "me" | "admin";
  href: string;
  icon: LucideIcon;
}

/** Link theo project (đủ cả 5 màn hình, kể cả khi chưa làm xong). */
export function projectNavItems(projectId: string): NavItem[] {
  const base = `/projects/${encodeURIComponent(projectId)}`;
  return [
    { key: "overview", href: `${base}/overview`, icon: LayoutDashboardIcon },
    { key: "members", href: `${base}/members`, icon: UsersIcon },
    { key: "sessions", href: `${base}/sessions`, icon: ActivityIcon },
    { key: "leaderboard", href: `${base}/leaderboard`, icon: TrophyIcon },
    { key: "rules", href: `${base}/rules`, icon: ListChecksIcon },
  ];
}

/** Link chung; "Quản trị" chỉ hiện với admin. */
export function generalNavItems(isAdmin: boolean): NavItem[] {
  const items: NavItem[] = [{ key: "me", href: "/me", icon: UserIcon }];
  if (isAdmin) items.push({ key: "admin", href: "/admin", icon: ShieldIcon });
  return items;
}

/** Link đang active nếu pathname trùng hoặc là trang con (vd. sessions/[id]). */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
