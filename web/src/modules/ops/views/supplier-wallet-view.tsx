"use client";

import { useState } from "react";

import { Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { post } from "@/modules/ops/api";
import { StatCards } from "@/modules/ops/components/shared";
import { WalletDialog, WalletTable, amt } from "@/modules/ops/components/supplier-wallets";
import { readErr } from "@/modules/ops/format";
import { useInvalidate, useSupplierWallets, useSuppliers } from "@/modules/ops/hooks";

// 供应商 → 余额：所有供应商站点 Key 的钱包额度、倍率、实际余额
export function SupplierWalletView() {
  const { data } = useSupplierWallets();
  const { data: suppliers } = useSuppliers("", "");
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const changed = () => invalidate("supplier-wallets", "suppliers", "supplier");

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const r = await post<{ last_error: string }[]>("/supplier-wallets/refresh", {});
      const bad = r.filter((w) => w.last_error).length;
      if (bad) toast.error(`已刷新 ${r.length} 项，其中 ${bad} 项抓取失败`);
      else toast.success(`已刷新 ${r.length} 项`);
      changed();
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setRefreshing(false);
    }
  };

  const on = (data ?? []).filter((w) => w.enabled);
  return (
    <div className="flex flex-col gap-4">
      <StatCards
        cols={3}
        items={[
          {
            label: "实际余额合计",
            value: amt(on.reduce((a, w) => a + (w.last_actual ?? 0), 0)),
            sub: "自定义倍率的按 钱包 × 倍率 计",
          },
          { label: "监控中的 Key", value: on.length, sub: `${new Set(on.map((w) => w.supplier_id)).size} 家供应商` },
          {
            label: "抓取失败",
            value: on.filter((w) => w.last_error).length,
            className: on.some((w) => w.last_error) ? "text-danger" : "",
            sub: "本地只读模式不自动抓取，可手动刷新",
          },
        ]}
      />
      <Card>
        <CardHeader>
          <CardTitle>供应商余额</CardTitle>
          <CardDescription>
            用我们在供应商站点（new-api / sub2api）的 API Key 抓钱包额度和倍率，每 30 分钟自动刷新
          </CardDescription>
          <CardAction className="flex gap-2">
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={refreshing || !data?.length}>
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "抓取中…" : "全部刷新"}
            </Button>
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus />
              添加
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {data ? (
            <WalletTable wallets={data} suppliers={suppliers ?? []} showSupplier onChanged={changed} />
          ) : (
            <Skeleton className="h-40" />
          )}
        </CardContent>
      </Card>
      <WalletDialog open={open} onOpenChange={setOpen} suppliers={suppliers ?? []} onSaved={changed} />
    </div>
  );
}
