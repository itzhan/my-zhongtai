"use client";

import { useState } from "react";

import { Eye, RefreshCw, RotateCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { del } from "../api";
import { Tag } from "../components/badges";
import { Pager, StatCards, useConfirm, usePaged } from "../components/shared";
import { VerifyReportDialog, VerifyVerdictBadge } from "../components/verify-report";
import { ago, ms, readErr, time } from "../format";
import { useInvalidate, useVerifyChannels, useVerifyRuns } from "../hooks";
import type { VerifyPreset, VerifyRun } from "../types";

const ALL = "all";

function toPreset(r: VerifyRun): VerifyPreset {
  if (r.account_id > 0) {
    return { mode: "account", accountId: r.account_id, channelCode: r.channel_code, model: r.model };
  }
  return {
    mode: "manual",
    baseUrl: r.base_url,
    targetName: r.account_name,
    channelCode: r.channel_code,
    model: r.model,
  };
}

export function VerifyHistoryView({ onRerunPreset }: { onRerunPreset: (preset: VerifyPreset) => void }) {
  const invalidate = useInvalidate();
  const [confirm, confirmEl] = useConfirm();
  const [kw, setKw] = useState("");
  const [channelFilter, setChannelFilter] = useState(ALL);
  const [verdictFilter, setVerdictFilter] = useState(ALL);
  const [viewRunId, setViewRunId] = useState<string | null>(null);

  const channelsQ = useVerifyChannels();
  const runsQ = useVerifyRuns({});
  const allRuns = runsQ.data ?? [];

  const filtered = allRuns.filter((r) => {
    if (channelFilter !== ALL && r.channel_code !== channelFilter) return false;
    if (verdictFilter !== ALL && r.verdict !== verdictFilter) return false;
    if (kw.trim()) {
      const q = kw.trim().toLowerCase();
      const hay = `${r.account_name} #${r.account_id} ${r.base_url} ${r.model} ${r.channel_name}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const { rows, pager } = usePaged(filtered, `${kw}|${channelFilter}|${verdictFilter}`);

  const cnt = (v: string) => allRuns.filter((r) => r.verdict === v).length;

  const removeRun = async (r: VerifyRun) => {
    const ok = await confirm({
      title: `删除鉴定记录？`,
      description: `账号「${r.account_name}」在 ${time(r.started_at)} 的 ${r.channel_name} 鉴定报告将被移除。`,
      destructive: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await del(`/verify/runs/${r.id}`);
      toast.success("已删除记录");
      if (viewRunId === r.id) setViewRunId(null);
      invalidate("verify-runs");
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {runsQ.data ? (
        <StatCards
          items={[
            { label: "累计鉴定次数", value: allRuns.length },
            { label: "真 · 特征吻合", value: cnt("authentic"), className: "text-success" },
            { label: "疑似 / 非纯透传", value: cnt("suspicious"), className: "text-warning" },
            { label: "假 · 特征不符", value: cnt("fake"), className: "text-danger" },
          ]}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              placeholder="搜索账号 / 站点 / 模型…"
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={channelFilter} onValueChange={setChannelFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部渠道</SelectItem>
              {(channelsQ.data ?? []).map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={verdictFilter} onValueChange={setVerdictFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部结论</SelectItem>
              <SelectItem value="authentic">真 · 官方特征吻合</SelectItem>
              <SelectItem value="suspicious">疑似 · 非纯透传</SelectItem>
              <SelectItem value="fake">假 · 特征不符</SelectItem>
              <SelectItem value="inconclusive">无法判定</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" onClick={() => runsQ.refetch()} disabled={runsQ.isFetching}>
          <RefreshCw className={cn(runsQ.isFetching && "animate-spin")} />
          刷新
        </Button>
      </div>

      {runsQ.isLoading ? (
        <Skeleton className="h-72" />
      ) : (
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>检测时间</TableHead>
                  <TableHead>账号与站点</TableHead>
                  <TableHead>渠道类型</TableHead>
                  <TableHead>测试模型</TableHead>
                  <TableHead>鉴定结论</TableHead>
                  <TableHead>命中 / 评分</TableHead>
                  <TableHead>耗时</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length ? (
                  rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs whitespace-nowrap" title={time(r.started_at)}>
                        <div>{time(r.started_at)}</div>
                        <div className="text-muted-foreground">{ago(r.started_at)}</div>
                      </TableCell>
                      <TableCell className="max-w-56">
                        <div className="flex items-center gap-1.5 font-medium">
                          <span className="truncate">{r.account_name}</span>
                          {r.account_id > 0 ? (
                            <span className="text-muted-foreground shrink-0 font-mono text-xs">#{r.account_id}</span>
                          ) : (
                            <Tag tone="info" className="shrink-0 text-[10px]">
                              手动
                            </Tag>
                          )}
                        </div>
                        <div className="text-muted-foreground truncate font-mono text-[11px]" title={r.base_url}>
                          {r.base_url}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        <span className="font-medium">{r.channel_name}</span>{" "}
                        <span className="text-muted-foreground font-mono">v{r.methodology_version}</span>
                      </TableCell>
                      <TableCell className="max-w-44 truncate font-mono text-xs" title={r.model}>
                        {r.model}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <VerifyVerdictBadge verdict={r.verdict} running={r.status === "running"} compact />
                      </TableCell>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        {r.matched_count}/{r.total_probes} · {r.score}分
                      </TableCell>
                      <TableCell className="font-mono text-xs whitespace-nowrap">{ms(r.duration_ms)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setViewRunId(r.id)}>
                            <Eye className="size-3.5" />
                            报告
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            onClick={() => onRerunPreset(toPreset(r))}
                          >
                            <RotateCw className="size-3.5" />
                            复测
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive h-7 px-2"
                            onClick={() => removeRun(r)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={8} className="text-muted-foreground py-10 text-center text-sm">
                      暂无鉴定记录，请先在「开始鉴定」发起检测
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <Pager {...pager} />
        </div>
      )}

      <VerifyReportDialog
        runId={viewRunId}
        open={Boolean(viewRunId)}
        onOpenChange={(o) => !o && setViewRunId(null)}
        onRerun={(r) => {
          setViewRunId(null);
          onRerunPreset(toPreset(r));
        }}
      />
      {confirmEl}
    </div>
  );
}
