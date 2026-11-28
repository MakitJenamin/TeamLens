"use client";

import { useState, useTransition } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/hooks";
import type { ResponseBody } from "@teamlens/schema";
import type { User } from "@/lib/api/types";

type MergeResult = ResponseBody<"mergeUser", 200>;

/**
 * Đích gộp hợp lệ cho `user`: không phải chính nó; member gộp được vào member hoặc leader,
 * leader chỉ gộp vào leader (API trả 409 `role_mismatch` nếu gộp leader vào member).
 */
export function mergeTargets(user: User, users: User[]): User[] {
  return users.filter((u) => u.id !== user.id && (user.role === "member" || u.role === "leader"));
}

/** Nút "Gộp vào…" trên mỗi dòng tài khoản: chọn user giữ lại, xác nhận rồi gọi API gộp (task J.8). */
export function MergeUser({ user, users }: { user: User; users: User[] }) {
  const t = useTranslations("admin");
  const router = useRouter();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const targets = mergeTargets(user, users);
  const [intoId, setIntoId] = useState("");
  const mutation = useMutation({
    mutationFn: (intoUserId: string) =>
      api.post<MergeResult>(`/users/${user.id}/merge`, { intoUserId }),
    onSuccess: (result) => {
      setOpen(false);
      void client.invalidateQueries({ queryKey: queryKeys.projects });
      startTransition(() => router.refresh());
      toast.success(t("mergeDone", { name: result.user.name, ...result.moved }));
    },
  });

  if (targets.length === 0) return null;
  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        {t("mergeInto")}
      </Button>
    );
  }

  const selected = intoId || targets[0].id;
  const target = targets.find((u) => u.id === selected);
  return (
    <form
      className="w-full"
      onSubmit={(event) => {
        event.preventDefault();
        if (target && window.confirm(t("confirmMerge", { from: user.name, into: target.name }))) {
          mutation.mutate(target.id);
        }
      }}
    >
      <fieldset
        disabled={mutation.isPending || refreshing}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="grid gap-1 text-sm font-medium">
          {t("mergeTarget")}
          <select
            className="h-8 rounded-lg border bg-background px-2 text-sm"
            value={selected}
            onChange={(event) => setIntoId(event.target.value)}
          >
            {targets.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role === "leader" ? t("leader") : t("member")})
                {u.email ? ` · ${u.email}` : ""}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="destructive">
          {t("merge")}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t("cancel")}
        </Button>
      </fieldset>
      {mutation.error && (
        <p role="alert" className="mt-1 text-sm text-destructive">
          {mutation.error.message}
        </p>
      )}
    </form>
  );
}
