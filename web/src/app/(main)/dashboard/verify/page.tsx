"use client";

import { Suspense, useState } from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Embedded, PageHeader, useTabParam } from "@/modules/ops/components/shared";
import { VerifyHistoryView } from "@/modules/ops/views/verify-history-view";
import { VerifyMethodsView } from "@/modules/ops/views/verify-methods-view";
import { VerifyRunView } from "@/modules/ops/views/verify-run-view";

const TABS = [
  ["run", "开始鉴定"],
  ["history", "鉴定记录"],
  ["methods", "方法论配置"],
] as const;

function VerifyInner() {
  const [tab, setTab] = useTabParam(
    TABS.map(([k]) => k),
    "run",
  );
  const [methodCode, setMethodCode] = useState<string | undefined>(undefined);
  const [presetRun, setPresetRun] = useState<{ accountId: number; channelCode: string; model: string } | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="渠道鉴定" description="渠道真伪检测 · 实时探针诊断 · 可更新方法论与报告存档" />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {TABS.map(([k, l]) => (
            <TabsTrigger key={k} value={k}>
              {l}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Embedded>
        {tab === "run" ? (
          <VerifyRunView
            presetRun={presetRun}
            onOpenMethods={(code) => {
              if (code) setMethodCode(code);
              setTab("methods");
            }}
          />
        ) : tab === "history" ? (
          <VerifyHistoryView
            onRerunPreset={(preset) => {
              setPresetRun({ ...preset });
              setTab("run");
            }}
          />
        ) : (
          <VerifyMethodsView initialCode={methodCode} />
        )}
      </Embedded>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyInner />
    </Suspense>
  );
}
