"use client";

import { Suspense } from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Embedded, PageHeader, useTabParam } from "@/modules/ops/components/shared";
import { SupplierMonitorView } from "@/modules/ops/views/supplier-monitor-view";
import { SuppliersView } from "@/modules/ops/views/suppliers-view";

const TABS = [
  ["list", "供应商"],
  ["monitor", "接口监测"],
] as const;

// 供应商：原「供应商管理」「接口监测」合并
function SuppliersInner() {
  const [tab, setTab] = useTabParam(
    TABS.map(([k]) => k),
    "list",
  );
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="供应商" description="供应商和他们能提供的货 · 线路质量 · 接口监测" />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {TABS.map(([k, l]) => (
            <TabsTrigger key={k} value={k}>
              {l}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Embedded>{tab === "list" ? <SuppliersView /> : <SupplierMonitorView />}</Embedded>
    </div>
  );
}

export default function SuppliersPage() {
  return (
    <Suspense>
      <SuppliersInner />
    </Suspense>
  );
}
