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
