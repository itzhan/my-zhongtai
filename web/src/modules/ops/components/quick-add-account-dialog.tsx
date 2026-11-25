"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { post } from "../api";
import { readErr } from "../format";
import { useOps } from "../provider";
import type { ManualVerifyQuickAddContext, VerifyFetchModelsResp } from "../types";

import { AccountForm } from "./account-form";
import { Tag } from "./badges";
import { ResponsiveDialog } from "./shared";
import { VerifyVerdictBadge } from "./verify-report";

const URL_RE = /^https?:\/\/[^/\s]+/i;

export function QuickAddAccountDialog({
  ctx,
  open,
  onOpenChange,
  onCreated,
  onManageTemplates,
}: {
  ctx: ManualVerifyQuickAddContext | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (created: { id: number; name: string; runId: string }) => void;
  onManageTemplates?: () => void;
}) {
  const { readonly } = useOps();
  const isBasic = ctx?.sourceType === "basic";
  const hasVerifiedAvailableModels = Boolean(isBasic || ctx?.modelsChecked);
  const verifiedPresetModels = useMemo(
    () => [...new Set((ctx?.presetModels ?? []).map((m) => m.trim()).filter(Boolean))],
    [ctx?.presetModels],
  );
  const ctxAvailableModels = useMemo(
    () => [...new Set((ctx?.availableModels ?? []).map((m) => m.trim()).filter(Boolean))],
    [ctx?.availableModels],
  );

  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchEndpoint, setFetchEndpoint] = useState("");
  const [fetchError, setFetchError] = useState("");
  const [modelSyncVersion, setModelSyncVersion] = useState(0);
  const fetchedRunKeyRef = useRef("");

  const canAutoFetch = Boolean(
    ctx &&
    !hasVerifiedAvailableModels &&
    URL_RE.test((ctx.baseUrl || "").trim()) &&
    (ctx.apiKey?.trim() || ctx.hasSavedKey),
  );

  const runFetchModels = useCallback(
    async (opts: { silent: boolean; forceSync?: boolean }) => {
      if (!ctx || hasVerifiedAvailableModels) return;
      const url = (ctx.baseUrl || "").trim();
      const key = (ctx.apiKey || "").trim();
      const canReuse = Boolean(!key && ctx.hasSavedKey && ctx.runId);
      if (!URL_RE.test(url) || (!key && !canReuse)) return;

      setFetchingModels(true);
      setFetchError("");
      try {
        const r = await post<VerifyFetchModelsResp>("/verify/fetch-models", {
          base_url: url,
          api_key: key || undefined,
          source_run_id: canReuse ? ctx.runId : undefined,
        });
        const ids = [...new Set(r.models.map((m) => m.id.trim()).filter(Boolean))];
        setFetchedModels(ids);
        setFetchEndpoint(r.endpoint || "");
        if (opts.forceSync) setModelSyncVersion((n) => n + 1);
        if (!opts.silent) {
          toast.success(`已从上游 ${r.endpoint} 获取 ${ids.length} 个模型 ID 并填入模型映射`);
        }
      } catch (e) {
        const msg = readErr(e);
        setFetchError(msg);
        if (!opts.silent) toast.error(msg);
      } finally {
        setFetchingModels(false);
      }
    },
    [ctx, hasVerifiedAvailableModels],
  );

  useEffect(() => {
    if (!open || !ctx) {
      fetchedRunKeyRef.current = "";
      return;
    }
    if (hasVerifiedAvailableModels) {
      setFetchedModels([]);
      setFetchEndpoint("");
      setFetchError("");
      setFetchingModels(false);
      return;
    }
    const runKey = `${ctx.runId}|${ctx.baseUrl}|${ctx.apiKey ? "k" : ctx.hasSavedKey ? "s" : "n"}`;
    if (fetchedRunKeyRef.current === runKey) return;
    fetchedRunKeyRef.current = runKey;

    setFetchError("");
    setFetchEndpoint("");
    if (ctxAvailableModels.length > 0) {
      setFetchedModels(ctxAvailableModels);
      setFetchingModels(false);
      return;
    }
    setFetchedModels([]);
    if (canAutoFetch) {
      void runFetchModels({ silent: true });
    }
  }, [open, ctx, hasVerifiedAvailableModels, ctxAvailableModels, canAutoFetch, runFetchModels]);

  const effectivePresetModels = hasVerifiedAvailableModels ? verifiedPresetModels : fetchedModels;
  const effectiveAvailableModels = hasVerifiedAvailableModels
    ? verifiedPresetModels
    : fetchedModels.length > 0
      ? fetchedModels
      : ctxAvailableModels;

  return (
    <ResponsiveDialog
      open={open && Boolean(ctx)}
      onOpenChange={onOpenChange}
      title={hasVerifiedAvailableModels ? "一键添加供应商（仅录入可用模型）" : "一键添加供应商到系统"}
      description={
        hasVerifiedAvailableModels
          ? "表单字段与 sub2api 新增账号保持一致；已自动将本次并行测试通过的可用模型填入模型映射，排除不通模型。"
          : "表单字段与 sub2api 新增账号保持一致；已自动获取上游可用模型 ID 填入模型映射，避免未限制模型导致 404。"
      }
      className="sm:max-w-4xl"
    >
      {ctx ? (
        <div className="space-y-4">
          <div className="bg-muted/30 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              {isBasic ? (
                <>
                  <Tag tone="info">基础连通测试</Tag>
                  <Tag tone="ok">
                    通 {ctx.passedCount ?? verifiedPresetModels.length} / 共{" "}
                    {ctx.totalCount ?? verifiedPresetModels.length}
                  </Tag>
                  {(ctx.failedCount ?? 0) > 0 ? <Tag tone="bad">已排除 {ctx.failedCount} 个不通</Tag> : null}
                  <span className="text-muted-foreground">· 协议 {ctx.channelName}</span>
                </>
              ) : (
                <>
                  <span className="text-muted-foreground">测试渠道：</span>
                  <span className="font-medium">{ctx.channelName}</span>
                  <VerifyVerdictBadge verdict={ctx.verdict} compact />
                  <span className="text-muted-foreground">· 模型</span>
                  <span className="font-mono">{ctx.model}</span>
                  {ctx.modelsChecked ? (
                    <>
                      <Tag tone="ok">
                        可用 {ctx.passedCount ?? verifiedPresetModels.length} / 共{" "}
                        {ctx.totalCount ?? verifiedPresetModels.length}
                      </Tag>
                      {(ctx.failedCount ?? 0) > 0 ? <Tag tone="bad">已排除 {ctx.failedCount} 个不通</Tag> : null}
                    </>
                  ) : null}
                </>
              )}
            </div>
            <span className="text-muted-foreground max-w-full truncate font-mono" title={ctx.baseUrl}>
              {ctx.baseUrl}
            </span>
          </div>

          {hasVerifiedAvailableModels && verifiedPresetModels.length > 0 ? (
            <div className="border-success/30 bg-success/5 text-foreground flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs">
              <CheckCircle2 className="text-success size-4 shrink-0" />
              <span>
                已自动填入 <b>{verifiedPresetModels.length}</b> 个并行测试通过的可用模型 ID 到「模型映射」
                {(ctx.failedCount ?? 0) > 0 ? `（已自动排除 ${ctx.failedCount} 个不通模型）` : ""}
                ；套用模板时也会保留仅录入可用模型（展开模板详情可继续微调）。
              </span>
            </div>
          ) : null}

          {hasVerifiedAvailableModels && verifiedPresetModels.length === 0 ? (
            <div className="border-warning/40 bg-warning/10 text-warning flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs">
              <AlertTriangle className="size-4 shrink-0" />
              <span>
                本次并行模型可用性测试中 0 / {ctx.totalCount ?? 0}{" "}
                个模型可用。建议先在报告中排查原因或重测不通模型，或在下方「模型映射」手动指定模型后再录入。
              </span>
            </div>
          ) : null}

          {!hasVerifiedAvailableModels && fetchingModels ? (
            <div className="border-info/30 bg-info/5 text-foreground flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs">
              <Loader2 className="text-info size-4 shrink-0 animate-spin" />
              <span>正在自动从上游拉取可用模型 ID 并填入「模型映射」…</span>
            </div>
          ) : null}

          {!hasVerifiedAvailableModels && !fetchingModels && fetchedModels.length > 0 ? (
            <div className="border-success/30 bg-success/5 text-foreground flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3.5 py-2 text-xs">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="text-success size-4 shrink-0" />
                <span>
                  已自动获取上游 <b>{fetchedModels.length}</b> 个模型 ID
                  {fetchEndpoint ? `（${fetchEndpoint}）` : ""}
                  并填入「模型映射」；套用模板时也会保留（展开模板详情可按需增删）。
                </span>
              </div>
              {canAutoFetch ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => void runFetchModels({ silent: false, forceSync: true })}
                >
                  <RefreshCw className="size-3" />
                  重新拉取
                </Button>
              ) : null}
            </div>
          ) : null}

          {!hasVerifiedAvailableModels && !fetchingModels && fetchError ? (
            <div className="border-warning/40 bg-warning/10 text-warning flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3.5 py-2 text-xs">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-4 shrink-0" />
                <span>
                  自动获取上游模型失败：{fetchError}。未限制模型映射可能导致调度到不支持的模型报
                  404，建议重试或在下方「模型映射」手动补充。
                </span>
              </div>
              {canAutoFetch ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  onClick={() => void runFetchModels({ silent: false, forceSync: true })}
                >
                  <RefreshCw className="size-3" />
                  重试拉取
                </Button>
              ) : null}
            </div>
          ) : null}

          {readonly ? (
            <div className="border-warning/40 bg-warning/10 text-warning flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs">
              <AlertTriangle className="size-4 shrink-0" />
              当前后端处于只读模式（READONLY=1），点击录入将被后端拦截，不会修改线上 sub2api。
            </div>
          ) : null}

          {!ctx.apiKey && !ctx.hasSavedKey ? (
            <div className="border-info/30 bg-info/5 text-muted-foreground flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs">
              <Info className="text-info size-4 shrink-0" />
              该条早期历史记录未保存测试 Key，请在下方的「API Key」栏重新粘贴供应商 Key，再点「拉取上游模型」后录入。
            </div>
          ) : null}

          <AccountForm
            key={ctx.runId}
            account={null}
            initialValues={{
              name: ctx.targetName,
              base_url: ctx.baseUrl,
              api_key: ctx.apiKey ?? "",
              source_verify_run_id: !ctx.apiKey && ctx.hasSavedKey ? ctx.runId : undefined,
              saved_key_masked: ctx.skMasked,
              platform: ctx.platformHint,
              preset_models: effectivePresetModels.length > 0 ? effectivePresetModels : undefined,
            }}
            presetModelsLabel={hasVerifiedAvailableModels ? "仅可用模型" : "上游模型"}
            presetModelsSyncVersion={modelSyncVersion}
            defaultChannelCode={isBasic ? undefined : ctx.channelCode}
            availableModels={effectiveAvailableModels}
            submitDisabled={fetchingModels}
            submitLabel={
              fetchingModels
                ? "正在获取上游模型…"
                : hasVerifiedAvailableModels
                  ? `确认录入（仅含 ${verifiedPresetModels.length} 个可用模型）`
                  : fetchedModels.length > 0
                    ? `确认录入（含 ${fetchedModels.length} 个上游模型）`
                    : "确认录入到系统"
            }
            onCancel={() => onOpenChange(false)}
            onManageTemplates={
              onManageTemplates
                ? () => {
                    onOpenChange(false);
                    onManageTemplates();
                  }
                : undefined
            }
            onSuccess={(created) => {
              onCreated?.({ ...created, runId: ctx.runId });
              onOpenChange(false);
            }}
          />
        </div>
      ) : null}
    </ResponsiveDialog>
  );
}
