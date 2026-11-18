"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Check,
  ChevronsUpDown,
  Download,
  Globe,
  KeyRound,
  Play,
  RefreshCw,
  Search,
  Server,
  Settings2,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { post, put } from "../api";
import { AccountStatus, PlatformBadge, Tag } from "../components/badges";
import { VerifyReportCard } from "../components/verify-report";
import { readErr } from "../format";
import { useAccounts, useInvalidate, useVerifyAccountInspect, useVerifyChannels, useVerifyRun } from "../hooks";
import { useOps } from "../provider";
import type { Account, VerifyChannel, VerifyFetchModelsResp, VerifyModelOption, VerifyPreset } from "../types";

const MAX_ACCOUNT_DROPDOWN = 40;
const URL_RE = /^https?:\/\/[^/\s]+/i;

function protocolLabel(p: string): string {
  switch (p) {
    case "gemini_native":
      return "Gemini 原生";
    case "anthropic_messages":
      return "Anthropic Messages";
    case "openai_chat":
      return "OpenAI Chat";
    case "openai_responses":
      return "OpenAI Responses";
    default:
      return p;
  }
}

function isRecommendedModel(modelId: string, platformHint?: string): boolean {
  const m = modelId.toLowerCase();
  switch (platformHint) {
    case "gemini":
      return m.includes("gemini");
    case "anthropic":
      return /claude|opus|sonnet|haiku|fable/.test(m);
    case "openai":
      return /^(gpt|o1|o3|o4|codex|chatgpt)/.test(m);
    default:
      return false;
  }
}

function AccountSearchPicker({
  accounts,
  value,
  onChange,
  loading,
}: {
  accounts: Account[];
  value: number | null;
  onChange: (id: number) => void;
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
            </div>
          ) : (
            <span className="text-muted-foreground flex items-center gap-2">
              <Search className="size-4" />
              {loading ? "正在加载平台账号列表…" : `搜索并选择账号（共 ${accounts.length} 个）`}
            </span>
          )}
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="按账号名称、ID、平台、分组、备注搜索…" value={kw} onValueChange={setKw} />
          <CommandList className="max-h-72">
            {shown.length === 0 ? (
              <CommandEmpty>{loading ? "加载账号中…" : "没有匹配的账号"}</CommandEmpty>
            ) : (
              <CommandGroup
                heading={`匹配账号 ${filtered.length} 个${filtered.length > MAX_ACCOUNT_DROPDOWN ? `（展示前 ${MAX_ACCOUNT_DROPDOWN} 个）` : ""}`}
              >
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
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <Check className={cn("size-3.5 shrink-0", value === a.id ? "opacity-100" : "opacity-0")} />
                        <span className="truncate font-medium">{a.name}</span>
                        <span className="text-muted-foreground shrink-0 font-mono text-xs">#{a.id}</span>
                      </div>
                      {a.notes ? <p className="text-muted-foreground truncate pl-5 text-[11px]">{a.notes}</p> : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <PlatformBadge platform={a.platform} />
                    </div>
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

function ModelPicker({
  models,
  platformHint,
  value,
  onChange,
  disabled,
}: {
  models: VerifyModelOption[];
  platformHint?: string;
  value: string;
  onChange: (modelId: string, requested: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [kw, setKw] = useState("");
  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => `${m.id} ${m.requested} ${m.source}`.toLowerCase().includes(q));
  }, [models, kw]);

  const { recommended, others } = useMemo(() => {
    if (!platformHint) return { recommended: [] as VerifyModelOption[], others: filtered };
    const rec: VerifyModelOption[] = [];
    const rest: VerifyModelOption[] = [];
    for (const m of filtered) {
      if (isRecommendedModel(m.id, platformHint)) rec.push(m);
      else rest.push(m);
    }
    return { recommended: rec, others: rest };
  }, [filtered, platformHint]);

  const renderItem = (m: VerifyModelOption) => (
    <CommandItem
      key={`${m.id}::${m.requested}`}
      value={`${m.id}::${m.requested}`}
      onSelect={() => {
        onChange(m.id, m.requested);
        setOpen(false);
      }}
      className="flex items-center justify-between gap-2"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Check className={cn("size-3.5 shrink-0", value === m.id ? "opacity-100" : "opacity-0")} />
        <span className="truncate font-mono text-xs">{m.label}</span>
      </div>
      <Badge variant="secondary" className="shrink-0 text-[10px] font-normal">
        {m.source}
      </Badge>
    </CommandItem>
  );

  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="w-full justify-between font-normal sm:w-80"
          >
            <span className="truncate">
              {models.length ? `从上游可用模型中选择 (${models.length})` : "暂未拉取到模型列表（可手输）"}
            </span>
            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-96 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="搜索可用模型 ID…" value={kw} onValueChange={setKw} />
            <CommandList className="max-h-72">
              {filtered.length === 0 ? (
                <CommandEmpty>无匹配模型，可在右侧直接输入模型名</CommandEmpty>
              ) : (
                <>
                  {recommended.length ? (
                    <CommandGroup heading={`匹配当前渠道的模型 (${recommended.length})`}>
                      {recommended.map(renderItem)}
                    </CommandGroup>
                  ) : null}
                  {others.length ? (
                    <CommandGroup
                      heading={recommended.length ? `其他可用模型 (${others.length})` : `可用模型 (${others.length})`}
                    >
                      {others.map(renderItem)}
                    </CommandGroup>
                  ) : null}
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Input
        value={value}
        disabled={disabled}
        placeholder="或直接输入测试模型 ID，如 gemini-2.5-pro"
        className="flex-1 font-mono text-xs"
        onChange={(e) => onChange(e.target.value, "")}
      />
    </div>
  );
}

export function VerifyRunView({
  onOpenMethods,
  presetRun,
}: {
  onOpenMethods: (channelCode?: string) => void;
  presetRun?: VerifyPreset | null;
}) {
  const invalidate = useInvalidate();
  const accountsQ = useAccounts();
  const channelsQ = useVerifyChannels();

  const [inputMode, setInputMode] = useState<"account" | "manual">(presetRun?.mode ?? "account");
  const [accountId, setAccountId] = useState<number | null>(presetRun?.mode === "account" ? presetRun.accountId : null);
  const [manualUrl, setManualUrl] = useState<string>(presetRun?.mode === "manual" ? presetRun.baseUrl : "");
  const [manualKey, setManualKey] = useState<string>("");
  const [manualName, setManualName] = useState<string>(presetRun?.mode === "manual" ? presetRun.targetName : "");

  const [channelCode, setChannelCode] = useState<string>(presetRun?.channelCode ?? "vertex_gemini");
  const [model, setModel] = useState<string>(presetRun?.model ?? "");
  const [requestedModel, setRequestedModel] = useState<string>("");
  const [customSkOpen, setCustomSkOpen] = useState(false);
  const [customSk, setCustomSk] = useState("");
  const [saveSk, setSaveSk] = useState(true);

  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchStatusText, setFetchStatusText] = useState<string>("");
  const [fetchErrorText, setFetchErrorText] = useState<string>("");
  const [accountModelsOverride, setAccountModelsOverride] = useState<VerifyModelOption[] | null>(null);
  const [manualModels, setManualModels] = useState<VerifyModelOption[]>([]);

  const [starting, setStarting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const initedAccountRef = useRef<number | null>(
    presetRun?.mode === "account" && presetRun.model ? presetRun.accountId : null,
  );
  const lastManualAutoFetchRef = useRef<string>("");

  useEffect(() => {
    if (!presetRun) return;
    setInputMode(presetRun.mode);
    setChannelCode(presetRun.channelCode);
    setModel(presetRun.model);
    setRequestedModel("");
    setFetchStatusText("");
    setFetchErrorText("");
    if (presetRun.mode === "account") {
      initedAccountRef.current = presetRun.model ? presetRun.accountId : null;
      setAccountId(presetRun.accountId);
      setAccountModelsOverride(null);
    } else {
      initedAccountRef.current = null;
      setManualUrl(presetRun.baseUrl);
      setManualName(presetRun.targetName);
      setManualModels([]);
      lastManualAutoFetchRef.current = "";
    }
  }, [presetRun]);

  const inspectQ = useVerifyAccountInspect(inputMode === "account" ? accountId : null);
  const runQ = useVerifyRun(activeRunId);

  const channels = useMemo(() => channelsQ.data ?? [], [channelsQ.data]);
  const selectedChannel: VerifyChannel | undefined = useMemo(
    () => channels.find((c) => c.code === channelCode) ?? channels[0],
    [channels, channelCode],
  );

  // 切换账号时同步重置模型与覆盖模型列表
  const handleSelectAccount = (id: number) => {
    initedAccountRef.current = null;
    setAccountId(id);
    setModel("");
    setRequestedModel("");
    setCustomSk("");
    setCustomSkOpen(false);
    setAccountModelsOverride(null);
    setFetchStatusText("");
    setFetchErrorText("");
  };

  // 拉取标准上游模型列表
  const fetchModelsFromUpstream = useCallback(
    async ({ silent }: { silent: boolean }) => {
      if (inputMode === "account") {
        if (!accountId) return;
        setFetchingModels(true);
        setFetchErrorText("");
        try {
          const r = await post<VerifyFetchModelsResp>("/verify/fetch-models", {
            account_id: accountId,
            api_key_override: customSk.trim() || undefined,
          });
          setAccountModelsOverride(r.models);
          setFetchStatusText(`已从上游 ${r.endpoint} 获取 ${r.count} 个可用模型`);
          if (!silent) toast.success(`已拉取 ${r.count} 个模型`);
        } catch (e) {
          const msg = readErr(e);
          setFetchErrorText(msg);
          if (!silent) toast.error(msg);
        } finally {
          setFetchingModels(false);
        }
        return;
      }

      const url = manualUrl.trim();
      const key = manualKey.trim();
      if (!URL_RE.test(url) || !key) {
        if (!silent) toast.error("请先填写合法的上游站点 URL 与 API Key");
        return;
      }
      setFetchingModels(true);
      setFetchErrorText("");
      try {
        const r = await post<VerifyFetchModelsResp>("/verify/fetch-models", {
          base_url: url,
          api_key: key,
        });
        setManualModels(r.models);
        setFetchStatusText(`已从上游 ${r.endpoint} 获取 ${r.count} 个可用模型`);
        const pick = r.models.find((m) => isRecommendedModel(m.id, selectedChannel?.platform_hint)) ?? r.models[0];
        if (!model.trim() && pick) {
          setModel(pick.id);
          setRequestedModel(pick.requested);
        }
        if (!silent) toast.success(`已拉取 ${r.count} 个模型`);
      } catch (e) {
        const msg = readErr(e);
        setFetchErrorText(msg);
        if (!silent) toast.error(msg);
      } finally {
        setFetchingModels(false);
      }
    },
    [inputMode, accountId, customSk, manualUrl, manualKey, model, selectedChannel?.platform_hint],
  );

  // 手动模式：输入完整 URL + Key 后自动防抖 600ms 拉取一次标准模型列表
  useEffect(() => {
    if (inputMode !== "manual") return;
    const url = manualUrl.trim();
    const key = manualKey.trim();
    if (!URL_RE.test(url) || key.length < 6) return;
    const sig = `${url}|${key}`;
    if (lastManualAutoFetchRef.current === sig) return;
    const timer = setTimeout(() => {
      lastManualAutoFetchRef.current = sig;
      void fetchModelsFromUpstream({ silent: true });
    }, 600);
    return () => clearTimeout(timer);
  }, [inputMode, manualUrl, manualKey, fetchModelsFromUpstream]);

  useEffect(() => {
    if (inputMode !== "account" || !inspectQ.data) return;
    if (initedAccountRef.current === inspectQ.data.account.id) return;
    initedAccountRef.current = inspectQ.data.account.id;
    const firstModel =
      inspectQ.data.models.find((m) => isRecommendedModel(m.id, selectedChannel?.platform_hint)) ??
      inspectQ.data.models[0];
    if (firstModel) {
      setModel(firstModel.id);
      setRequestedModel(firstModel.requested);
    }
    if (!inspectQ.data.has_sk) {
      setCustomSkOpen(true);
    }
  }, [inputMode, inspectQ.data, selectedChannel?.platform_hint]);

  const accounts = accountsQ.data ?? [];
  const selectedAccount = accounts.find((a) => a.id === accountId) ?? null;

  const saveStandaloneKey = async () => {
    if (!accountId) return;
    try {
      await put(`/verify/accounts/${accountId}/key`, { api_key: customSk.trim() });
      toast.success(customSk.trim() ? "已保存该账号测试 SK" : "已清除本地覆盖 SK");
      setCustomSk("");
      setCustomSkOpen(false);
      setAccountModelsOverride(null);
      invalidate("verify-inspect");
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  const startVerify = async () => {
    if (!selectedChannel) return toast.error("请选择渠道类型");
    if (!selectedChannel.ready) {
      return toast.error(`渠道「${selectedChannel.name}」尚未配置启用的特征探针，请先到「方法论配置」添加探针`);
    }
    const trimmedModel = model.trim();
    if (!trimmedModel) return toast.error("请选择或输入测试模型");

    if (inputMode === "manual") {
      const url = manualUrl.trim();
      const key = manualKey.trim();
      if (!URL_RE.test(url)) return toast.error("请输入合法的上游站点 URL（以 http:// 或 https:// 开头）");
      if (!key) return toast.error("请输入测试 API Key (SK)");
      setStarting(true);
      try {
        const r = await post<{ id: string }>("/verify/runs", {
          mode: "manual",
          base_url: url,
          api_key: key,
          target_name: manualName.trim() || undefined,
          channel_code: selectedChannel.code,
          model: trimmedModel,
        });
        setActiveRunId(r.id);
        invalidate("verify-runs");
      } catch (e) {
        toast.error(readErr(e));
      } finally {
        setStarting(false);
      }
      return;
    }

    if (!accountId) return toast.error("请先搜索并选择要鉴定的账号");
    const override = customSk.trim();
    if (!inspectQ.data?.has_sk && !override) return toast.error("未能自动读取该账号的 SK，请先填写测试 SK");

    setStarting(true);
    try {
      const r = await post<{ id: string }>("/verify/runs", {
        mode: "account",
        account_id: accountId,
        channel_code: selectedChannel.code,
        model: trimmedModel,
        requested_model: requestedModel || undefined,
        api_key_override: override || undefined,
        save_key: Boolean(override && saveSk),
      });
      setActiveRunId(r.id);
      if (override && saveSk) {
        setCustomSk("");
        setCustomSkOpen(false);
        invalidate("verify-inspect");
      }
      invalidate("verify-runs");
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setStarting(false);
    }
  };

  const inspect = inspectQ.data;
  const availableModels = inputMode === "manual" ? manualModels : (accountModelsOverride ?? inspect?.models ?? []);
  const isRunning = runQ.data?.status === "running";
  const targetReady =
    inputMode === "manual"
      ? URL_RE.test(manualUrl.trim()) && Boolean(manualKey.trim())
      : Boolean(accountId && inspect?.supported);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="text-primary size-4" />
            发起渠道鉴定
          </CardTitle>
          <CardDescription>
            支持从平台已有账号发起鉴定，或直接输入未录入站点的 URL 与 Key 进行预检；标准拉取上游可用模型列表，全程脱敏。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Step 1: 检测目标来源（平台账号 / 手动 URL + Key） */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-sm font-medium">1. 选择检测对象</Label>
              <Tabs
                value={inputMode}
                onValueChange={(v) => {
                  const next = v as "account" | "manual";
                  setInputMode(next);
                  setFetchStatusText("");
                  setFetchErrorText("");
                }}
              >
                <TabsList className="h-8">
                  <TabsTrigger value="account" className="h-6 px-3 text-xs">
                    <Server className="size-3.5" />
                    选择平台账号
                  </TabsTrigger>
                  <TabsTrigger value="manual" className="h-6 px-3 text-xs">
                    <Globe className="size-3.5" />
                    直接输入 URL 与 Key
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {inputMode === "account" ? (
              <div className="space-y-2">
                <div className="flex items-center justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => accountsQ.refetch()}
                    disabled={accountsQ.isFetching}
                  >
                    <RefreshCw className={cn("size-3", accountsQ.isFetching && "animate-spin")} />
                    刷新账号
                  </Button>
                </div>
                <AccountSearchPicker
                  accounts={accounts}
                  value={accountId}
                  onChange={handleSelectAccount}
                  loading={accountsQ.isLoading}
                />

                {accountId ? (
                  inspectQ.isLoading ? (
                    <Skeleton className="h-20 w-full" />
                  ) : inspectQ.isError ? (
                    <div className="border-danger/30 bg-danger/5 text-danger rounded-lg border px-3 py-2 text-xs">
                      读取账号配置失败：{readErr(inspectQ.error)}
                    </div>
                  ) : inspect ? (
                    <div className="bg-muted/30 space-y-3 rounded-lg border p-3.5 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{inspect.account.name}</span>
                          <span className="text-muted-foreground font-mono">#{inspect.account.id}</span>
                          {selectedAccount ? <AccountStatus a={selectedAccount} /> : null}
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => setCustomSkOpen((v) => !v)}
                        >
                          <KeyRound className="size-3.5" />
                          {customSkOpen ? "收起 SK 设置" : "更换 / 覆盖测试 SK"}
                        </Button>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div>
                          <span className="text-muted-foreground">上游站点地址：</span>
                          {inspect.supported ? (
                            <span className="font-mono break-all">{inspect.base_url}</span>
                          ) : (
                            <span className="text-danger">{inspect.unsupported_reason}</span>
                          )}
                        </div>
                        <div>
                          <span className="text-muted-foreground">检测 SK：</span>
                          {inspect.has_sk ? (
                            <span className="text-success font-mono">{inspect.sk_masked}（已就绪）</span>
                          ) : (
                            <span className="text-warning">未自动读取到明文 SK，请在下方填入测试 SK</span>
                          )}
                        </div>
                      </div>
                      {customSkOpen ? (
                        <div className="bg-background space-y-2 rounded-md border p-3">
                          <Label htmlFor="verify-sk-input" className="text-xs">
                            手动填入 / 覆盖该账号测试 SK
                          </Label>
                          <div className="flex flex-wrap gap-2">
                            <Input
                              id="verify-sk-input"
                              type="password"
                              autoComplete="off"
                              className="h-8 flex-1 font-mono text-xs"
                              placeholder={inspect.has_sk ? "留空则继续使用自动读取的 SK" : "输入 sk-… 或上游 API Key"}
                              value={customSk}
                              onChange={(e) => setCustomSk(e.target.value)}
                            />
                            {customSk.trim() ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-8"
                                onClick={saveStandaloneKey}
                              >
                                仅保存 SK
                              </Button>
                            ) : inspect.sk_source === "saved_key" ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-8"
                                onClick={saveStandaloneKey}
                              >
                                清除覆盖 SK
                              </Button>
                            ) : null}
                          </div>
                          <label className="text-muted-foreground flex items-center gap-2 text-xs">
                            <Checkbox checked={saveSk} onCheckedChange={(v) => setSaveSk(!!v)} />
                            启动检测时同时记住该 SK，下次选此账号自动复用
                          </label>
                        </div>
                      ) : null}
                    </div>
                  ) : null
                ) : null}
              </div>
            ) : (
              <div className="bg-muted/20 space-y-3 rounded-lg border p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="manual-url" className="text-xs">
                      上游站点 URL *
                    </Label>
                    <Input
                      id="manual-url"
                      placeholder="https://api.example.com（可带或不带 /v1）"
                      className="font-mono text-xs"
                      value={manualUrl}
                      onChange={(e) => setManualUrl(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="manual-name" className="text-xs">
                      备注名称（可选，方便历史记录识别）
                    </Label>
                    <Input
                      id="manual-name"
                      placeholder="如 某供应商-Vertex 试测（留空自动按域名命名）"
                      className="text-xs"
                      value={manualName}
                      onChange={(e) => setManualName(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="manual-key" className="text-xs">
                    测试 API Key (SK) *
                  </Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="manual-key"
                      type="password"
                      autoComplete="off"
                      placeholder="sk-… 或供应商 API Key（仅用于本次测试与拉取模型，报告中会自动脱敏）"
                      className="flex-1 font-mono text-xs"
                      value={manualKey}
                      onChange={(e) => setManualKey(e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={fetchingModels || !URL_RE.test(manualUrl.trim()) || !manualKey.trim()}
                      onClick={() => fetchModelsFromUpstream({ silent: false })}
                    >
                      <Download className={cn("size-4", fetchingModels && "animate-pulse")} />
                      {fetchingModels ? "拉取中…" : "获取模型列表"}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Step 2: 选择渠道类型 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">2. 选择渠道类型（待鉴定的目标渠道）</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => onOpenMethods(selectedChannel?.code)}
              >
                <Settings2 className="size-3.5" />
                管理渠道方法论
              </Button>
            </div>
            {channelsQ.isLoading ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            ) : (
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {channels.map((ch) => {
                  const active = selectedChannel?.code === ch.code;
                  return (
                    <button
                      key={ch.code}
                      type="button"
                      onClick={() => setChannelCode(ch.code)}
                      className={cn(
                        "hover:bg-accent/50 flex flex-col justify-between rounded-lg border p-3 text-left transition-all",
                        active && "border-primary bg-primary/5 ring-primary/30 ring-1",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{ch.name}</span>
                        {ch.ready ? (
                          <Tag tone="ok" className="text-[10px]">
                            {ch.fingerprint_count} 探针 · v{ch.version}
                          </Tag>
                        ) : (
                          <Tag tone="muted" className="text-[10px]">
                            待完善
                          </Tag>
                        )}
                      </div>
                      <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">{ch.summary || "暂无说明"}</p>
                      <div className="text-muted-foreground mt-2 flex items-center justify-between text-[11px]">
                        <span>{protocolLabel(ch.protocol)}</span>
                        <span className="font-mono">{ch.code}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {selectedChannel && !selectedChannel.ready ? (
              <div className="border-warning/40 bg-warning/10 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
                <span>
                  渠道「{selectedChannel.name}」的架子已就绪，但当前还没有启用的特征探针。您可以先前往配置或补充规则。
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7"
                  onClick={() => onOpenMethods(selectedChannel.code)}
                >
                  前往配置探针
                </Button>
              </div>
            ) : null}
          </div>

          {/* Step 3: 选择测试模型 */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-sm font-medium">3. 选择测试模型（标准拉取上游可用模型或直接输入）</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={fetchingModels || !targetReady}
                onClick={() => fetchModelsFromUpstream({ silent: false })}
              >
                <RefreshCw className={cn("size-3", fetchingModels && "animate-spin")} />
                {fetchingModels ? "拉取上游模型中…" : "拉取上游模型"}
              </Button>
            </div>
            <ModelPicker
              models={availableModels}
              platformHint={selectedChannel?.platform_hint}
              value={model}
              disabled={inputMode === "account" ? !accountId || inspectQ.isLoading : false}
              onChange={(mId, reqId) => {
                setModel(mId);
                setRequestedModel(reqId);
              }}
            />
            {fetchStatusText ? (
              <p className="text-success text-xs">{fetchStatusText}</p>
            ) : fetchErrorText ? (
              <p className="text-warning text-xs">{fetchErrorText}</p>
            ) : (
              <p className="text-muted-foreground text-xs">
                自动通过标准接口（<code className="font-mono">GET /v1/models</code> 与{" "}
                <code className="font-mono">GET /v1beta/models</code>）拉取上游真实可用模型；也支持直接填写任意模型名。
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="text-muted-foreground text-xs">
              {selectedChannel ? (
                <>
                  将按「{selectedChannel.name}」v{selectedChannel.version} 方法论依次发送{" "}
                  <b className="text-foreground">{selectedChannel.enabled_probe_count}</b> 条探测请求（产生极少 token
                  消耗）。
                </>
              ) : null}
            </div>
            <Button
              type="button"
              size="lg"
              disabled={starting || isRunning || !targetReady || !selectedChannel?.ready || !model.trim()}
              onClick={startVerify}
            >
              <Play className="size-4" />
              {starting || isRunning ? "正在检测中…" : "开始渠道鉴定"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {runQ.data ? (
        <VerifyReportCard run={runQ.data} onRerun={startVerify} rerunning={starting} />
      ) : activeRunId && runQ.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : null}
    </div>
  );
}
