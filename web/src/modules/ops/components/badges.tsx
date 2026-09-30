"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { time } from "../format";
import { useNow } from "../hooks";
import type { Account } from "../types";

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";
const TONE: Record<Tone, string> = {
  ok: "border-success/40 bg-success/10 text-success",
  warn: "border-warning/50 bg-warning/10 text-warning",
  bad: "border-danger/40 bg-danger/10 text-danger",
  info: "border-info/40 bg-info/10 text-info",
  muted: "text-muted-foreground",
};

export function Tag({
  tone = "muted",
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Badge variant="outline" title={title} className={cn("font-normal", TONE[tone], className)}>
      {children}
    </Badge>
  );
}

export function PlatformBadge({ platform }: { platform: string }) {
  const tone: Tone =
    platform === "anthropic" ? "warn" : platform === "openai" ? "ok" : platform === "gemini" ? "info" : "muted";
  return <Tag tone={tone}>{platform}</Tag>;
}

// 账号在 sub2api 里的状态：启用 / 错误 / 禁用 + 停调度 / 限流 / 过载 / 临时不可调度
export function AccountStatus({ a }: { a: Account }) {
  const now = useNow();
  const future = (t?: string | null) => !!t && new Date(t).getTime() > now;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {a.status === "inactive" ? (
        <Tag>已禁用</Tag>
      ) : a.status === "error" ? (
        <Tag tone="bad">错误</Tag>
      ) : (
        <Tag tone="ok">正常</Tag>
      )}
      {!a.schedulable ? <Tag tone="warn">停止调度</Tag> : null}
      {future(a.rate_limit_reset_at) ? (
        <Tag tone="warn" title={`至 ${time(a.rate_limit_reset_at)}`}>
          限流中
        </Tag>
      ) : null}
      {future(a.overload_until) ? (
        <Tag tone="warn" title={`至 ${time(a.overload_until)}`}>
          过载
        </Tag>
      ) : null}
      {future(a.temp_unschedulable_until) ? (
        <Tag tone="warn" title={a.temp_unschedulable_reason ?? ""}>
          临时不可调度
        </Tag>
      ) : null}
    </span>
  );
}

export function BreakerBadge({
  breaker,
  reason,
  until,
}: {
  breaker: string;
  reason?: string;
  until?: number | string | null;
}) {
  if (breaker === "open")
    return (
      <Tag tone="bad" title={reason}>
        熔断中
      </Tag>
    );
  if (breaker === "probation")
    return (
      <Tag tone="warn" title={until ? `至 ${time(until)}` : undefined}>
        观察期
      </Tag>
    );
  return <Tag tone="ok">正常</Tag>;
}

export function ScoreBadge({ v }: { v: number | null | undefined }) {
  if (v == null) return <span className="text-muted-foreground">-</span>;
  return <Tag tone={v >= 0.8 ? "ok" : v >= 0.6 ? "warn" : "bad"}>{v.toFixed(2)}</Tag>;
}

export const VERDICT: Record<string, [Tone, string]> = {
  pass: ["ok", "通过"],
  warn: ["warn", "警告"],
  fail: ["bad", "不通过"],
  info: ["muted", "信息"],
};

// 分组标签：最多显示 max 个，其余折叠成 +N（悬停看全部）
export function GroupTags({
  ids,
  name,
  highlight,
  max = 3,
}: {
  ids: number[];
  name: (id: number) => string;
  highlight?: (id: number) => boolean;
  max?: number;
}) {
  if (!ids.length) return <span className="text-muted-foreground">-</span>;
  const shown = ids.slice(0, max);
  const rest = ids.slice(max);
  return (
    <span className="inline-flex flex-wrap gap-1">
      {shown.map((g) => (
        <Tag key={g} tone={highlight?.(g) ? "info" : "muted"}>
          {name(g)}
        </Tag>
      ))}
      {rest.length ? <Tag title={rest.map(name).join("、")}>+{rest.length}</Tag> : null}
    </span>
  );
}
