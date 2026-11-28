import {
  ActivityIcon,
  LayoutDashboardIcon,
  LightbulbIcon,
  ListChecksIcon,
  ShieldIcon,
  SparklesIcon,
  TrophyIcon,
  UserIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  /** khóa dịch trong namespace "nav" */
  key: "overview" | "members" | "sessions" | "skills" | "leaderboard" | "rules" | "me" | "aiSettings" | "admin";
  href: string;
  icon: LucideIcon;
}

/** Link theo project (đủ cả các màn hình, kể cả khi chưa làm xong). */
export function projectNavItems(projectId: string): NavItem[] {
  const base = `/projects/${encodeURIComponent(projectId)}`;
  return [
    { key: "overview", href: `${base}/overview`, icon: LayoutDashboardIcon },
    { key: "members", href: `${base}/members`, icon: UsersIcon },
    { key: "sessions", href: `${base}/sessions`, icon: ActivityIcon },
    { key: "skills", href: `${base}/skills`, icon: LightbulbIcon },
    { key: "leaderboard", href: `${base}/leaderboard`, icon: TrophyIcon },
    { key: "rules", href: `${base}/rules`, icon: ListChecksIcon },
  ];
}

/** Link chung; "Cài đặt AI" mọi người đều thấy, "Quản trị" chỉ hiện với leader. */
export function generalNavItems(isLeader: boolean): NavItem[] {
  const items: NavItem[] = [
    { key: "me", href: "/me", icon: UserIcon },
    { key: "aiSettings", href: "/settings/ai", icon: SparklesIcon },
  ];
  if (isLeader) items.push({ key: "admin", href: "/admin", icon: ShieldIcon });
  return items;
}

/** Link đang active nếu pathname trùng hoặc là trang con (vd. sessions/[id]). */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
