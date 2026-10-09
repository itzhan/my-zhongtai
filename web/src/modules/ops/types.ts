// 后端返回的数据形状（字段来自 sub2api，按需列出）
export type Group = {
  id: number;
  name: string;
  platform: string;
  rate_multiplier: number;
  is_exclusive: boolean;
  status: string;
  active_account_count?: number;
  account_count?: number;
};

export type Account = {
  id: number;
  name: string;
  notes: string | null;
  platform: string;
  type: string;
  status: "active" | "inactive" | "error" | string;
  schedulable: boolean;
  priority: number;
  concurrency: number;
  current_concurrency?: number;
  load_factor?: number | null;
  group_ids: number[];
  error_message?: string | null;
  rate_limit_reset_at?: string | null;
  overload_until?: string | null;
  temp_unschedulable_until?: string | null;
  temp_unschedulable_reason?: string | null;
  last_used_at?: string | null;
  created_at?: string;
  // 账号管理页
  errors_24h?: number;
  today?: { requests?: number; cost?: number; actual_cost?: number } | null;
  // 客户渠道页
  in_customer_groups?: number[];
  cust_requests_7d?: number;
  cust_cost_7d?: number;
  cust_errors_7d?: number;
};

export type Customer = {
  id: string;
  name: string;
  contact: string;
  notes: string;
  user_ids: number[];
  users: { id: number; email: string }[];
  today_requests: number;
  today_cost: number;
  errors_24h: number;
};

export type S2User = {
  id: number;
  email: string;
  username?: string;
  balance: number;
  status: string;
  allowed_groups?: number[];
  last_active_at?: string | null;
};

export type ApiKeyRow = {
  id: number;
  name: string;
  key_masked: string;
  group_id: number | null;
  status: string;
  last_used_at: string | null;
  created_at: string;
};

export type CustomerOverview = {
  customer: Customer & { user_ids: number[] };
  users: (S2User & {
    concurrency: number;
    rpm_limit: number;
    missing?: boolean;
    error?: string;
    keys: ApiKeyRow[];
  })[];
  summary: Record<"today" | "d7" | "d30", { requests: number; cost: number; tokens: number }>;
  trend: { day: string; requests: number; cost: number }[];
  errors: { h24: number; d7: number };
};

export type Paged<T> = { items: T[]; total: number; page: number; page_size: number };

// 延迟监控条的一格
export type HeatStatus = "up" | "slow" | "down" | "limited" | "unknown";
export type Grade = {
  grade: "excellent" | "unstable" | "unavailable" | "unknown";
  total: number;
  up: number;
  slow: number;
  down: number;
};
export type AccountSample = {
  t: string;
  status: HeatStatus;
  n: number;
  p50: number | null;
  p90: number | null;
  dead: number;
  fail: number;
  r429: number;
  client: number;
};
export type MonitorResp = {
  range: string;
  bucket_min: number;
  slow_ms: number;
  accounts: Record<string, { samples: AccountSample[]; score: Grade }>;
};

export type Alert = { level: "critical" | "warn" | string; msg: string };

export type Supplier = {
  id: number;
  name: string;
  wechat: string;
  contact: string;
  base_url: string;
  category: string[];
  channel: string;
  status: "active" | "paused" | "closed";
  notes: string;
  created_at: string;
  updated_at: string;
  goods: { id: number; name: string; rate: string }[];
  links?: { account_id: number; mode: "include" | "exclude" }[];
  monitor_count?: number;
  wallet?: { count: number; actual: number | null; errors: number } | null;
};

// 供应商余额：我们在供应商站点（new-api / sub2api）的 Key 对应的钱包额度与倍率
export type SupplierWallet = {
  id: number;
  supplier_id: number;
  supplier_name?: string;
  name: string;
  platform: "newapi" | "sub2api";
  base_url: string;
  custom: boolean;
  custom_ratio: number | null;
  enabled: boolean;
  has_key: boolean;
  key_masked: string;
  last_wallet: number | null;
  last_wallet_kind: "" | "wallet" | "token" | "quota" | "subscription";
  last_ratio: number | null;
  last_ratio_source: string;
  last_actual: number | null;
  last_error: string;
  last_checked_at: string | null;
};

export type SupplierSample = {
  id: number;
  status: HeatStatus;
  latency_ms: number;
  http_status: number | null;
  error: string;
  checked_at: string;
};
export type SupplierMonitor = {
  id: number;
  supplier_id: number;
  supplier_name?: string;
  supplier_category?: string[];
  name: string;
  kind: "openai" | "openai_response" | "claude";
  base_url: string;
  model: string;
  enabled: boolean;
  slow_ms: number;
  has_key: boolean;
  key_masked: string;
  last_status: HeatStatus;
  last_latency_ms: number | null;
  last_error: string;
  last_checked_at: string | null;
  samples: SupplierSample[];
  score: Grade;
};
