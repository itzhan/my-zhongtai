"use client";

import Link from "next/link";

import { ShieldCheck, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAlerts } from "@/modules/ops/hooks";
import { useOps } from "@/modules/ops/provider";

// 顶部报警条：只来自已关联智能调度的分组 / 账号，每 30 秒刷新（同旧版）
export function AlertBar() {
  const { data } = useAlerts();
  if (!data) return null;
  const crit = data.alerts.filter((a) => a.level === "critical");
  const list = [...crit, ...data.alerts.filter((a) => a.level !== "critical")];
  if (!list.length && !data.lastError) return null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-sm lg:px-6",
        crit.length ? "bg-danger/10 text-danger" : "bg-warning/10 text-warning",
      )}
    >
      <b className="flex items-center gap-1">
        <TriangleAlert className="size-4" />
        {list.length} 条报警
      </b>
      {list.slice(0, 3).map((a, i) => (
        <span key={i}>{a.msg}</span>
      ))}
      {list.length > 3 ? <span>…</span> : null}
      {data.lastError ? <span>引擎异常：{data.lastError}</span> : null}
      <Link prefetch={false} href="/dashboard/sched" className="ml-auto underline">
        查看
      </Link>
    </div>
  );
}

// 只读模式标识：本地开发默认只读，所有对线上 sub2api 的写操作都会被后端拦截
export function ReadonlyBadge() {
  const { readonly } = useOps();
  if (!readonly) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="border-info/40 bg-info/10 text-info gap-1">
          <ShieldCheck className="size-3.5" />
          只读模式
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        后端以只读模式运行：修改账号 / 分组 / 用户、测试连接、深度检测、调度设置都会被拦截，不会影响线上
        sub2api；智能调度只观察不调整。
      </TooltipContent>
    </Tooltip>
  );
}
