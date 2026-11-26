"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type {
  DeviceApproveRequest,
  DeviceApproveResponse,
  ExchangeTicketRequest,
  ExchangeTicketResponse,
  LoginRequest,
  MeResponse,
  ProjectSummary,
  SetupRequest,
  SetupResponse,
  UserResponse,
} from "./types";

export const queryKeys = {
  me: ["auth", "me"] as const,
  projects: ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  devices: ["devices"] as const,
  invites: (projectId: string) => ["projects", projectId, "invites"] as const,
};

export function useMe(initialData?: MeResponse) {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api.get<MeResponse>("/auth/me"),
    initialData,
  });
}

export function useProjects(initialData?: ProjectSummary[]) {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => api.get<ProjectSummary[]>("/projects"),
    initialData,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api.post<UserResponse>("/auth/login", body),
    onSuccess: () => queryClient.clear(),
  });
}

export function useSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SetupRequest) => api.post<SetupResponse>("/setup", body),
    onSuccess: () => queryClient.clear(),
  });
}

/** Đổi ticket một lần của `tl open` lấy cookie phiên dashboard. */
export function useExchangeTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ExchangeTicketRequest) =>
      api.post<ExchangeTicketResponse>("/auth/ticket", body),
    onSuccess: () => queryClient.clear(),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/auth/logout"),
    onSettled: () => queryClient.clear(),
  });
}

export function useApproveDevice() {
  return useMutation({
    mutationFn: (body: DeviceApproveRequest) =>
      api.post<DeviceApproveResponse>("/device/approve", body),
  });
}
