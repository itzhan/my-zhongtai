"use client";

import { useEffect, useState } from "react";

import Link from "next/link";

import { ExternalLink, MoreHorizontal, Plus, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { del } from "@/modules/ops/api";
import { Tag } from "@/modules/ops/components/badges";
import { LINE_RANGE, LineQualityBadge, lineQuality, supplierAccounts } from "@/modules/ops/components/line-quality";
import { PageHeader, Pager, useConfirm, usePaged } from "@/modules/ops/components/shared";
import {
  CATEGORIES,
  CategoryTags,
  CopyLine,
  STATUS,
  SupplierDialog,
  goodsTone,
} from "@/modules/ops/components/supplier-dialogs";
import { amt } from "@/modules/ops/components/supplier-wallets";
import { readErr } from "@/modules/ops/format";
import { useAccounts, useInvalidate, useMonitor, useSuppliers } from "@/modules/ops/hooks";
import type { Account, MonitorResp, Supplier } from "@/modules/ops/types";

const ALL = "all";

export function SuppliersView() {
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [cat, setCat] = useState(ALL);
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const { data } = useSuppliers(dq, cat === ALL ? "" : cat);
  const { rows, pager } = usePaged(data ?? [], `${dq}|${cat}`);
  // 线路质量：名下账号在监控大盘的延迟评级
  const accounts = useAccounts();
  const mon = useMonitor(LINE_RANGE);
  const invalidate = useInvalidate();
  const [confirm, confirmEl] = useConfirm();
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [open, setOpen] = useState(false);

  const remove = async (s: Supplier) => {
    if (
      !(await confirm({
        title: `删除供应商「${s.name}」？`,
        description: "会从列表里移除（保留记录），它的接口监测也会停用。",
        destructive: true,
        confirmText: "删除",
      }))
    )
      return;
    try {
      await del(`/suppliers/${s.id}`);
      toast.success("已删除");
      invalidate("suppliers", "supplier-monitors");
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="供应商管理"
        description="记录供应商和他们能提供的货，方便找到对应的人"
        actions={
          <>
            <div className="relative w-56">
              <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input
                placeholder="搜索名称 / 货物 / 联系方式"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={cat} onValueChange={setCat}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部分类</SelectItem>
                {CATEGORIES.map(([k, l]) => (
                  <SelectItem key={k} value={k}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              <Plus />
              新建供应商
            </Button>
          </>
        }
      />
      {!data ? (
        <Skeleton className="h-64" />
      ) : data.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((s) => (
            <Card key={s.id} className={cn("gap-3", s.status !== "active" && "opacity-70")}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Link prefetch={false} href={`/dashboard/suppliers/${s.id}`} className="truncate hover:underline">
                    {s.name}
                  </Link>
                  {s.status !== "active" ? <Tag tone={STATUS[s.status]?.[1]}>{STATUS[s.status]?.[0]}</Tag> : null}
                </CardTitle>
                <CardDescription className="space-y-1">
                  <CategoryTags list={s.category} />
                  {s.base_url ? (
                    <a
                      href={s.base_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary flex items-center gap-1 truncate text-xs hover:underline"
                    >
                      <ExternalLink className="size-3 shrink-0" />
                      {s.base_url}
                    </a>
                  ) : null}
                </CardDescription>
                <CardAction>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => {
                          setEditing(s);
                          setOpen(true);
                        }}
                      >
                        编辑
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onClick={() => remove(s)}>
                        删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <CopyLine label="TG" value={s.contact} />
                  <CopyLine label="微信" value={s.wechat} />
                  {!s.contact && !s.wechat ? (
                    <span className="text-muted-foreground text-xs">没有留联系方式</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1">
                  {s.goods.length ? (
                    s.goods.map((g) => (
                      <Tag key={g.id} tone={goodsTone(g.name)}>
                        {g.name}
                        {g.rate ? ` · ${g.rate}` : ""}
                      </Tag>
                    ))
                  ) : (
                    <span className="text-muted-foreground text-xs">还没记录可提供的货</span>
                  )}
                </div>
                <SupplierLineRow s={s} accounts={accounts.data} mon={mon.data} />
                {s.wallet ? (
                  <div className="flex items-center gap-2 border-t pt-2 text-xs">
                    <span className="text-muted-foreground">余额</span>
                    <span className="font-medium tabular-nums">{amt(s.wallet.actual)}</span>
                    <span className="text-muted-foreground">· {s.wallet.count} 个 Key</span>
                    {s.wallet.errors ? <span className="text-danger">· {s.wallet.errors} 个抓取失败</span> : null}
                  </div>
                ) : null}
                {s.monitor_count ? (
                  <div className="text-muted-foreground text-xs">接口监测 {s.monitor_count} 项</div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="text-muted-foreground py-10 text-center">
            {dq || cat !== ALL ? "没有符合条件的供应商" : "还没有供应商，点右上角「新建供应商」"}
          </CardContent>
        </Card>
      )}
      <Pager {...pager} />
      <SupplierDialog
        open={open}
        onOpenChange={setOpen}
        supplier={editing}
        onSaved={() => invalidate("suppliers", "supplier")}
      />
      {confirmEl}
    </div>
  );
}

function SupplierLineRow({
  s,
  accounts,
  mon,
}: {
  s: Supplier;
  accounts: Account[] | undefined;
  mon: MonitorResp | undefined;
}) {
  if (!accounts || !mon) return <Skeleton className="h-5 w-40" />;
  const { linked } = supplierAccounts(s, accounts);
  const q = lineQuality(
    linked.map((x) => x.account.id),
    mon,
  );
  return (
    <div className="flex items-center gap-2 border-t pt-2">
      <span className="text-muted-foreground shrink-0 text-xs">线路质量</span>
      <LineQualityBadge q={q} total={linked.length} />
    </div>
  );
}
