"use client";

import { useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { get } from "./api";

// 流量监控（后端 server/traffic.js）：多台 sub2api 服务器的实时流量、渠道调度、分组使用、错误排行

export type TrafficSite = {
  id: number;
  name: string;
  base_url: string;
  key_masked: string;
  is_default: boolean;
  // 和本系统连的是同一台 sub2api（有数据库直连），才能看用户实时 RPM
  is_main: boolean;
};

export type TUserRpm = {
  at: string;
  users: {
    user_id: number;
    name: string;
    email: string;
    rpm_limit: number;
    concurrency: number | null;
    rpm: number;
    tpm: number;
    groups: { group_id: number; name: string; rpm: number }[];
  }[];
};

// 用户实时 RPM（近 60 秒滚动窗口，主服务器数据库统计），每 5 秒刷新
export const useUserRpm = (enabled: boolean) =>
  useQuery({
    queryKey: ["ops", "user-rpm"],
    queryFn: () => get<TUserRpm>("/monitor/user-rpm"),
    enabled,
    refetchInterval: 5000,
  });

export type TGroup = { id: number; name: string; platform: string; status: string; rate_multiplier: number };
export type TChannel = {
  id: number;
  name: string;
  platform: string;
  type: string;
  status: string;
  schedulable: boolean;
  priority: number;
  concurrency: number;
  rate_multiplier?: number;
  group_ids: number[];
  error_message: string | null;
  notes: string | null;
  last_used_at: string | null;
};
export type TStructure = { groups: TGroup[]; accounts: TChannel[] };

export type TRealtime = {
  rpm: number | null;
  tpm: number | null;
  account: Record<string, { current_in_use: number; max_capacity: number; waiting_in_queue: number }>;
  at: string;
};
export type TTodayStats = Record<string, { requests: number; tokens?: number; cost: number; user_cost: number }>;
export type TGroupUsage = {
  today: string;
  by_group: Record<string, { cost: number; actual_cost: number; requests: number }>;
};
export type TGroupUsers = {
  today: string;
  groups: {
    group_id: number;
    group_name: string;
    users: { user_id: number; email: string; requests: number; cost: number; actual_cost: number }[];
    error?: string;
  }[];
};
export type TErrorEvent = {
  id: number;
  created_at: string;
  status_code: number;
  model: string;
  requested_model: string;
  message: string;
  group_name: string;
  user_email: string;
  request_id: string;
};
export type TErrorAccount = {
  account_id: number;
  account_name: string;
  count: number;
  share: number;
  by_status: Record<string, number>;
  by_model: Record<string, number>;
  groups: { group_id: number; group_name: string; count: number }[];
  latest_at: string;
  latest_status: number;
  latest_message: string;
  recent: TErrorEvent[];
};
export type TErrorRanking = {
  range: string;
  total: number;
  processed: number;
  truncated: boolean;
  summary: {
    error_rate: number;
    upstream_error_rate: number;
    sla: number;
    request_count: number;
    success_count: number;
    error_count: number;
    upstream_429: number;
    upstream_529: number;
    upstream_other: number;
    health_score: number | null;
    generated_at: string | null;
  } | null;
  accounts: TErrorAccount[];
};

export const ERROR_RANGES: [string, string][] = [
  ["1h", "近 1 小时"],
  ["6h", "近 6 小时"],
  ["24h", "近 24 小时"],
  ["7d", "近 7 天"],
  ["30d", "近 30 天"],
];

const tk = (siteId: number | null, ...rest: unknown[]) => ["ops", "traffic", siteId, ...rest] as const;

// 浏览器本地缓存：刷新页面后先显示上次的数据，同时自动拉最新的（修复旧版「刷新后要手动点刷新才有数据」）
const LS = (siteId: number, name: string) => `ops.traffic.${siteId}.${name}`;
function readLocal<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}
function writeLocal(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // 存不下就算了，只是少了「秒开」
  }
}
// valid：数据结构检查，本地缓存坏了（比如存成了 {}）就丢掉，不让页面崩
function usePersisted<T>(
  siteId: number | null,
  name: string,
  path: string,
  valid: (d: T) => boolean,
  opts: { refetchInterval?: number } = {},
) {
  const ok = (d: T | undefined): d is T => !!d && typeof d === "object" && valid(d);
  return useQuery({
    queryKey: tk(siteId, name),
    queryFn: async () => {
      const d = await get<T>(`/traffic/${siteId}/${path}`);
      if (!ok(d)) throw new Error("返回数据格式不对");
      writeLocal(LS(siteId!, name), d);
      return d;
    },
    enabled: siteId != null,
    // 本地缓存只作为占位：标记为很旧的数据，挂载时一定会重新拉
    initialData: () => {
      if (siteId == null) return undefined;
      const d = readLocal<T>(LS(siteId, name));
      return ok(d) ? d : undefined;
    },
    initialDataUpdatedAt: 0,
    refetchOnMount: "always",
    ...opts,
  });
}

export const useTrafficSites = () =>
  useQuery({ queryKey: ["ops", "traffic", "sites"], queryFn: () => get<TrafficSite[]>("/traffic/sites") });

// 当前选中的监控服务器：监控大盘、渠道两个页面共用，记在浏览器里；没选过 / 已删除时用默认服务器
const SITE_KEY = "ops.traffic.site";
export function useSite() {
  const sites = useTrafficSites();
  const [picked, setPicked] = useState<number | null>(() => Number(readLocal<string>(SITE_KEY)) || null);
  const list = sites.data ?? [];
  const siteId = list.find((s) => s.id === picked)?.id ?? list.find((s) => s.is_default)?.id ?? list[0]?.id ?? null;
  const pick = (id: number) => {
    setPicked(id);
    writeLocal(SITE_KEY, String(id));
  };
  return { sites: list, loaded: !!sites.data, siteId, site: list.find((s) => s.id === siteId) ?? null, pick };
}

export const useStructure = (siteId: number | null) =>
  usePersisted<TStructure>(
    siteId,
    "structure",
    "structure",
    (d) => Array.isArray(d.groups) && Array.isArray(d.accounts),
    { refetchInterval: 60_000 },
  );
export const useTodayStats = (siteId: number | null) =>
  usePersisted<TTodayStats>(siteId, "today-stats", "today-stats", () => true, { refetchInterval: 60_000 });
export const useGroupUsage = (siteId: number | null) =>
  usePersisted<TGroupUsage>(
    siteId,
    "group-usage",
    "group-usage",
    (d) => typeof (d as Partial<TGroupUsage>).by_group === "object",
    {
      refetchInterval: 60_000,
    },
  );
export const useGroupUsers = (siteId: number | null) =>
  usePersisted<TGroupUsers>(siteId, "group-users", "group-users", (d) => Array.isArray(d.groups));

// 实时：RPM / TPM + 各渠道并发，每 2 秒（页面在后台时暂停）
export const useRealtime = (siteId: number | null) =>
  useQuery({
    queryKey: tk(siteId, "realtime"),
    queryFn: () => get<TRealtime>(`/traffic/${siteId}/realtime`),
    enabled: siteId != null,
    refetchInterval: 2000,
    retry: false,
  });

// 每个分组的检测设置（测试模型、定时自动测试），存在后端，换浏览器也一致
export type TGroupSetting = { model: string; auto: boolean; interval_min: number };
export const useGroupSettings = (siteId: number | null) =>
  useQuery({
    queryKey: tk(siteId, "group-settings"),
    queryFn: () => get<Record<string, TGroupSetting>>(`/traffic/${siteId}/group-settings`),
    enabled: siteId != null,
    staleTime: 60_000,
  });

export const useErrorRanking = (siteId: number | null, range: string) =>
  useQuery({
    queryKey: tk(siteId, "errors", range),
    queryFn: () => get<TErrorRanking>(`/traffic/${siteId}/error-ranking?range=${range}`),
    enabled: siteId != null,
    refetchOnMount: "always",
  });

export const trafficKey = tk;
