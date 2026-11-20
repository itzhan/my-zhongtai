"use client";

import { useCallback, useEffect, useState } from "react";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";

import { get, qs } from "./api";
import type {
  Account,
  Alert,
  Customer,
  CustomerOverview,
  Group,
  MonitorResp,
  Supplier,
  SupplierMonitor,
  SupplierWallet,
  VerifyAccountInspect,
  VerifyChannel,
  VerifyRun,
} from "./types";

export const qk = {
  env: ["ops", "env"] as const,
  meta: ["ops", "meta"] as const,
  alerts: ["ops", "alerts"] as const,
  customers: ["ops", "customers"] as const,
  overview: (id: string) => ["ops", "overview", id] as const,
  channels: (id: string) => ["ops", "channels", id] as const,
  accounts: ["ops", "accounts"] as const,
  accountFull: (id: number) => ["ops", "account-full", id] as const,
  schedOverview: ["ops", "sched-overview"] as const,
  schedGroup: (id: number) => ["ops", "sched-group", id] as const,
  audit: ["ops", "audit"] as const,
  monitor: (range: string, ids: string) => ["ops", "monitor", range, ids] as const,
  suppliers: (q: string, category: string) => ["ops", "suppliers", q, category] as const,
  supplier: (id: number) => ["ops", "supplier", id] as const,
  supplierMonitors: ["ops", "supplier-monitors"] as const,
  supplierWallets: (supplierId: number) => ["ops", "supplier-wallets", supplierId] as const,
  verifyChannels: ["ops", "verify-channels"] as const,
  verifyChannel: (code: string) => ["ops", "verify-channel", code] as const,
  verifyInspect: (id: number) => ["ops", "verify-inspect", id] as const,
  verifyInspectBatch: (ids: string) => ["ops", "verify-inspect", "batch", ids] as const,
  verifyRuns: (q: string) => ["ops", "verify-runs", q] as const,
  verifyRun: (id: string) => ["ops", "verify-run", id] as const,
};

export const useEnv = () =>
  useQuery({ queryKey: qk.env, queryFn: () => get<{ readonly: boolean; jobs: string }>("/env"), staleTime: Infinity });
export const useMeta = () =>
  useQuery({ queryKey: qk.meta, queryFn: () => get<{ groups: Group[] }>("/meta"), retry: false, staleTime: 60_000 });
export const useAlerts = () =>
  useQuery({
    queryKey: qk.alerts,
    queryFn: () => get<{ alerts: Alert[]; lastError: string | null }>("/alerts"),
    refetchInterval: 30_000,
  });

export const useCustomers = () => useQuery({ queryKey: qk.customers, queryFn: () => get<Customer[]>("/customers") });
export const useCustomerOverview = (id: string) =>
  useQuery({
    queryKey: qk.overview(id),
    queryFn: () => get<CustomerOverview>(`/customers/${id}/overview`),
    staleTime: 60_000,
  });
export const useCustomerChannels = (id: string, enabled = true) =>
  useQuery({
    queryKey: qk.channels(id),
    queryFn: () => get<{ groups:(Group & { key_count: number })[]; accounts: Account[] }>(`/customers/${id}/channels`),
    enabled,
  });

export const useAccounts = () => useQuery({ queryKey: qk.accounts, queryFn: () => get<Account[]>("/accounts") });

// 延迟监控条：ids 为空 = 全部账号；每分钟自动刷新
export const useMonitor = (range: string, ids: number[] = []) => {
  const idStr = [...ids].sort((a, b) => a - b).join(",");
  return useQuery({
    queryKey: qk.monitor(range, idStr),
    queryFn: () => get<MonitorResp>(`/monitor/accounts?${qs({ range, ids: idStr })}`),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
};

export const useSuppliers = (q: string, category: string) =>
  useQuery({
    queryKey: qk.suppliers(q, category),
    queryFn: () => get<Supplier[]>(`/suppliers?${qs({ q, category })}`),
    placeholderData: keepPreviousData,
  });
export const useSupplier = (id: number) =>
  useQuery({
    queryKey: qk.supplier(id),
    queryFn: () => get<Supplier & { monitors: SupplierMonitor[] }>(`/suppliers/${id}`),
    retry: false,
  });
export const useSupplierWallets = (supplierId = 0) =>
  useQuery({
    queryKey: qk.supplierWallets(supplierId),
    queryFn: () => get<SupplierWallet[]>(`/supplier-wallets${supplierId ? `?supplier_id=${supplierId}` : ""}`),
  });
export const useSupplierMonitors = () =>
  useQuery({
    queryKey: qk.supplierMonitors,
    queryFn: () => get<SupplierMonitor[]>("/supplier-monitors"),
    refetchInterval: 60_000,
  });

// 渠道鉴定（渠道真伪检测）
export const useVerifyChannels = () =>
  useQuery({
    queryKey: qk.verifyChannels,
    queryFn: () => get<VerifyChannel[]>("/verify/channels"),
  });

export const useVerifyChannel = (code: string) =>
  useQuery({
    queryKey: qk.verifyChannel(code),
    queryFn: () => get<VerifyChannel>(`/verify/channels/${encodeURIComponent(code)}`),
    enabled: Boolean(code),
  });

export const useVerifyAccountInspect = (accountId: number | null) =>
  useQuery({
    queryKey: qk.verifyInspect(accountId ?? 0),
    queryFn: () => get<VerifyAccountInspect>(`/verify/accounts/${accountId}/inspect`),
    enabled: Boolean(accountId && accountId > 0),
    retry: false,
  });

export const useVerifyAccountsInspect = (ids: number[]) => {
  const key = [...ids].sort((a, b) => a - b).join(",");
  return useQuery({
    queryKey: qk.verifyInspectBatch(key),
    queryFn: () => get<VerifyAccountInspect[]>(`/verify/accounts/inspect?ids=${key}`),
    enabled: ids.length > 0,
    retry: false,
  });
};

export const useVerifyRuns = (filters: { channel_code?: string; verdict?: string; q?: string } = {}) => {
  const query = qs(filters);
  return useQuery({
    queryKey: qk.verifyRuns(query),
    queryFn: () => get<VerifyRun[]>(`/verify/runs${query ? `?${query}` : ""}`),
    placeholderData: keepPreviousData,
  });
};

export function useVerifyRun(runId: string | null) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: qk.verifyRun(runId ?? ""),
    queryFn: () => get<VerifyRun>(`/verify/runs/${runId}`),
    enabled: Boolean(runId),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 600 : false),
  });
  const status = q.data?.status;
  useEffect(() => {
    if (status === "done" || status === "error") {
      void qc.invalidateQueries({ queryKey: ["ops", "verify-runs"] });
    }
  }, [status, qc]);
  return q;
}

// 写操作后刷新某一类数据（前缀匹配）
export function useInvalidate() {
  const qc = useQueryClient();
  return useCallback((...keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: ["ops", k] })), [qc]);
}

// 当前时间（每 30 秒更新）：渲染时判断「限流是否已过期」等，不在渲染期直接调用 Date.now()
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
