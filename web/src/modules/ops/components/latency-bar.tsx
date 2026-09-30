"use client";

import { useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { hm, ms, num, time } from "../format";
import type { AccountSample, Grade, HeatStatus, SupplierSample } from "../types";

// 延迟监控条（同 zhongtai 的 Heatmap）：一排小色块，每块一段时间 / 一次探测，颜色表示状态
export const HEAT_CLASS: Record<HeatStatus, string> = {
  up: "bg-success",
  slow: "bg-warning",
  down: "bg-danger",
  limited: "bg-info",
  unknown: "bg-muted-foreground/20",
};
export const STATUS_LABEL: Record<HeatStatus, string> = {
  up: "正常",
  slow: "偏慢",
  down: "异常",
  limited: "限流",
  unknown: "无数据",
};
export const GRADE: Record<Grade["grade"], { label: string; className: string }> = {
  excellent: { label: "优秀", className: "border-success/40 text-success" },
  unstable: { label: "不稳定", className: "border-warning/50 text-warning" },
  unavailable: { label: "不可用", className: "border-danger/40 text-danger" },
  unknown: { label: "无数据", className: "text-muted-foreground" },
};

export type HeatCell = { key: string; status: HeatStatus; tip: ReactNode };

export function LatencyBar({
  cells,
  slots = 24,
  size = "sm",
  className,
}: {
  cells: HeatCell[];
  slots?: number;
  size?: "sm" | "lg";
  className?: string;
}) {
  const [hover, setHover] = useState<{ i: number; left: number } | null>(null);
  // 样本不足时左侧补灰格
  const padded: (HeatCell | null)[] = [...Array(Math.max(0, slots - cells.length)).fill(null), ...cells.slice(-slots)];
  const cur = hover ? padded[hover.i] : null;
  return (
    <div className={cn("relative inline-flex items-center gap-[2px]", className)} onMouseLeave={() => setHover(null)}>
      {padded.map((c, i) => (
        <div
          key={c?.key ?? `pad-${i}`}
          onMouseEnter={(e) => c && setHover({ i, left: (e.currentTarget as HTMLElement).offsetLeft })}
          className={cn(
            "rounded-[2px] transition-opacity",
            size === "lg" ? "h-8 w-2.5" : "h-6 w-1.5",
            HEAT_CLASS[c?.status ?? "unknown"],
            hover && hover.i !== i && "opacity-60",
          )}
        />
      ))}
      {cur && hover ? (
        <div
          className="bg-popover text-popover-foreground pointer-events-none absolute bottom-full z-50 mb-2 w-max max-w-72 -translate-x-1/2 rounded-md border px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: hover.left + 3 }}
        >
          {cur.tip}
        </div>
      ) : null}
    </div>
  );
}

export function GradeBadge({ score }: { score: Grade }) {
  const g = GRADE[score.grade];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={cn("cursor-default", g.className)}>
          {g.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {score.total
          ? `近 ${score.total} 段：${score.up} 正常 / ${score.slow} 偏慢 / ${score.down} 异常`
          : "近期没有可评估的数据"}
      </TooltipContent>
    </Tooltip>
  );
}

export function Legend() {
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
      {(Object.keys(HEAT_CLASS) as HeatStatus[]).map((s) => (
        <span key={s} className="flex items-center gap-1">
          <i className={cn("inline-block h-3 w-1.5 rounded-[2px]", HEAT_CLASS[s])} />
          {STATUS_LABEL[s]}
        </span>
      ))}
    </div>
  );
}

// 账号：真实流量按时间分段
export function accountCells(samples: AccountSample[], bucketMin: number): HeatCell[] {
  return samples.map((s) => {
    const end = new Date(new Date(s.t).getTime() + bucketMin * 60000);
    const errs = s.dead + s.fail;
    return {
      key: s.t,
      status: s.status,
      tip: (
        <div className="space-y-0.5">
          <div className="font-medium">
            {hm(s.t)}–{hm(end.toISOString())} · {STATUS_LABEL[s.status]}
          </div>
          {s.n || errs || s.r429 ? (
            <>
              <div>
                成功 {num(s.n)} 次{errs ? ` · 上游失败 ${errs}` : ""}
                {s.r429 ? ` · 429 ×${s.r429}` : ""}
                {s.dead ? `（死亡类 ${s.dead}）` : ""}
              </div>
              {s.p50 != null ? (
                <div>
                  首字 P50 {ms(s.p50)} · P90 {ms(s.p90)}
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-muted-foreground">这段时间没有请求</div>
          )}
        </div>
      ),
    };
  });
}

// 供应商：每次主动探测一格
export function supplierCells(samples: SupplierSample[]): HeatCell[] {
  return samples.map((s) => ({
    key: String(s.id),
    status: s.status,
    tip: (
      <div className="space-y-0.5">
        <div className="font-medium">
          {time(s.checked_at)} · {STATUS_LABEL[s.status]}
        </div>
        {s.latency_ms ? <div>延迟 {ms(s.latency_ms)}</div> : null}
        {s.error ? <div className="text-danger break-all">{s.error}</div> : null}
      </div>
    ),
  }));
}
