"use client";

import type { AgentToken, CreatedAgentToken, LlmKey, RequestBody, ResponseBody } from "@teamlens/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiFetch } from "@/lib/api/client";

export type { AgentToken, CreatedAgentToken, LlmKey };
export type LlmProvider = LlmKey["provider"];
export type PutLlmKeyRequest = RequestBody<"putMyLlmKey">;
export type TestLlmKeyRequest = RequestBody<"testMyLlmKey">;
export type LlmKeyTestResult = ResponseBody<"testMyLlmKey", 200>;

export const aiSettingsKeys = {
  llmKey: ["me", "llm-key"] as const,
  agentTokens: ["me", "agent-tokens"] as const,
};

/** API key AI của chính người đang đăng nhập (không bao giờ có key nguyên văn, chỉ `keyHint`). */
export function useLlmKey() {
  return useQuery({
    queryKey: aiSettingsKeys.llmKey,
    queryFn: async () => (await api.get<{ key: LlmKey | null }>("/me/llm-key")).key,
  });
}

export function useSaveLlmKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PutLlmKeyRequest) => apiFetch<{ key: LlmKey }>("/me/llm-key", { method: "PUT", body }),
    onSuccess: (res) => client.setQueryData(aiSettingsKeys.llmKey, res.key),
  });
}

export function useDeleteLlmKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>("/me/llm-key"),
    onSuccess: () => client.setQueryData(aiSettingsKeys.llmKey, null),
  });
}

export function useTestLlmKey() {
  return useMutation({
    mutationFn: (body: TestLlmKeyRequest) => api.post<LlmKeyTestResult>("/me/llm-key/test", body),
  });
}

export function useAgentTokens() {
  return useQuery({
    queryKey: aiSettingsKeys.agentTokens,
    queryFn: async () => (await api.get<{ tokens: AgentToken[] }>("/me/agent-tokens")).tokens,
  });
}

export function useCreateAgentToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post<CreatedAgentToken>("/me/agent-tokens", { name }),
    onSuccess: () => client.invalidateQueries({ queryKey: aiSettingsKeys.agentTokens }),
  });
}

export function useRevokeAgentToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => api.delete<void>(`/me/agent-tokens/${encodeURIComponent(tokenId)}`),
    onSuccess: () => client.invalidateQueries({ queryKey: aiSettingsKeys.agentTokens }),
  });
}
