"use client";

import { useState } from "react";

import { Plus, Radar } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { post } from "@/modules/ops/api";
import { Legend } from "@/modules/ops/components/latency-bar";
import { MonitorTable } from "@/modules/ops/components/monitor-table";
import { PageHeader, StatCards, useConfirm } from "@/modules/ops/components/shared";
import { MonitorDialog } from "@/modules/ops/components/supplier-dialogs";
import { readErr } from "@/modules/ops/format";
import { useEnv, useInvalidate, useSupplierMonitors, useSuppliers } from "@/modules/ops/hooks";

export default function SupplierMonitorPage() {
  const { data, refetch } = useSupplierMonitors();
  const suppliers = useSuppliers("", "");
  const env = useEnv();
  const invalidate = useInvalidate();
  const [confirm, confirmEl] = useConfirm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const list = data ?? [];
  const g = (x: string) => list.filter((m) => m.score.grade === x).length;
  const probeAll = async () => {
    const n = list.filter((m) => m.enabled).length;
    if (
      !(await confirm({
        title: `立即探测全部 ${n} 个启用的监测项？`,
        description: "会对每个供应商接口各发一次极小的真实请求（ping），可能需要十几秒。",
        confirmText: "开始探测",
      }))
    )
      return;
    setBusy(true);
    try {
      await post("/supplier-monitors/probe");
      toast.success("已全部探测");
      refetch();
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="接口监测"
        description={
          env.data?.readonly
            ? "只读模式：不会自动定时探测，可手动探测（探测只请求供应商接口，与 sub2api 无关）"
            : "每 60 秒对所有启用的监测项各探测一次，每项保留最近 48 条"
        }
        actions={
          <>
            <Button variant="outline" onClick={probeAll} disabled={busy || !list.length}>
              <Radar />
              {busy ? "探测中…" : "立即探测全部"}
            </Button>
            <Button onClick={() => setOpen(true)}>
              <Plus />
              新增监测项
            </Button>
          </>
        }
      />
      {data ? (
        <StatCards
          items={[
            { label: "监测项", value: list.length, sub: `启用 ${list.filter((m) => m.enabled).length}` },
            { label: "优秀", value: g("excellent"), className: "text-success" },
            { label: "不稳定", value: g("unstable"), className: "text-warning" },
            { label: "不可用", value: g("unavailable"), className: "text-danger" },
          ]}
        />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>供应商接口延迟</CardTitle>
          <CardDescription className="space-y-1">
            <div>每次探测一格；评级取最近 12 次（忽略限流），末尾连续 3 次异常或失败率 ≥ 50% 记为不可用。</div>
            <Legend />
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data ? (
            <MonitorTable
              monitors={list}
              suppliers={suppliers.data ?? []}
              showSupplier
              onChanged={() => invalidate("supplier-monitors", "supplier")}
            />
          ) : (
            <Skeleton className="h-64" />
          )}
        </CardContent>
      </Card>
      <MonitorDialog
        open={open}
        onOpenChange={setOpen}
        suppliers={suppliers.data ?? []}
        onSaved={() => invalidate("supplier-monitors", "supplier", "suppliers")}
      />
      {confirmEl}
    </div>
  );
}
