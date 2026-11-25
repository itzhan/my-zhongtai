"use client";

import { useState } from "react";

import Link from "next/link";

import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Loader2,
  MinusCircle,
  Play,
  PlusCircle,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { post } from "../api";
import { ms, readErr, time } from "../format";
import { qk, useVerifyRun } from "../hooks";
import type { VerifyModelCheckItem, VerifyModelsCheck, VerifyRun, VerifyStep, VerifyVerdict } from "../types";

import { Tag, type Tone } from "./badges";
import { ResponsiveDialog } from "./shared";

export function getVerdictMeta(verdict: VerifyVerdict, running = false): { tone: Tone; label: string; short: string } {
  if (running || verdict === "pending") {
    return { tone: "info", label: "检测进行中…", short: "检测中" };
  }
  switch (verdict) {
    case "authentic":
      return { tone: "ok", label: "真 · 官方特征吻合", short: "真 · 吻合" };
    case "suspicious":
      return { tone: "warn", label: "疑似 · 非纯透传", short: "疑似" };
    case "fake":
      return { tone: "bad", label: "假 · 特征不符", short: "假 · 不符" };
    case "inconclusive":
    default:
      return { tone: "muted", label: "无法判定", short: "无法判定" };
  }
}

function getSkSourceLabel(src: string): string {
  switch (src) {
    case "manual":
      return "本次手动输入";
    case "saved_manual":
      return "复用上次测试 Key";
    case "saved_key":
      return "鉴定专用 Key";
    case "db":
      return "账号库自动读取";
    case "s2_export":
      return "sub2api 导出读取";
    case "detect_key":
      return "深度检测 Key";
    case "supplier_monitor":
      return "供应商监测 Key";
    default:
      return src || "-";
  }
}

export function VerifyVerdictBadge({
  verdict,
  running = false,
  compact = false,
}: {
  verdict: VerifyVerdict;
  running?: boolean;
  compact?: boolean;
}) {
  const meta = getVerdictMeta(verdict, running);
  return (
    <Tag tone={meta.tone} className="gap-1">
      {running || verdict === "pending" ? <Loader2 className="size-3 animate-spin" /> : null}
      {compact ? meta.short : meta.label}
    </Tag>
  );
}

function buildMarkdownReport(run: VerifyRun): string {
  const meta = getVerdictMeta(run.verdict, run.status === "running");
  const lines: string[] = [
    `# 渠道真伪鉴定报告 · ${run.channel_name}`,
    "",
    `- **结论**：${meta.label}（置信度评分 ${run.score} 分，特征命中 ${run.matched_count}/${run.total_probes}）`,
    run.account_id > 0
      ? `- **测试账号**：${run.account_name} (#${run.account_id})`
      : `- **检测目标**：${run.account_name}（手动输入 URL 预检）`,
    `- **上游站点**：${run.base_url}`,
    `- **脱敏 SK**：\`${run.sk_masked}\`（来源：${getSkSourceLabel(run.sk_source)}）`,
    `- **测试模型**：${run.model}${run.requested_model && run.requested_model !== run.model ? `（映射自 ${run.requested_model}）` : ""}`,
    `- **方法论版本**：v${run.methodology_version}`,
    `- **检测时间**：${time(run.started_at)} · 耗时 ${ms(run.duration_ms)}`,
    ...(run.models_check && run.models_check.status === "done"
      ? [
          `- **上游模型可用性**：通 ${run.models_check.passed_count} / 共 ${run.models_check.total}（排除 ${run.models_check.failed_count} 个不通 · 端点 ${run.models_check.endpoint || "-"}）`,
        ]
      : []),
    "",
    `> **综合研判**：${run.summary}`,
    "",
    "## 探针检测明细",
    "",
    "| 探针 | 类型 | 状态 | HTTP | 耗时 | 判定说明 |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const s of run.steps ?? []) {
    const stText =
      s.status === "pass"
        ? "命中"
        : s.status === "fail"
          ? "未通过"
          : s.status === "skip"
            ? "跳过"
            : s.status === "running"
              ? "检测中"
              : "等待中";
    const kindText = s.kind === "baseline" ? "基准" : "指纹";
    const statusText =
      s.round_statuses && s.round_statuses.length > 1 ? s.round_statuses.join("/") : String(s.http_status ?? "-");
    const reasonSafe = (s.reason || "-").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
    lines.push(`| ${s.name} | ${kindText} | ${stText} | ${statusText} | ${ms(s.latency_ms)} | ${reasonSafe} |`);
  }
  const snippets = (run.steps ?? []).filter((s) => s.response_snippet);
  if (snippets.length) {
    lines.push("", "## 上游响应证据摘要", "");
    for (const s of snippets) {
      lines.push(`### ${s.name} (HTTP ${s.http_status ?? "-"})`, "```", s.response_snippet.slice(0, 600), "```", "");
    }
  }
  return lines.join("\n");
}

function StepStatusIcon({ status }: { status: VerifyStep["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="text-primary size-4 animate-spin" />;
    case "pass":
      return <CheckCircle2 className="text-success size-4" />;
    case "fail":
      return <XCircle className="text-danger size-4" />;
    case "skip":
      return <MinusCircle className="text-muted-foreground size-4" />;
    case "pending":
    default:
      return <Clock className="text-muted-foreground/70 size-4" />;
  }
}

function formatStepStatusLabel(step: VerifyStep): { text: string; ok: boolean } | null {
  if (step.round_statuses && step.round_statuses.length > 1) {
    const ok = step.round_statuses.every((c) => step.expect_status.includes(c));
    return { text: `HTTP ${step.round_statuses.join(" / ")}`, ok };
  }
  if (step.http_status != null) {
    return { text: `HTTP ${step.http_status}`, ok: step.expect_status.includes(step.http_status) };
  }
  return null;
}

function StepRow({
  step,
  disableRetest,
  retesting,
  onRetest,
}: {
  step: VerifyStep;
  disableRetest: boolean;
  retesting: boolean;
  onRetest: (probeId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const statusTag = formatStepStatusLabel(step);
  const busy = step.status === "running" || retesting;
  return (
    <>
      <TableRow
        className={cn(
          "cursor-pointer transition-colors",
          step.status === "running" && "bg-primary/5",
          step.status === "fail" && "bg-danger/5",
        )}
        onClick={() => setOpen((v) => !v)}
      >
        <TableCell className="w-8 pr-0">
          {open ? (
            <ChevronDown className="text-muted-foreground size-4" />
          ) : (
            <ChevronRight className="text-muted-foreground size-4" />
          )}
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-2">
            <StepStatusIcon status={step.status} />
            <span className="font-medium">{step.name}</span>
            <Badge variant="outline" className="text-[10px] font-normal">
              {step.kind === "baseline" ? "基准" : "指纹"}
            </Badge>
            {step.strong_hit ? (
              <Tag tone="ok" className="text-[10px]">
                强特征
              </Tag>
            ) : null}
            {step.counter_hit ? (
              <Tag tone="bad" className="text-[10px]">
                反例命中
              </Tag>
            ) : null}
            {step.param_stripped ? (
              <Tag tone="warn" className="text-[10px]">
                疑似吞参数
              </Tag>
            ) : null}
            {step.fallback_used ? (
              <Tag tone="info" className="text-[10px]">
                补发校验
              </Tag>
            ) : null}
            {step.throttled ? (
              <Tag tone="warn" className="text-[10px]">
                限流/日限额
              </Tag>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">{step.request_desc}</p>
        </TableCell>
        <TableCell className="font-mono text-xs whitespace-nowrap">
          {statusTag ? (
            <Tag tone={statusTag.ok ? "ok" : "warn"}>{statusTag.text}</Tag>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </TableCell>
        <TableCell className="font-mono text-xs whitespace-nowrap">{ms(step.latency_ms)}</TableCell>
        <TableCell className="max-w-md text-xs break-words whitespace-normal">
          {step.status === "pending" ? (
            <span className="text-muted-foreground">排队等待中…</span>
          ) : step.status === "running" ? (
            <span className="text-primary">正在向上游发送探针请求…</span>
          ) : (
            <span>{step.reason || "-"}</span>
          )}
        </TableCell>
        <TableCell
          className="w-20 text-right whitespace-nowrap"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <Button
            type="button"
            size="sm"
            variant={step.status === "fail" || step.status === "skip" ? "outline" : "ghost"}
            className="h-7 px-2 text-xs"
            disabled={disableRetest}
            title={`单独重测「${step.name}」`}
            onClick={() => onRetest(step.id)}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
            单测
          </Button>
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={6} className="p-4 whitespace-normal">
            <div className="space-y-3 text-xs">
              <div>
                <div className="text-muted-foreground mb-1 font-medium">判定标准</div>
                <p>{step.expect_desc || "-"}</p>
                {step.must_match.length ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    <span className="text-muted-foreground">
                      必中正则（{step.match_mode === "any" ? "命中其一" : "全部命中"}）：
                    </span>
                    {step.must_match.map((p) => (
                      <code key={p} className="bg-background rounded border px-1.5 py-0.5 font-mono text-[11px]">
                        {p}
                      </code>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div>
                  <div className="text-muted-foreground mb-1 font-medium">
                    发送请求（{step.request_url || "尚未发出"}）
                  </div>
                  <pre className="bg-background max-h-56 overflow-auto rounded-md border p-2.5 font-mono text-[11px] leading-relaxed">
                    {JSON.stringify(step.request_body, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="text-muted-foreground mb-1 font-medium">上游响应内容</div>
                  <pre className="bg-background max-h-56 overflow-auto rounded-md border p-2.5 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
                    {step.response_snippet || "（暂无响应内容）"}
                  </pre>
                  {Object.keys(step.response_headers).length ? (
                    <div className="text-muted-foreground mt-1.5 flex flex-wrap gap-1.5">
                      {Object.entries(step.response_headers).map(([k, v]) => (
                        <span key={k} className="bg-background rounded border px-1.5 py-0.5 font-mono text-[10px]">
                          {k}: {v}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function VerdictBannerIcon({ verdict, running }: { verdict: VerifyVerdict; running: boolean }) {
  if (running || verdict === "pending") return <Loader2 className="text-info size-6 animate-spin" />;
  if (verdict === "authentic") return <ShieldCheck className="text-success size-6" />;
  if (verdict === "suspicious") return <ShieldAlert className="text-warning size-6" />;
  if (verdict === "fake") return <XCircle className="text-danger size-6" />;
  return <ShieldQuestion className="text-muted-foreground size-6" />;
}

function ModelsCheckPanel({
  mc,
  runRunning,
  retestingKey,
  onRetestModels,
}: {
  mc: VerifyModelsCheck;
  runRunning: boolean;
  retestingKey: string | null;
  onRetestModels: (opts: { models?: string[]; onlyFailed?: boolean; key: string; label: string }) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<"all" | "pass" | "fail">("all");
  const results: VerifyModelCheckItem[] = mc.results ?? [];
  const pct = mc.total > 0 ? Math.round((mc.completed / mc.total) * 100) : 0;

  if (mc.status === "skipped") return null;

  const shown = results.filter((r) => (filter === "all" ? true : r.status === filter));

  return (
    <div className="space-y-2.5 rounded-lg border p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-sm font-medium">阶段 1：上游模型并行可用性测试</span>
          {mc.status === "fetching" ? (
            <Tag tone="info" className="gap-1">
              <Loader2 className="size-3 animate-spin" />
              正在获取全部上游端点…
            </Tag>
          ) : mc.status === "running" ? (
            <Tag tone="info" className="gap-1">
              <Loader2 className="size-3 animate-spin" />
              并行检测中 {mc.completed}/{mc.total}
            </Tag>
          ) : mc.status === "error" ? (
            <Tag tone="warn">拉取失败</Tag>
          ) : (
            <>
              <Tag tone="ok">可用 {mc.passed_count}</Tag>
              {mc.failed_count > 0 ? <Tag tone="bad">不通 {mc.failed_count}（录入自动排除）</Tag> : null}
              <span className="text-muted-foreground font-mono">
                共 {mc.total} 个{mc.endpoint ? ` · ${mc.endpoint}` : ""}
                {mc.duration_ms > 0 ? ` · ${ms(mc.duration_ms)}` : ""}
              </span>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {!runRunning && mc.status === "done" && mc.failed_count > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              disabled={Boolean(retestingKey)}
              onClick={() =>
                onRetestModels({
                  onlyFailed: true,
                  key: "__failed_models__",
                  label: `重测 ${mc.failed_count} 个不通模型`,
                })
              }
            >
              <RotateCw className={cn("size-3", retestingKey === "__failed_models__" && "animate-spin")} />
              重测不通模型 ({mc.failed_count})
            </Button>
          ) : null}
          {results.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {expanded ? "收起模型明细" : `查看全部 ${results.length} 个模型`}
            </Button>
          ) : null}
        </div>
      </div>

      {mc.status === "running" ? (
        <div className="space-y-1.5">
          <div className="text-muted-foreground flex items-center justify-between text-xs">
            <span>
              已通 <b className="text-success">{mc.passed_count}</b> · 不通{" "}
              <b className="text-danger">{mc.failed_count}</b>
            </span>
            <span className="font-mono">
              {mc.completed} / {mc.total} ({pct}%)
            </span>
          </div>
          <Progress value={pct} />
        </div>
      ) : null}

      {mc.status === "error" ? (
        <p className="text-warning text-xs">
          自动获取上游模型列表失败（{mc.error || "接口不可用"}），已自动跳过阶段 1 并继续进行渠道真实性检测。
        </p>
      ) : null}

      {mc.status === "done" && !expanded && results.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {mc.passed_models.slice(0, 24).map((m) => (
            <Badge
              key={m}
              variant="outline"
              className="border-success/40 bg-success/5 text-foreground font-mono text-[11px] font-normal"
            >
              <CheckCircle2 className="text-success size-3" />
              {m}
            </Badge>
          ))}
          {mc.passed_models.length > 24 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => setExpanded(true)}
            >
              +{mc.passed_models.length - 24} 个可用模型…
            </Button>
          ) : null}
          {mc.passed_models.length === 0 ? (
            <span className="text-danger text-xs">
              全部 {mc.total} 个上游模型均未通过连通检测，点击右侧展开查看原因。
            </span>
          ) : null}
        </div>
      ) : null}

      {expanded && results.length > 0 ? (
        <div className="space-y-2 border-t pt-2.5">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Button
              type="button"
              size="sm"
              variant={filter === "all" ? "default" : "outline"}
              className="h-6 px-2 text-[11px]"
              onClick={() => setFilter("all")}
            >
              全部 ({results.length})
            </Button>
            <Button
              type="button"
              size="sm"
              variant={filter === "pass" ? "default" : "outline"}
              className="h-6 px-2 text-[11px]"
              onClick={() => setFilter("pass")}
            >
              可用 ({mc.passed_count})
            </Button>
            <Button
              type="button"
              size="sm"
              variant={filter === "fail" ? "default" : "outline"}
              className="h-6 px-2 text-[11px]"
              onClick={() => setFilter("fail")}
            >
              不通 ({mc.failed_count})
            </Button>
          </div>
          <div className="grid max-h-72 gap-1.5 overflow-y-auto sm:grid-cols-2">
            {shown.map((r) => (
              <div
                key={r.model}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs",
                  r.status === "pass" && "border-success/30 bg-success/5",
                  r.status === "fail" && "border-danger/30 bg-danger/5",
                  r.status === "running" && "border-primary/30 bg-primary/5",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {r.status === "pass" ? (
                      <CheckCircle2 className="text-success size-3.5 shrink-0" />
                    ) : r.status === "fail" ? (
                      <XCircle className="text-danger size-3.5 shrink-0" />
                    ) : r.status === "running" ? (
                      <Loader2 className="text-primary size-3.5 shrink-0 animate-spin" />
                    ) : (
                      <Clock className="text-muted-foreground size-3.5 shrink-0" />
                    )}
                    <span className="truncate font-mono font-medium" title={r.model}>
                      {r.model}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-0.5 truncate pl-5 text-[11px]" title={r.reason}>
                    {r.status === "pending"
                      ? "排队等待中…"
                      : r.status === "running"
                        ? "检测中…"
                        : `${r.latency_ms != null ? `${ms(r.latency_ms)} · ` : ""}${r.reason || "-"}`}
                  </p>
                </div>
                {!runRunning && r.status !== "running" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-6 shrink-0 px-1.5 text-[11px]"
                    disabled={Boolean(retestingKey)}
                    title={`重测模型「${r.model}」`}
                    onClick={() =>
                      onRetestModels({
                        models: [r.model],
                        key: `model:${r.model}`,
                        label: `重测模型「${r.model}」`,
                      })
                    }
                  >
                    <Play className="size-2.5" />
                    重测
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function VerifyReportCard({
  run,
  onRerun,
  rerunning = false,
  onQuickAdd,
  addedAccount,
}: {
  run: VerifyRun;
  onRerun?: () => void;
  rerunning?: boolean;
  onQuickAdd?: () => void;
  addedAccount?: { id: number; name: string } | null;
}) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [retestingKey, setRetestingKey] = useState<string | null>(null);
  const running = run.status === "running";
  const steps = run.steps ?? [];
  const mc = run.models_check ?? null;
  const doneCount = steps.filter((s) => s.status === "pass" || s.status === "fail" || s.status === "skip").length;
  const failedSteps = steps.filter((s) => s.status === "fail" || s.status === "skip");
  const inModelsStage = running && Boolean(mc && (mc.status === "fetching" || mc.status === "running"));
  const pct = inModelsStage
    ? mc && mc.total > 0
      ? Math.round((mc.completed / mc.total) * 100)
      : 5
    : steps.length
      ? Math.round((doneCount / steps.length) * 100)
      : 0;
  const activeStep = steps.find((s) => s.status === "running");
  const checkedPassedCount = mc && mc.status === "done" ? mc.passed_count : null;

  const triggerRetest = async (opts: { probeIds?: string[]; onlyFailed?: boolean; key: string; label: string }) => {
    if (running || retestingKey) return;
    setRetestingKey(opts.key);
    try {
      const updated = await post<VerifyRun>(`/verify/runs/${encodeURIComponent(run.id)}/retest-probes`, {
        probe_ids: opts.probeIds,
        only_failed: opts.onlyFailed,
      });
      qc.setQueryData(qk.verifyRun(run.id), updated);
      void qc.invalidateQueries({ queryKey: ["ops", "verify-runs"] });
      toast.success(`已发起${opts.label}`);
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setRetestingKey(null);
    }
  };

  const triggerRetestModels = async (opts: { models?: string[]; onlyFailed?: boolean; key: string; label: string }) => {
    if (running || retestingKey) return;
    setRetestingKey(opts.key);
    try {
      const updated = await post<VerifyRun>(`/verify/runs/${encodeURIComponent(run.id)}/retest-models`, {
        models: opts.models,
        only_failed: opts.onlyFailed,
      });
      qc.setQueryData(qk.verifyRun(run.id), updated);
      void qc.invalidateQueries({ queryKey: ["ops", "verify-runs"] });
      toast.success(`已发起${opts.label}`);
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setRetestingKey(null);
    }
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdownReport(run));
      setCopied(true);
      toast.success("已复制脱敏 Markdown 检测报告");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("无法访问剪贴板，请手动复制页面内容");
    }
  };

  const summaryToneClass =
    running || run.verdict === "pending"
      ? "border-info/30 bg-info/5"
      : run.verdict === "authentic"
        ? "border-success/30 bg-success/5"
        : run.verdict === "suspicious"
          ? "border-warning/40 bg-warning/5"
          : run.verdict === "fake"
            ? "border-danger/30 bg-danger/5"
            : "bg-muted/40";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2.5">
          <VerdictBannerIcon verdict={run.verdict} running={running} />
          <span>渠道鉴定报告</span>
          <VerifyVerdictBadge verdict={run.verdict} running={running} />
          <Badge variant="outline" className="font-mono text-xs font-normal">
            v{run.methodology_version}
          </Badge>
        </CardTitle>
        <CardDescription>
          报告 ID <span className="font-mono">{run.id}</span> · 开始于 {time(run.started_at)}
          {run.finished_at ? ` · 总耗时 ${ms(run.duration_ms)}` : ""}
        </CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          {run.account_id === 0 && !running && onQuickAdd ? (
            <>
              {addedAccount ? (
                <Button size="sm" variant="outline" asChild>
                  <Link prefetch={false} href={`/dashboard/accounts/${addedAccount.id}`}>
                    <Check className="text-success size-3.5" />
                    已录入 #{addedAccount.id}
                    <ExternalLink className="size-3 opacity-60" />
                  </Link>
                </Button>
              ) : null}
              <Button
                size="sm"
                variant={!addedAccount && run.verdict === "authentic" ? "default" : "outline"}
                onClick={onQuickAdd}
              >
                <PlusCircle className="size-3.5" />
                {addedAccount
                  ? "再次录入"
                  : checkedPassedCount != null
                    ? `一键添加供应商（${checkedPassedCount} 个可用模型）`
                    : "一键添加供应商"}
              </Button>
            </>
          ) : null}
          <Button size="sm" variant="outline" onClick={copyReport}>
            {copied ? <Check className="text-success" /> : <Copy />}
            {copied ? "已复制" : "复制报告"}
          </Button>
          {onRerun ? (
            <Button size="sm" variant="outline" disabled={running || rerunning} onClick={onRerun}>
              <RotateCw className={cn((running || rerunning) && "animate-spin")} />
              重新检测
            </Button>
          ) : null}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-5">
        {running ? (
          <div className="space-y-2 rounded-lg border p-3.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">
                {inModelsStage
                  ? mc?.status === "fetching"
                    ? "阶段 1/2：正在自动获取全部上游端点模型…"
                    : `阶段 1/2：正在并行检测上游模型可用性（已通 ${mc?.passed_count ?? 0} / 不通 ${mc?.failed_count ?? 0}）`
                  : activeStep
                    ? `${mc ? "阶段 2/2：" : ""}正在执行真实性探针「${activeStep.name}」`
                    : "正在准备探针请求…"}
              </span>
              <span className="text-muted-foreground font-mono">
                {inModelsStage
                  ? `${mc?.completed ?? 0} / ${mc?.total ?? 0} (${pct}%)`
                  : `${doneCount} / ${steps.length || run.total_probes} (${pct}%)`}
              </span>
            </div>
            <Progress value={pct} />
          </div>
        ) : null}

        <div className="grid gap-3 rounded-lg border p-3.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <div className="text-muted-foreground">{run.account_id > 0 ? "检测账号" : "检测目标"}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-medium">
              <span>{run.account_name}</span>
              {run.account_id > 0 ? (
                <span className="text-muted-foreground font-mono">#{run.account_id}</span>
              ) : (
                <Tag tone="info" className="text-[10px]">
                  手动 URL
                </Tag>
              )}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">上游站点</div>
            <div className="mt-0.5 truncate font-mono" title={run.base_url}>
              {run.base_url}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">检测 SK（已脱敏）</div>
            <div className="mt-0.5 font-mono">
              {run.sk_masked}{" "}
              <span className="text-muted-foreground font-sans">({getSkSourceLabel(run.sk_source)})</span>
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">目标渠道类型</div>
            <div className="mt-0.5 font-medium">{run.channel_name}</div>
          </div>
          <div>
            <div className="text-muted-foreground">测试模型</div>
            <div className="mt-0.5 font-mono">
              {run.model}
              {run.requested_model && run.requested_model !== run.model ? (
                <span className="text-muted-foreground">（映射自 {run.requested_model}）</span>
              ) : null}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">指纹命中 / 评分</div>
            <div className="mt-0.5 font-mono font-semibold">
              {run.matched_count} / {run.total_probes} 项 · {run.score} 分
            </div>
          </div>
        </div>

        <div
          className={cn(
            "flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm leading-relaxed sm:flex-row sm:items-center sm:justify-between",
            summaryToneClass,
          )}
        >
          <div>
            <span className="font-semibold">综合研判：</span>
            {run.summary}
          </div>
          {run.account_id === 0 && !running && onQuickAdd ? (
            <div className="flex shrink-0 items-center gap-2">
              {addedAccount ? (
                <Button size="sm" variant="outline" asChild>
                  <Link prefetch={false} href={`/dashboard/accounts/${addedAccount.id}`}>
                    查看账号 #{addedAccount.id}
                    <ExternalLink className="size-3" />
                  </Link>
                </Button>
              ) : (
                <Button size="sm" variant={run.verdict === "authentic" ? "default" : "outline"} onClick={onQuickAdd}>
                  <PlusCircle className="size-3.5" />
                  {checkedPassedCount != null ? `仅录入 ${checkedPassedCount} 个可用模型` : "一键添加到系统"}
                </Button>
              )}
            </div>
          ) : null}
        </div>

        {mc ? (
          <ModelsCheckPanel
            mc={mc}
            runRunning={running}
            retestingKey={retestingKey}
            onRetestModels={(opts) => void triggerRetestModels(opts)}
          />
        ) : null}

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">
              {mc
                ? "阶段 2：渠道真实性探针检测（点击任意行展开请求与原始响应，支持单项单测）"
                : "探针逐步检测情况（点击任意行展开请求与原始响应，支持单项单测）"}
            </h3>
            <div className="flex items-center gap-2">
              {!running && failedSteps.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-xs"
                  disabled={Boolean(retestingKey)}
                  onClick={() =>
                    void triggerRetest({
                      onlyFailed: true,
                      key: "__failed__",
                      label: `重测 ${failedSteps.length} 项失败/跳过探针`,
                    })
                  }
                >
                  <RotateCw className={cn("size-3", retestingKey === "__failed__" && "animate-spin")} />
                  重测失败项 ({failedSteps.length})
                </Button>
              ) : null}
              <span className="text-muted-foreground text-xs">共 {steps.length} 步</span>
            </div>
          </div>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>探针与请求方式</TableHead>
                  <TableHead>状态码</TableHead>
                  <TableHead>耗时</TableHead>
                  <TableHead>判定结果</TableHead>
                  <TableHead className="w-20 text-right">单测</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {steps.length ? (
                  steps.map((s) => (
                    <StepRow
                      key={s.id}
                      step={s}
                      disableRetest={running || Boolean(retestingKey)}
                      retesting={retestingKey === s.id}
                      onRetest={(probeId) =>
                        void triggerRetest({
                          probeIds: [probeId],
                          key: probeId,
                          label: `单测「${s.name}」`,
                        })
                      }
                    />
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground py-8 text-center text-sm">
                      暂无探针执行记录
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function VerifyReportDialog({
  runId,
  open,
  onOpenChange,
  onRerun,
  onQuickAdd,
  addedAccount,
}: {
  runId: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onRerun?: (run: VerifyRun) => void;
  onQuickAdd?: (run: VerifyRun) => void;
  addedAccount?: { id: number; name: string } | null;
}) {
  const { data, isLoading } = useVerifyRun(open ? runId : null);
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={data ? `鉴定报告 · ${data.account_name}` : "鉴定报告"}
      className="sm:max-w-4xl"
    >
      {isLoading || !data ? (
        <div className="space-y-3 py-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <VerifyReportCard
          run={data}
          onRerun={onRerun ? () => onRerun(data) : undefined}
          onQuickAdd={onQuickAdd && data.account_id === 0 ? () => onQuickAdd(data) : undefined}
          addedAccount={addedAccount}
        />
      )}
    </ResponsiveDialog>
  );
}
