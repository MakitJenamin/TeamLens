"use client";

import { useState, useTransition } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { ResponseBody } from "@teamlens/schema";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/hooks";
import type { User } from "@/lib/api/types";

type UserErasure = ResponseBody<"eraseUser", 200>;

/**
 * Nút "Xóa dữ liệu" trên mỗi dòng tài khoản (task M5.6): hộp xác nhận bắt gõ đúng tên
 * rồi gọi `DELETE /admin/users/{id}`. Không hiện cho chính người đang đăng nhập.
 */
export function EraseUser({ user, currentUserId }: { user: User; currentUserId: string }) {
  const t = useTranslations("admin");
  const router = useRouter();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [refreshing, startTransition] = useTransition();
  const mutation = useMutation({
    mutationFn: () => api.delete<UserErasure>(`/admin/users/${user.id}`),
    onSuccess: () => {
      setOpen(false);
      void client.invalidateQueries({ queryKey: queryKeys.projects });
      startTransition(() => router.refresh());
      toast.success(t("eraseDone", { name: user.name }));
    },
  });

  if (user.id === currentUserId) return null;
  const busy = mutation.isPending || refreshing;
  const matches = typed.trim() === user.name.trim();

  return (
    <>
      <Button
        variant="destructive"
        onClick={() => {
          setTyped("");
          mutation.reset();
          setOpen(true);
        }}
      >
        {t("erase")}
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <AlertDialogContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (matches && !busy) mutation.mutate();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{t("confirmErase", { name: user.name })}</AlertDialogTitle>
            </AlertDialogHeader>
            <label className="grid gap-1 text-sm font-medium">
              {t("eraseTypeName")}
              <Input
                value={typed}
                autoComplete="off"
                onChange={(event) => setTyped(event.target.value)}
              />
            </label>
            {mutation.error && (
              <p role="alert" className="text-sm text-destructive">
                {mutation.error.message}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>{t("cancel")}</AlertDialogCancel>
              <Button type="submit" variant="destructive" disabled={!matches || busy}>
                {t("erase")}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
