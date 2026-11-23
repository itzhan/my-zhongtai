"use client";

import { useMemo, useState } from "react";

import Link from "next/link";

import {
  Activity,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Globe,
  Loader2,
  Play,
  PlusCircle,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { del, post } from "../api";
import { AccountStatus, PlatformBadge, Tag } from "../components/badges";
import { QuickAddAccountDialog } from "../components/quick-add-account-dialog";
import { ResponsiveDialog, StatCards, useConfirm } from "../components/shared";
import { ago, ms, readErr, time } from "../format";
import { useAccounts, useBasicTestRun, useBasicTestRuns, useInvalidate, useVerifyAccountInspect } from "../hooks";
import { useOps } from "../provider";
import type {
  Account,
  BasicModelResult,
  BasicTestProtocol,
  BasicTestRun,
  ManualVerifyQuickAddContext,
  VerifyFetchModelsResp,
  VerifyModelOption,
} from "../types";

const URL_RE = /^https?:\/\/[^/\s]+/i;
const MAX_ACCOUNT_DROPDOWN = 40;

const PROTOCOL_OPTIONS: { value: BasicTestProtocol; label: string; hint: string }[] = [
  { value: "auto", label: "自动适配（推荐）", hint: "按模型名自动选接口并在 404 时智能回退" },
  { value: "openai_chat", label: "OpenAI Chat", hint: "POST /v1/chat/completions" },
  { value: "openai_responses", label: "OpenAI Responses", hint: "POST /v1/responses" },
  { value: "anthropic_messages", label: "Anthropic Messages", hint: "POST /v1/messages" },
  { value: "gemini_native", label: "Gemini 原生", hint: "POST /v1beta/models/{m}:generateContent" },
];

function protocolLabel(p: string): string {
  switch (p) {
    case "auto":
      return "自动适配";
    case "openai_chat":
      return "OpenAI Chat";
    case "openai_responses":
      return "OpenAI Responses";
    case "anthropic_messages":
      return "Anthropic";
    case "gemini_native":
      return "Gemini 原生";
    default:
      return p;
  }
}

function inferPlatformFromRun(run: BasicTestRun, selectedModels: string[]): string {
  if (run.protocol === "anthropic_messages") return "anthropic";
  if (run.protocol === "gemini_native") return "gemini";
  if (run.protocol === "openai_chat" || run.protocol === "openai_responses") return "openai";

  const selectedSet = new Set(selectedModels);
  const counts = { anthropic: 0, gemini: 0, openai: 0 };
  for (const r of run.results ?? []) {
    if (r.status !== "pass") continue;
    if (selectedSet.size > 0 && !selectedSet.has(r.model)) continue;
    if (r.protocol_used === "anthropic_messages") counts.anthropic++;
    else if (r.protocol_used === "gemini_native") counts.gemini++;
    else counts.openai++;
  }
  if (counts.anthropic > counts.openai && counts.anthropic >= counts.gemini) return "anthropic";
  if (counts.gemini > counts.openai && counts.gemini > counts.anthropic) return "gemini";
  return "openai";
}

function buildBasicMarkdownReport(run: BasicTestRun): string {
  const results = run.results ?? [];
  const passed = results.filter((r) => r.status === "pass");
  const failed = results.filter((r) => r.status === "fail");
  const lines: string[] = [
    `# 模型基础连通测试报告 · ${run.account_name}`,
    "",
    `- **测试类型**：基础连通测试（非真假检测）`,
    `- **上游站点**：${run.base_url}`,
    `- **脱敏 SK**：\`${run.sk_masked}\``,
    `- **测试协议**：${protocolLabel(run.protocol)} · 并行并发 ${run.concurrency}`,
    `- **测试结果**：共 ${run.total_models} 个模型，**通 ${run.passed_count} 个**，**不通 ${run.failed_count} 个**`,
    `- **测试时间**：${time(run.started_at)} · 耗时 ${ms(run.duration_ms)}`,
    "",
    `## 通的模型（${passed.length}）`,
    "",
  ];
  if (passed.length) {
    lines.push("| 模型 | 协议 | 耗时 | 说明 |", "| --- | --- | --- | --- |");
    for (const r of passed) {
      lines.push(
        `| \`${r.model}\` | ${protocolLabel(r.protocol_used)} | ${ms(r.latency_ms)} | ${r.reason.replace(/\|/g, "\\|")} |`,
      );
    }
  } else {
    lines.push("（无）");
  }
  lines.push("", `## 不通的模型（${failed.length}）`, "");
  if (failed.length) {
    lines.push("| 模型 | 协议 | HTTP | 耗时 | 失败原因 |", "| --- | --- | --- | --- | --- |");
    for (const r of failed) {
      lines.push(
        `| \`${r.model}\` | ${protocolLabel(r.protocol_used)} | ${r.http_status ?? "-"} | ${ms(r.latency_ms)} | ${r.reason.replace(/\|/g, "\\|")} |`,
      );
    }
  } else {
    lines.push("（无）");
  }
  return lines.join("\n");
}

function SingleAccountPicker({
  accounts,
  value,
  onChange,
  loading,
}: {
  accounts: Account[];
  value: number | null;
  onChange: (id: number | null) => void;
  loading: boolean;
}) {
  const { groupName } = useOps();
  const [open, setOpen] = useState(false);
  const [kw, setKw] = useState("");
  const selected = useMemo(() => accounts.find((a) => a.id === value) ?? null, [accounts, value]);
  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) => {
      const gNames = a.group_ids.map((gid) => groupName(gid)).join(" ");
      return `${a.name} #${a.id} ${a.id} ${a.platform} ${a.notes || ""} ${gNames}`.toLowerCase().includes(q);
    });
  }, [accounts, kw, groupName]);
  const shown = filtered.slice(0, MAX_ACCOUNT_DROPDOWN);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-auto min-h-10 w-full justify-between px-3 py-2 text-left font-normal"
        >
          {selected ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate font-medium">{selected.name}</span>
              <span className="text-muted-foreground font-mono text-xs">#{selected.id}</span>
              <PlatformBadge platform={selected.platform} />
              <AccountStatus a={selected} />
            </div>
          ) : (
            <span className="text-muted-foreground flex items-center gap-2">
              <Search className="size-4" />
              {loading ? "正在加载平台账号…" : `搜索并选择一个平台账号（共 ${accounts.length} 个）`}
            </span>
          )}
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="按账号名称、ID、平台、分组搜索…" value={kw} onValueChange={setKw} />
          <CommandList className="max-h-72">
            {shown.length === 0 ? (
              <CommandEmpty>{loading ? "加载账号中…" : "没有匹配的账号"}</CommandEmpty>
            ) : (
              <CommandGroup heading={`匹配账号 ${filtered.length} 个`}>
                {shown.map((a) => (
                  <CommandItem
                    key={a.id}
                    value={String(a.id)}
                    onSelect={() => {
                      onChange(a.id);
                      setOpen(false);
                    }}
                    className="flex items-center justify-between gap-2 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Check className={cn("size-3.5 shrink-0", value === a.id ? "opacity-100" : "opacity-0")} />
                      <span className="truncate font-medium">{a.name}</span>
                      <span className="text-muted-foreground shrink-0 font-mono text-xs">#{a.id}</span>
                    </div>
                    <PlatformBadge platform={a.platform} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ModelResultRow({
  item,
  selectable,
  checked,
  onToggle,
}: {
  item: BasicModelResult;
  selectable: boolean;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <TableRow
        className={cn(
          "cursor-pointer transition-colors",
          item.status === "running" && "bg-primary/5",
          item.status === "fail" && "bg-danger/[0.03]",
        )}
        onClick={() => setOpen((v) => !v)}
      >
        {selectable ? (
          <TableCell className="w-9 pr-0" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={item.status === "pass" && checked}
              disabled={item.status !== "pass"}
              onCheckedChange={(v) => onToggle(!!v)}
              aria-label={`选择模型 ${item.model}`}
            />
          </TableCell>
        ) : null}
        <TableCell className="w-8 pr-0">
          {open ? (
            <ChevronDown className="text-muted-foreground size-4" />
          ) : (
            <ChevronRight className="text-muted-foreground size-4" />
          )}
        </TableCell>
        <TableCell className="font-mono text-xs font-medium">{item.model}</TableCell>
        <TableCell className="whitespace-nowrap">
          {item.status === "pass" ? (
            <Tag tone="ok" className="gap-1">
              <CheckCircle2 className="size-3" />通
            </Tag>
          ) : item.status === "fail" ? (
            <Tag tone="bad" className="gap-1">
              <XCircle className="size-3" />
              不通
            </Tag>
          ) : item.status === "running" ? (
            <Tag tone="info" className="gap-1">
              <Loader2 className="size-3 animate-spin" />
              测试中
            </Tag>
          ) : (
            <Tag tone="muted" className="gap-1">
              <Clock className="size-3" />
              排队中
            </Tag>
          )}
        </TableCell>
        <TableCell className="text-xs whitespace-nowrap">
          <span>{protocolLabel(item.protocol_used)}</span>
          {item.fallback_used ? (
            <Badge variant="outline" className="ml-1.5 text-[10px] font-normal">
              回退
            </Badge>
          ) : null}
        </TableCell>
        <TableCell className="font-mono text-xs whitespace-nowrap">
          {item.http_status != null ? (
            <Tag tone={item.http_status === 200 && item.status === "pass" ? "ok" : "warn"}>
              {item.http_status === 0 ? "网络错误" : `HTTP ${item.http_status}`}
            </Tag>
          ) : (
            <span className="text-muted-foreground">-</span>
          )}
        </TableCell>
        <TableCell className="font-mono text-xs whitespace-nowrap">{ms(item.latency_ms)}</TableCell>
        <TableCell className="max-w-md text-xs break-words whitespace-normal">{item.reason || "-"}</TableCell>
      </TableRow>
      {open ? (
        <TableRow className="bg-muted/30 hover:bg-muted/30">
          <TableCell colSpan={selectable ? 8 : 7} className="p-4 whitespace-normal">
            <div className="space-y-2 text-xs">
              <div className="text-muted-foreground flex flex-wrap gap-4">
                <span>
                  请求地址：<code className="text-foreground font-mono">{item.request_url || "尚未发出"}</code>
                </span>
                {item.response_model ? (
                  <span>
                    响应模型：<code className="text-foreground font-mono">{item.response_model}</code>
                  </span>
                ) : null}
              </div>
              <pre className="bg-background max-h-48 overflow-auto rounded-md border p-2.5 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
                {item.response_snippet || "（暂无响应内容）"}
              </pre>
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

export function BasicTestReportCard({
  run,
  onQuickAdd,
  onRetestFailed,
  onRerunAll,
  retestingFailed = false,
  addedAccount,
}: {
  run: BasicTestRun;
  onQuickAdd?: (selectedPassedModels: string[]) => void;
  onRetestFailed?: () => void;
  onRerunAll?: () => void;
  retestingFailed?: boolean;
  addedAccount?: { id: number; name: string } | null;
}) {
  const [filter, setFilter] = useState<"all" | "pass" | "fail">("all");
  const [kw, setKw] = useState("");
  const [excludedModels, setExcludedModels] = useState<Set<string>>(() => new Set());
  const [copiedReport, setCopiedReport] = useState(false);
  const [copiedPassed, setCopiedPassed] = useState(false);

  const running = run.status === "running";
  const results = useMemo(() => run.results ?? [], [run.results]);
  const passedList = useMemo(() => results.filter((r) => r.status === "pass"), [results]);
  const failedList = useMemo(() => results.filter((r) => r.status === "fail"), [results]);
  const selectedPassedModels = useMemo(
    () => passedList.map((r) => r.model).filter((m) => !excludedModels.has(m)),
    [passedList, excludedModels],
  );

  const avgLatency = useMemo(() => {
    const valid = passedList.map((r) => r.latency_ms).filter((x): x is number => typeof x === "number" && x > 0);
    if (!valid.length) return null;
    return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
  }, [passedList]);

  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase();
    return results.filter((r) => {
      if (filter === "pass" && r.status !== "pass") return false;
      if (filter === "fail" && r.status !== "fail") return false;
      if (q && !`${r.model} ${r.reason} ${r.protocol_used} ${r.http_status ?? ""}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [results, filter, kw]);

  const pct = run.total_models ? Math.round((run.completed_models / run.total_models) * 100) : 0;
  const selectable = run.account_id === 0 && Boolean(onQuickAdd);

  const toggleModel = (model: string, checked: boolean) => {
    setExcludedModels((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(model);
      else next.add(model);
      return next;
    });
  };

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(buildBasicMarkdownReport(run));
      setCopiedReport(true);
      toast.success("已复制 Markdown 基础测试报告");
      setTimeout(() => setCopiedReport(false), 2000);
    } catch {
      toast.error("无法访问剪贴板");
    }
  };

  const copyPassedModels = async () => {
    if (!selectedPassedModels.length) return;
    try {
      await navigator.clipboard.writeText(selectedPassedModels.join("\n"));
      setCopiedPassed(true);
      toast.success(`已复制 ${selectedPassedModels.length} 个通的模型`);
      setTimeout(() => setCopiedPassed(false), 2000);
    } catch {
      toast.error("无法访问剪贴板");
    }
  };

  const statusTag = running ? (
    <Tag tone="info" className="gap-1">
      <Loader2 className="size-3 animate-spin" />
      并行测试中…
    </Tag>
  ) : run.passed_count > 0 && run.failed_count === 0 ? (
    <Tag tone="ok">
      全部连通 ({run.passed_count}/{run.total_models})
    </Tag>
  ) : run.passed_count > 0 ? (
    <Tag tone="warn">
      部分连通 ({run.passed_count}/{run.total_models})
    </Tag>
  ) : (
    <Tag tone="bad">全部不通 (0/{run.total_models})</Tag>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Activity className="text-primary size-5" />
          <span>基础连通测试报告</span>
          {statusTag}
          <Badge variant="outline" className="text-xs font-normal">
            {protocolLabel(run.protocol)} · 并发 {run.concurrency}
          </Badge>
        </CardTitle>
        <CardDescription>
          记录 ID <span className="font-mono">{run.id}</span> · {run.account_name} ·{" "}
          <span className="font-mono">{run.base_url}</span> · 开始于 {time(run.started_at)}
          {run.finished_at ? ` · 总耗时 ${ms(run.duration_ms)}` : ""}
        </CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          {selectable && !running ? (
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
                variant={!addedAccount && selectedPassedModels.length > 0 ? "default" : "outline"}
                disabled={selectedPassedModels.length === 0}
                onClick={() => onQuickAdd?.(selectedPassedModels)}
              >
                <PlusCircle className="size-3.5" />
                {addedAccount
                  ? `再次录入（${selectedPassedModels.length} 个通的模型）`
                  : `一键添加供应商（仅录入 ${selectedPassedModels.length} 个通的模型）`}
              </Button>
            </>
          ) : null}
          {!running && run.failed_count > 0 && onRetestFailed ? (
            <Button size="sm" variant="outline" disabled={retestingFailed} onClick={onRetestFailed}>
              <RotateCw className={cn("size-3.5", retestingFailed && "animate-spin")} />
              重测不通模型 ({run.failed_count})
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={copyReport}>
            {copiedReport ? <Check className="text-success size-3.5" /> : <Copy className="size-3.5" />}
            {copiedReport ? "已复制" : "复制报告"}
          </Button>
          {!running && onRerunAll ? (
            <Button size="sm" variant="outline" onClick={onRerunAll}>
              <RefreshCw className="size-3.5" />
              全部重测
            </Button>
          ) : null}
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-5">
        {running ? (
          <div className="space-y-2 rounded-lg border p-3.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">{run.summary}</span>
              <span className="text-muted-foreground font-mono">
                {run.completed_models} / {run.total_models} ({pct}%)
              </span>
            </div>
            <Progress value={pct} />
          </div>
        ) : null}

        <StatCards
          items={[
            { label: "拉取测试模型总数", value: run.total_models },
            { label: "通（可用模型）", value: run.passed_count, className: "text-success" },
            { label: "不通（失败模型）", value: run.failed_count, className: "text-danger" },
            { label: "通模型平均耗时", value: avgLatency != null ? ms(avgLatency) : "-" },
          ]}
        />

        {/* 通 / 不通 模型清单直观对比 */}
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="border-success/30 bg-success/[0.03] space-y-2.5 rounded-lg border p-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <CheckCircle2 className="text-success size-4" />
                <span>通的模型（{passedList.length}）</span>
              </div>
              {passedList.length > 0 ? (
                <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={copyPassedModels}>
                  {copiedPassed ? <Check className="text-success size-3" /> : <Copy className="size-3" />}
                  复制列表
                </Button>
              ) : null}
            </div>
            {passedList.length ? (
              <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
                {passedList.map((r) => {
                  const isExcluded = excludedModels.has(r.model);
                  return (
                    <Badge
                      key={r.model}
                      variant="secondary"
                      className={cn(
                        "border-success/30 bg-success/10 text-foreground font-mono text-[11px] font-normal",
                        isExcluded && "line-through opacity-45",
                      )}
                      title={`${r.reason} · ${ms(r.latency_ms)}`}
                    >
                      {r.model}
                      {r.latency_ms != null ? (
                        <span className="text-muted-foreground ml-1 text-[10px]">{ms(r.latency_ms)}</span>
                      ) : null}
                    </Badge>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">{running ? "等待模型响应…" : "暂无测试通过的模型"}</p>
            )}
          </div>

          <div className="border-danger/30 bg-danger/[0.03] space-y-2.5 rounded-lg border p-3.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              <XCircle className="text-danger size-4" />
              <span>不通的模型（{failedList.length}）</span>
            </div>
            {failedList.length ? (
              <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
                {failedList.map((r) => (
                  <Badge
                    key={r.model}
                    variant="secondary"
                    className="border-danger/30 bg-danger/10 text-foreground font-mono text-[11px] font-normal"
                    title={r.reason}
                  >
                    {r.model}
                    {r.http_status != null ? (
                      <span className="text-danger ml-1 text-[10px]">
                        {r.http_status === 0 ? "ERR" : r.http_status}
                      </span>
                    ) : null}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">{running ? "暂无失败模型" : "全部模型均连通，无不通模型"}</p>
            )}
          </div>
        </div>

        {/* 筛选与明细表 */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Tabs value={filter} onValueChange={(v) => setFilter(v as "all" | "pass" | "fail")}>
                <TabsList className="h-8">
                  <TabsTrigger value="all" className="h-6 px-2.5 text-xs">
                    全部 ({results.length})
                  </TabsTrigger>
                  <TabsTrigger value="pass" className="h-6 px-2.5 text-xs">
                    通 ({passedList.length})
                  </TabsTrigger>
                  <TabsTrigger value="fail" className="h-6 px-2.5 text-xs">
                    不通 ({failedList.length})
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="relative w-56">
                <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                <Input
                  value={kw}
                  onChange={(e) => setKw(e.target.value)}
                  placeholder="搜索模型或报错信息…"
                  className="h-8 pl-8 text-xs"
                />
              </div>
            </div>
            {selectable && passedList.length > 0 ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">
                  录入勾选：<b className="text-foreground">{selectedPassedModels.length}</b> / {passedList.length}{" "}
                  个通的模型
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setExcludedModels(new Set())}
                >
                  全选通的
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setExcludedModels(new Set(passedList.map((r) => r.model)))}
                >
                  清空勾选
                </Button>
              </div>
            ) : null}
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  {selectable ? <TableHead className="w-9" /> : null}
                  <TableHead className="w-8" />
                  <TableHead>模型 ID</TableHead>
                  <TableHead>连通状态</TableHead>
                  <TableHead>实际协议</TableHead>
                  <TableHead>HTTP</TableHead>
                  <TableHead>耗时</TableHead>
                  <TableHead>结果说明（点击行展开原文）</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length ? (
                  filtered.map((item) => (
                    <ModelResultRow
                      key={item.model}
                      item={item}
                      selectable={selectable}
                      checked={!excludedModels.has(item.model)}
                      onToggle={(chk) => toggleModel(item.model, chk)}
                    />
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={selectable ? 8 : 7} className="text-muted-foreground py-8 text-center text-sm">
                      没有匹配的模型记录
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

function BasicTestLiveRun({
  runId,
  onQuickAdd,
  onRetestFailed,
  onRerunAll,
  retestingFailed,
  addedAccount,
}: {
  runId: string;
  onQuickAdd?: (run: BasicTestRun, selectedModels: string[]) => void;
  onRetestFailed: (run: BasicTestRun) => void;
  onRerunAll: (run: BasicTestRun) => void;
  retestingFailed: boolean;
  addedAccount?: { id: number; name: string } | null;
}) {
  const q = useBasicTestRun(runId);
  if (!q.data) return <Skeleton className="h-72 w-full" />;
  const run = q.data;
  return (
    <BasicTestReportCard
      run={run}
      addedAccount={addedAccount}
      retestingFailed={retestingFailed}
      onQuickAdd={run.account_id === 0 && onQuickAdd ? (models) => onQuickAdd(run, models) : undefined}
      onRetestFailed={() => onRetestFailed(run)}
      onRerunAll={() => onRerunAll(run)}
    />
  );
}

function BasicTestReportDialog({
  runId,
  open,
  onOpenChange,
  onQuickAdd,
  onRetestFailed,
  addedAccount,
}: {
  runId: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onQuickAdd: (run: BasicTestRun, selectedModels: string[]) => void;
  onRetestFailed: (run: BasicTestRun) => void;
  addedAccount?: { id: number; name: string } | null;
}) {
  const { data, isLoading } = useBasicTestRun(open ? runId : null);
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={data ? `基础连通测试报告 · ${data.account_name}` : "基础连通测试报告"}
      className="sm:max-w-5xl"
    >
      {isLoading || !data ? (
        <div className="space-y-3 py-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <BasicTestReportCard
          run={data}
          addedAccount={addedAccount}
          onQuickAdd={data.account_id === 0 ? (models) => onQuickAdd(data, models) : undefined}
          onRetestFailed={() => onRetestFailed(data)}
        />
      )}
    </ResponsiveDialog>
  );
}

export function BasicTestView({ onOpenTemplates }: { onOpenTemplates?: () => void }) {
  const invalidate = useInvalidate();
  const [confirm, confirmEl] = useConfirm();
  const accountsQ = useAccounts();
  const runsQ = useBasicTestRuns();

  const [inputMode, setInputMode] = useState<"manual" | "account">("manual");
  const [manualUrl, setManualUrl] = useState("");
  const [manualKey, setManualKey] = useState("");
  const [manualName, setManualName] = useState("");
  const [sourceRunId, setSourceRunId] = useState("");
  const [savedSkMasked, setSavedSkMasked] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");

  const [accountId, setAccountId] = useState<number | null>(null);
  const [accountSkOverride, setAccountSkOverride] = useState("");
  const inspectQ = useVerifyAccountInspect(inputMode === "account" ? accountId : null);

  const [protocol, setProtocol] = useState<BasicTestProtocol>("auto");
  const [concurrency, setConcurrency] = useState("8");

  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<VerifyModelOption[]>([]);
  const [fetchedEndpoint, setFetchedEndpoint] = useState("");
  const [selectedToTest, setSelectedToTest] = useState<Set<string>>(() => new Set());
  const [modelFilterKw, setModelFilterKw] = useState("");

  const [starting, setStarting] = useState(false);
  const [retestingFailed, setRetestingFailed] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [viewRunId, setViewRunId] = useState<string | null>(null);
  const [manualKeyByRunId, setManualKeyByRunId] = useState<Record<string, string>>({});
  const [quickAddCtx, setQuickAddCtx] = useState<ManualVerifyQuickAddContext | null>(null);
  const [addedByRunId, setAddedByRunId] = useState<Record<string, { id: number; name: string }>>({});

  const accounts = accountsQ.data ?? [];
  const inspect = inspectQ.data;
  const historyRuns = runsQ.data ?? [];

  const targetReady =
    inputMode === "manual"
      ? URL_RE.test(manualUrl.trim()) && Boolean(manualKey.trim() || sourceRunId)
      : Boolean(accountId && inspect?.supported && (inspect.has_sk || accountSkOverride.trim()));

  const previewFilteredModels = useMemo(() => {
    const q = modelFilterKw.trim().toLowerCase();
    if (!q) return fetchedModels;
    return fetchedModels.filter((m) => m.id.toLowerCase().includes(q));
  }, [fetchedModels, modelFilterKw]);

  const fetchModelsPreview = async () => {
    if (!targetReady) return toast.error("请先填写合法的站点 URL 与 API Key（或选择有效账号）");
    setFetchingModels(true);
    try {
      const payload =
        inputMode === "account"
          ? { account_id: accountId, api_key_override: accountSkOverride.trim() || undefined }
          : {
              base_url: manualUrl.trim(),
              api_key: manualKey.trim() || undefined,
              source_run_id: !manualKey.trim() && sourceRunId ? sourceRunId : undefined,
            };
      const r = await post<VerifyFetchModelsResp>("/verify/basic-fetch-models", payload);
      setFetchedModels(r.models);
      setFetchedEndpoint(r.endpoint);
      setSelectedToTest(new Set(r.models.map((m) => m.id)));
      toast.success(`已从 ${r.endpoint} 拉取 ${r.count} 个模型`);
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setFetchingModels(false);
    }
  };

  const startBasicTest = async (overrideModels?: string[]) => {
    if (!targetReady) return toast.error("请先填写合法的上游站点 URL 与 API Key（或选择有效账号）");
    const explicitModels = overrideModels ?? (fetchedModels.length > 0 ? [...selectedToTest] : undefined);
    if (explicitModels && explicitModels.length === 0) {
      return toast.error("请至少勾选一个要测试的模型");
    }

    setStarting(true);
    try {
      const body: Record<string, unknown> = {
        mode: inputMode,
        protocol,
        concurrency: parseInt(concurrency, 10) || 8,
        models: explicitModels,
        models_endpoint: fetchedEndpoint || undefined,
      };
      if (inputMode === "manual") {
        body.base_url = manualUrl.trim();
        body.api_key = manualKey.trim() || undefined;
        body.source_run_id = !manualKey.trim() && sourceRunId ? sourceRunId : undefined;
        body.target_name = manualName.trim() || undefined;
      } else {
        body.account_id = accountId;
        body.api_key_override = accountSkOverride.trim() || undefined;
      }

      const run = await post<BasicTestRun>("/verify/basic-runs", body);
      if (inputMode === "manual" && manualKey.trim()) {
        setManualKeyByRunId((prev) => ({ ...prev, [run.id]: manualKey.trim() }));
      }
      setActiveRunId(run.id);
      invalidate("basic-runs");
      toast.success(`已拉取 ${run.total_models} 个模型，正在并发（${run.concurrency}）测试连通性…`);
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setStarting(false);
    }
  };

  const openQuickAdd = (run: BasicTestRun, selectedModels: string[]) => {
    if (!selectedModels.length) {
      toast.error("没有勾选任何通的模型，无法录入");
      return;
    }
    const isAutoName = /^基础测试\s*\(/.test(run.account_name || "");
    const platformHint = inferPlatformFromRun(run, selectedModels);
    setQuickAddCtx({
      runId: run.id,
      sourceType: "basic",
      baseUrl: run.base_url,
      apiKey: manualKeyByRunId[run.id] || "",
      skMasked: run.sk_masked,
      hasSavedKey: run.has_saved_key,
      targetName: isAutoName ? "" : run.account_name,
      channelCode: "",
      channelName: protocolLabel(run.protocol),
      platformHint,
      model: selectedModels.join(", "),
      verdict: "authentic",
      availableModels: selectedModels,
      presetModels: selectedModels,
      passedCount: run.passed_count,
      failedCount: run.failed_count,
      totalCount: run.total_models,
    });
  };

  const handleRetestFailed = async (run: BasicTestRun) => {
    setRetestingFailed(true);
    try {
      await post<BasicTestRun>(`/verify/basic-runs/${run.id}/retest-failed`, {
        concurrency: parseInt(concurrency, 10) || run.concurrency || 8,
      });
      setActiveRunId(run.id);
      invalidate("basic-run", "basic-runs");
      toast.success(`已重新并发测试 ${run.failed_count} 个不通模型`);
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setRetestingFailed(false);
    }
  };

  const handleRerunFromRun = (run: BasicTestRun) => {
    setFetchedModels([]);
    setFetchedEndpoint("");
    setSelectedToTest(new Set());
    setProtocol(run.protocol);
    setConcurrency(String(run.concurrency || 8));
    if (run.account_id > 0) {
      setInputMode("account");
      setAccountId(run.account_id);
      setAccountSkOverride("");
    } else {
      setInputMode("manual");
      setManualUrl(run.base_url);
      const isAutoName = /^基础测试\s*\(/.test(run.account_name || "");
      setManualName(isAutoName ? "" : run.account_name);
      setManualKey("");
      if (run.has_saved_key) {
        setSourceRunId(run.id);
        setSavedSkMasked(run.sk_masked);
        setSourceUrl(run.base_url);
      } else {
        setSourceRunId("");
        setSavedSkMasked("");
        setSourceUrl("");
      }
    }
    toast.info("已带入上次配置，点击「拉取全部模型并并行测试」即可开始");
  };

  const removeRun = async (run: BasicTestRun) => {
    const ok = await confirm({
      title: "删除基础测试记录？",
      description: `将删除「${run.account_name}」在 ${time(run.started_at)} 的基础连通测试记录。`,
      destructive: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await del(`/verify/basic-runs/${run.id}`);
      if (activeRunId === run.id) setActiveRunId(null);
      if (viewRunId === run.id) setViewRunId(null);
      invalidate("basic-runs");
      toast.success("已删除记录");
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <Activity className="text-primary size-4" />
            <span>模型基础连通测试</span>
            <Tag tone="info">基础测试 · 非真假检测</Tag>
          </CardTitle>
          <CardDescription>
            自动拉取上游站点全部模型并并行测试每个模型是否连通，清晰列出「通 /
            不通」清单与耗时；点击一键添加时仅录入通的模型。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Step 1: 检测对象 */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-sm font-medium">1. 选择检测对象</Label>
              <Tabs
                value={inputMode}
                onValueChange={(v) => {
                  setInputMode(v as "manual" | "account");
                  setFetchedModels([]);
                  setFetchedEndpoint("");
                  setSelectedToTest(new Set());
                }}
              >
                <TabsList className="h-8">
                  <TabsTrigger value="manual" className="h-6 px-3 text-xs">
                    <Globe className="size-3.5" />
                    直接输入 URL 与 Key
                  </TabsTrigger>
                  <TabsTrigger value="account" className="h-6 px-3 text-xs">
                    <Server className="size-3.5" />
                    选择平台账号
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {inputMode === "manual" ? (
              <div className="bg-muted/20 space-y-3 rounded-lg border p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="basic-url" className="text-xs">
                      上游站点 URL *
                    </Label>
                    <Input
                      id="basic-url"
                      placeholder="https://api.example.com（可带或不带 /v1）"
                      className="font-mono text-xs"
                      value={manualUrl}
                      onChange={(e) => {
                        const nextUrl = e.target.value;
                        setManualUrl(nextUrl);
                        setFetchedModels([]);
                        setSelectedToTest(new Set());
                        if (
                          sourceRunId &&
                          sourceUrl &&
                          nextUrl.trim().replace(/\/+$/, "") !== sourceUrl.trim().replace(/\/+$/, "")
                        ) {
                          setSourceRunId("");
                          setSavedSkMasked("");
                          setSourceUrl("");
                        }
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="basic-name" className="text-xs">
                      备注名称（可选，一键录入时自动带入账号名）
                    </Label>
                    <Input
                      id="basic-name"
                      placeholder="如 某供应商-中转（留空自动按域名命名）"
                      className="text-xs"
                      value={manualName}
                      onChange={(e) => setManualName(e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor="basic-key" className="text-xs">
                      API Key (SK) {sourceRunId && !manualKey.trim() ? "（已复用上次）" : "*"}
                    </Label>
                    {sourceRunId && !manualKey.trim() ? (
                      <div className="flex items-center gap-1.5 text-xs">
                        <Tag tone="ok" className="font-mono text-[10px]">
                          已复用上次 Key：{savedSkMasked || "后端已保存"}
                        </Tag>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground h-5 px-1.5 text-[11px]"
                          onClick={() => {
                            setSourceRunId("");
                            setSavedSkMasked("");
                            setSourceUrl("");
                          }}
                        >
                          清除
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="basic-key"
                      type="password"
                      autoComplete="off"
                      placeholder={
                        sourceRunId
                          ? `已自动复用上次测试 Key（${savedSkMasked || "已保存"}），留空直接复测，或输入新 Key 覆盖`
                          : "sk-… 或供应商 API Key（仅用于拉取模型与连通测试，一键录入时自动带入）"
                      }
                      className="flex-1 font-mono text-xs"
                      value={manualKey}
                      onChange={(e) => {
                        setManualKey(e.target.value);
                        setFetchedModels([]);
                        setSelectedToTest(new Set());
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={fetchingModels || !targetReady}
                      onClick={() => void fetchModelsPreview()}
                    >
                      <Download className={cn("size-4", fetchingModels && "animate-pulse")} />
                      {fetchingModels ? "拉取中…" : "先拉取模型预览"}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <SingleAccountPicker
                  accounts={accounts}
                  value={accountId}
                  onChange={(id) => {
                    setAccountId(id);
                    setFetchedModels([]);
                    setSelectedToTest(new Set());
                  }}
                  loading={accountsQ.isLoading}
                />
                {accountId ? (
                  inspectQ.isLoading ? (
                    <Skeleton className="h-16 w-full" />
                  ) : inspect ? (
                    <div className="bg-muted/30 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        {inspect.supported ? (
                          <span className="font-mono">{inspect.base_url}</span>
                        ) : (
                          <span className="text-danger">{inspect.unsupported_reason}</span>
                        )}
                        <span className="text-muted-foreground">·</span>
                        {inspect.has_sk ? (
                          <span className="text-success font-mono">{inspect.sk_masked}</span>
                        ) : (
                          <span className="text-warning">未读到 SK，请在下方补充</span>
                        )}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={fetchingModels || !targetReady}
                        onClick={() => void fetchModelsPreview()}
                      >
                        <Download className="size-3.5" />
                        {fetchingModels ? "拉取中…" : "先拉取模型预览"}
                      </Button>
                    </div>
                  ) : null
                ) : null}
                {accountId && inspect && !inspect.has_sk ? (
                  <Input
                    type="password"
                    autoComplete="off"
                    className="font-mono text-xs"
                    placeholder="该账号未自动读到 SK，请输入临时测试 SK"
                    value={accountSkOverride}
                    onChange={(e) => setAccountSkOverride(e.target.value)}
                  />
                ) : null}
              </div>
            )}
          </div>

          {/* Step 2: 测试协议与并行并发 */}
          <div className="grid gap-4 lg:grid-cols-[1fr_200px]">
            <div className="space-y-2">
              <Label className="text-sm font-medium">2. 测试协议</Label>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {PROTOCOL_OPTIONS.map((opt) => {
                  const active = protocol === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setProtocol(opt.value)}
                      className={cn(
                        "hover:bg-accent/50 rounded-lg border p-2.5 text-left transition-all",
                        active && "border-primary bg-primary/5 ring-primary/30 ring-1",
                      )}
                    >
                      <div className="text-xs font-medium">{opt.label}</div>
                      <div className="text-muted-foreground mt-0.5 text-[11px]">{opt.hint}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium">并行并发数</Label>
              <Select value={concurrency} onValueChange={setConcurrency}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">5 并发（保守防限流）</SelectItem>
                  <SelectItem value="8">8 并发（推荐）</SelectItem>
                  <SelectItem value="12">12 并发（较快）</SelectItem>
                  <SelectItem value="20">20 并发（极速）</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-[11px]">
                默认无需提前拉取，直接点下方按钮即可自动拉取全部模型并并行开测。
              </p>
            </div>
          </div>

          {/* 可选：如果用户点了先拉取模型预览，可按需勾选/取消勾选 */}
          {fetchedModels.length > 0 ? (
            <div className="space-y-2.5 rounded-lg border p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-medium">
                  已从 <code className="font-mono">{fetchedEndpoint}</code> 拉取 {fetchedModels.length} 个模型 · 已勾选{" "}
                  <b className="text-primary">{selectedToTest.size}</b> 个待测
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative w-48">
                    <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                    <Input
                      value={modelFilterKw}
                      onChange={(e) => setModelFilterKw(e.target.value)}
                      placeholder="筛选模型…"
                      className="h-7 pl-7 text-xs"
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => setSelectedToTest(new Set(fetchedModels.map((m) => m.id)))}
                  >
                    全选
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => setSelectedToTest(new Set())}
                  >
                    清空
                  </Button>
                </div>
              </div>
              <div className="grid max-h-48 gap-1.5 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                {previewFilteredModels.map((m) => {
                  const checked = selectedToTest.has(m.id);
                  return (
                    <label
                      key={m.id}
                      className="hover:bg-accent/40 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => {
                          setSelectedToTest((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(m.id);
                            else next.delete(m.id);
                            return next;
                          });
                        }}
                      />
                      <span className="truncate font-mono" title={m.id}>
                        {m.id}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="text-muted-foreground text-xs">
              每个模型仅发 1 条最小对话请求（<code className="font-mono">Reply OK</code>
              ，max_tokens=16），不做真假探针；单模型超时 25s。
            </p>
            <Button type="button" size="lg" disabled={starting || !targetReady} onClick={() => void startBasicTest()}>
              <Play className="size-4" />
              {starting
                ? "正在拉取并启动…"
                : fetchedModels.length > 0
                  ? `并行测试已选模型（${selectedToTest.size} 个）`
                  : "拉取全部模型并并行测试"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {activeRunId ? (
        <BasicTestLiveRun
          runId={activeRunId}
          addedAccount={addedByRunId[activeRunId] ?? null}
          retestingFailed={retestingFailed}
          onQuickAdd={(run, models) => openQuickAdd(run, models)}
          onRetestFailed={(run) => void handleRetestFailed(run)}
          onRerunAll={(run) => handleRerunFromRun(run)}
        />
      ) : null}

      {/* 最近基础测试记录 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">最近基础连通测试记录</CardTitle>
          <CardDescription>与真伪鉴定记录独立保存；可随时查看通/不通模型清单，或直接一键录入通的模型。</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => runsQ.refetch()} disabled={runsQ.isFetching}>
              <RefreshCw className={cn("size-3.5", runsQ.isFetching && "animate-spin")} />
              刷新
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {runsQ.isLoading ? (
            <Skeleton className="h-40" />
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>测试时间</TableHead>
                    <TableHead>目标与站点</TableHead>
                    <TableHead>协议</TableHead>
                    <TableHead>通 / 不通</TableHead>
                    <TableHead>耗时</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {historyRuns.length ? (
                    historyRuns.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="text-xs whitespace-nowrap" title={time(r.started_at)}>
                          <div>{time(r.started_at)}</div>
                          <div className="text-muted-foreground">{ago(r.started_at)}</div>
                        </TableCell>
                        <TableCell className="max-w-60">
                          <div className="flex items-center gap-1.5 text-xs font-medium">
                            <span className="truncate">{r.account_name}</span>
                            {r.account_id > 0 ? (
                              <span className="text-muted-foreground shrink-0 font-mono">#{r.account_id}</span>
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
                        <TableCell className="text-xs whitespace-nowrap">{protocolLabel(r.protocol)}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {r.status === "running" ? (
                            <Tag tone="info" className="gap-1">
                              <Loader2 className="size-3 animate-spin" />
                              {r.completed_models}/{r.total_models}
                            </Tag>
                          ) : (
                            <div className="flex items-center gap-1.5 font-mono text-xs">
                              <Tag tone={r.passed_count > 0 ? "ok" : "muted"}>通 {r.passed_count}</Tag>
                              <Tag tone={r.failed_count > 0 ? "bad" : "muted"}>不通 {r.failed_count}</Tag>
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs whitespace-nowrap">{ms(r.duration_ms)}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            {r.account_id === 0 && r.status !== "running" && r.passed_models.length > 0 ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-primary h-7 px-2"
                                onClick={() => openQuickAdd(r, r.passed_models)}
                              >
                                <PlusCircle className="size-3.5" />
                                录入 ({r.passed_models.length})
                              </Button>
                            ) : null}
                            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setViewRunId(r.id)}>
                              <Eye className="size-3.5" />
                              报告
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2"
                              onClick={() => handleRerunFromRun(r)}
                            >
                              <RotateCw className="size-3.5" />
                              复测
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive h-7 px-2"
                              onClick={() => void removeRun(r)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={6} className="text-muted-foreground py-8 text-center text-sm">
                        暂无基础连通测试记录
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <BasicTestReportDialog
        runId={viewRunId}
        open={Boolean(viewRunId)}
        onOpenChange={(o) => !o && setViewRunId(null)}
        addedAccount={viewRunId ? (addedByRunId[viewRunId] ?? null) : null}
        onQuickAdd={(run, models) => {
          setViewRunId(null);
          openQuickAdd(run, models);
        }}
        onRetestFailed={(run) => {
          setViewRunId(null);
          void handleRetestFailed(run);
        }}
      />

      <QuickAddAccountDialog
        ctx={quickAddCtx}
        open={Boolean(quickAddCtx)}
        onOpenChange={(o) => !o && setQuickAddCtx(null)}
        onManageTemplates={onOpenTemplates}
        onCreated={({ id, name, runId }) => {
          setAddedByRunId((prev) => ({ ...prev, [runId]: { id, name } }));
        }}
      />
      {confirmEl}
    </div>
  );
}
