"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorIcon, UserPlusIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import type { Device, MemberStatus, MemberStatusList } from "@teamlens/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api/client";
import type { User } from "@/lib/api/types";
import { MergeUser } from "../../../../admin/merge-user";
import { deviceBadge, isRecentJoin, RECENT_JOIN_DAYS } from "./device-status";

export const memberStatusKey = (projectId: string) => ["projects", projectId, "member-status"] as const;

type Props = {
  projectId: string;
  currentUserId: string;
  initialData: MemberStatusList;
  /** Mọi tài khoản (`GET /users`) để chọn đích "Gộp vào…". */
  users: User[];
};

/**
 * Trang Thành viên (M4.2): người mới tham gia 7 ngày, mỗi thành viên kèm thiết bị và trạng thái,
 * thu hồi thiết bị, xóa khỏi project, "Gộp vào…" (dùng lại `MergeUser` của trang quản trị).
 * Query key nằm dưới `["projects"]` nên `MergeUser` (invalidate `projects`) cũng làm mới danh sách.
 */
export function MembersPanel({ projectId, currentUserId, initialData, users }: Props) {
  const t = useTranslations("members");
  const format = useFormatter();
  // Cố định thời điểm mở trang để nhãn "Offline N giờ" không nhảy theo từng lần render.
  const [now] = useState(() => new Date());
  const query = useQuery({
    queryKey: memberStatusKey(projectId),
    queryFn: () => api.get<MemberStatusList>(`/projects/${projectId}/member-status`),
    initialData,
    // Dữ liệu từ server component vừa lấy xong: không gọi lại ngay khi mount.
    staleTime: 30_000,
  });
  const items = query.data.items;
  const recent = items.filter((m) => isRecentJoin(m.joinedAt, now));
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: "medium" });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlusIcon className="size-4" aria-hidden />
            {t("recent.title", { days: RECENT_JOIN_DAYS })}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("recent.empty")}</p>
          ) : (
            <ul aria-label={t("recent.title", { days: RECENT_JOIN_DAYS })} className="flex flex-wrap gap-2">
              {recent.map((m) => (
                <li key={m.userId}>
                  <a
                    href={`#member-${m.userId}`}
                    className="hover:bg-muted inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm"
                  >
                    <span className="font-medium">{m.name}</span>
                    <span className="text-muted-foreground text-xs">{t("joinedOn", { date: date(m.joinedAt) })}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <section aria-labelledby="members-list" className="flex flex-col gap-3">
        <h2 id="members-list" className="text-lg font-semibold">
          {t("list.title", { count: items.length })}
        </h2>
        {items.map((member) => (
          <MemberCard
            key={member.userId}
            projectId={projectId}
            member={member}
            isSelf={member.userId === currentUserId}
            users={users}
            now={now}
          />
        ))}
      </section>
    </div>
  );
}

function MemberCard({
  projectId,
  member,
  isSelf,
  users,
  now,
}: {
  projectId: string;
  member: MemberStatus;
  isSelf: boolean;
  users: User[];
  now: Date;
}) {
  const t = useTranslations("members");
  const format = useFormatter();
  const client = useQueryClient();
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: "medium" });
  const remove = useMutation({
    mutationFn: () => api.delete<void>(`/projects/${projectId}/members/${member.userId}`),
    onSuccess: () => {
      toast.success(t("removeDone", { name: member.name }));
      void client.invalidateQueries({ queryKey: memberStatusKey(projectId) });
    },
    onError: (error) => toast.error(error.message),
  });
  const user: User = { id: member.userId, name: member.name, email: member.email, role: member.role };

  return (
    <Card id={`member-${member.userId}`} aria-label={member.name} className="scroll-mt-4">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>
            <Link href={`/projects/${projectId}/members/${member.userId}`} className="underline-offset-4 hover:underline">
              {member.name}
            </Link>
          </CardTitle>
          <Badge variant={member.role === "leader" ? "default" : "secondary"}>{t(`role.${member.role}`)}</Badge>
          {isRecentJoin(member.joinedAt, now) && <Badge variant="outline">{t("newBadge")}</Badge>}
        </div>
        <CardDescription className="flex flex-wrap gap-x-4 gap-y-1">
          {member.email && <span>{member.email}</span>}
          <span>{t("joinedOn", { date: date(member.joinedAt) })}</span>
          <span>
            {member.lastSessionAt
              ? t("lastSession", { date: date(member.lastSessionAt) })
              : t("noSession")}
          </span>
        </CardDescription>
        <div className="flex flex-wrap items-start gap-2">
          <Button
            variant="outline"
            render={<Link href={`/projects/${projectId}/members/${member.userId}`} />}
            nativeButton={false}
          >
            {t("profile")}
          </Button>
          {!isSelf && (
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(t("confirmRemove", { name: member.name }))) remove.mutate();
              }}
            >
              {t("remove")}
            </Button>
          )}
          <MergeUser user={user} users={users} />
        </div>
      </CardHeader>
      <CardContent>
        {member.devices.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noDevices")}</p>
        ) : (
          <ul aria-label={t("devices")} className="divide-y rounded-lg border">
            {member.devices.map((device) => (
              <DeviceRow key={device.id} projectId={projectId} device={device} now={now} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DeviceRow({ projectId, device, now }: { projectId: string; device: Device; now: Date }) {
  const t = useTranslations("members");
  const client = useQueryClient();
  const badge = deviceBadge(device, now);
  const revoke = useMutation({
    mutationFn: () => api.post<void>(`/devices/${device.id}/revoke`),
    onSuccess: () => {
      toast.success(t("revokeDone", { name: device.name }));
      void client.invalidateQueries({ queryKey: memberStatusKey(projectId) });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <li aria-label={device.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <MonitorIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{device.name}</p>
          <p className="text-muted-foreground text-xs">
            {device.os} · tl {device.cliVersion}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={badge.variant}>{"count" in badge ? t(`status.${badge.key}`, { count: badge.count }) : t(`status.${badge.key}`)}</Badge>
        {!device.revokedAt && (
          <Button
            size="sm"
            variant="outline"
            disabled={revoke.isPending}
            onClick={() => {
              if (window.confirm(t("confirmRevoke", { name: device.name }))) revoke.mutate();
            }}
          >
            {t("revoke")}
          </Button>
        )}
      </div>
    </li>
  );
}
