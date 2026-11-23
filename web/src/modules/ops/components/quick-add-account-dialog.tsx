"use client";

import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

import { useOps } from "../provider";
import type { ManualVerifyQuickAddContext } from "../types";

import { AccountForm } from "./account-form";
import { Tag } from "./badges";
import { ResponsiveDialog } from "./shared";
import { VerifyVerdictBadge } from "./verify-report";

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
  const presetModels = ctx?.presetModels ?? [];

  return (
    <ResponsiveDialog
      open={open && Boolean(ctx)}
      onOpenChange={onOpenChange}
      title={isBasic ? "一键添加供应商（仅录入通的模型）" : "一键添加供应商到系统"}
      description={
        isBasic
          ? "表单字段与 sub2api 新增账号保持一致；已自动将本次测试通过的模型填入模型映射，不包含不通模型。"
          : "表单字段与 sub2api 新增账号保持一致；已自动带入本次 URL 测试信息，可选择录入模板并按需微调。"
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
                    通 {ctx.passedCount ?? presetModels.length} / 共 {ctx.totalCount ?? presetModels.length}
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
                </>
              )}
            </div>
            <span className="text-muted-foreground max-w-full truncate font-mono" title={ctx.baseUrl}>
              {ctx.baseUrl}
            </span>
          </div>

          {isBasic && presetModels.length > 0 ? (
            <div className="border-success/30 bg-success/5 text-foreground flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs">
              <CheckCircle2 className="text-success size-4 shrink-0" />
              <span>
                已自动填入 <b>{presetModels.length}</b>{" "}
                个测试通过的模型到「模型映射」；套用模板时也会保留仅录入通的模型（展开模板详情可继续微调）。
              </span>
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
              该条早期历史记录未保存测试 Key，请在下方的「API Key」栏重新粘贴供应商 Key 后录入。
            </div>
          ) : null}

          <AccountForm
            key={`${ctx.runId}:${presetModels.join(",")}`}
            account={null}
            initialValues={{
              name: ctx.targetName,
              base_url: ctx.baseUrl,
              api_key: ctx.apiKey ?? "",
              source_verify_run_id: !ctx.apiKey && ctx.hasSavedKey ? ctx.runId : undefined,
              saved_key_masked: ctx.skMasked,
              platform: ctx.platformHint,
              preset_models: isBasic ? presetModels : undefined,
            }}
            defaultChannelCode={isBasic ? undefined : ctx.channelCode}
            availableModels={isBasic ? presetModels : ctx.availableModels}
            submitLabel={isBasic ? `确认录入（含 ${presetModels.length} 个通的模型）` : "确认录入到系统"}
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
