"use client";

import { AlertTriangle, Info } from "lucide-react";

import { useOps } from "../provider";
import type { ManualVerifyQuickAddContext } from "../types";

import { AccountForm } from "./account-form";
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

  return (
    <ResponsiveDialog
      open={open && Boolean(ctx)}
      onOpenChange={onOpenChange}
      title="一键添加供应商到系统"
      description="表单字段与 sub2api 新增账号保持一致；已自动带入本次 URL 测试信息，可选择录入模板并按需微调。"
      className="sm:max-w-4xl"
    >
      {ctx ? (
        <div className="space-y-4">
          <div className="bg-muted/30 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">测试渠道：</span>
              <span className="font-medium">{ctx.channelName}</span>
              <VerifyVerdictBadge verdict={ctx.verdict} compact />
              <span className="text-muted-foreground">· 模型</span>
              <span className="font-mono">{ctx.model}</span>
            </div>
            <span className="text-muted-foreground max-w-full truncate font-mono" title={ctx.baseUrl}>
              {ctx.baseUrl}
            </span>
          </div>

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
            key={ctx.runId}
            account={null}
            initialValues={{
              name: ctx.targetName,
              base_url: ctx.baseUrl,
              api_key: ctx.apiKey ?? "",
              source_verify_run_id: !ctx.apiKey && ctx.hasSavedKey ? ctx.runId : undefined,
              saved_key_masked: ctx.skMasked,
              platform: ctx.platformHint,
            }}
            defaultChannelCode={ctx.channelCode}
            availableModels={ctx.availableModels}
            submitLabel="确认录入到系统"
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
