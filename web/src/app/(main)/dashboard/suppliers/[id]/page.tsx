"use client";

import { use, useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { ArrowLeft, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { del, patch, post } from "@/modules/ops/api";
import { Tag } from "@/modules/ops/components/badges";
import {
  LINE_RANGE,
  LineQualityBadge,
  SupplierLines,
  lineQuality,
  supplierAccounts,
} from "@/modules/ops/components/line-quality";
import { MonitorTable } from "@/modules/ops/components/monitor-table";
import { PageHeader, useConfirm } from "@/modules/ops/components/shared";
import {
  CategoryTags,
  CopyLine,
  MonitorDialog,
  STATUS,
  SupplierDialog,
  goodsTone,
} from "@/modules/ops/components/supplier-dialogs";
import { readErr, time } from "@/modules/ops/format";
import { useAccounts, useInvalidate, useMonitor, useSupplier } from "@/modules/ops/hooks";
import { useTabTitle, useTabsStore } from "@/stores/tabs/tab-store-provider";

// 一行货物：名称 + 倍率，可改可删
function GoodRow({
  sid,
  g,
  onChanged,
}: {
  sid: number;
  g: { id: number; name: string; rate: string };
  onChanged: () => void;
}) {
  const [name, setName] = useState(g.name);
  const [rate, setRate] = useState(g.rate);
  const dirty = name !== g.name || rate !== g.rate;
  const save = async () => {
    try {
      await patch(`/suppliers/${sid}/goods/${g.id}`, { name, rate });
      toast.success("已保存");
      onChanged();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Tag tone={goodsTone(name)} className="shrink-0">
        ●
      </Tag>
      <Input value={name} onChange={(e) => setName(e.target.value)} />
      <Input className="w-32" placeholder="倍率" value={rate} onChange={(e) => setRate(e.target.value)} />
      {dirty ? (
        <Button size="sm" onClick={save}>
          保存
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        onClick={async () => {
          try {
            await del(`/suppliers/${sid}/goods/${g.id}`);
            onChanged();
          } catch (e) {
            toast.error(readErr(e));
          }
        }}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

export default function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number(use(params).id);
  const router = useRouter();
  const { data: s, error, refetch } = useSupplier(id);
  const accounts = useAccounts();
  const mon = useMonitor(LINE_RANGE);
  const invalidate = useInvalidate();
  const [confirm, confirmEl] = useConfirm();
  const [editOpen, setEditOpen] = useState(false);
  const [monOpen, setMonOpen] = useState(false);
  const [ng, setNg] = useState({ name: "", rate: "" });
  const removeTab = useTabsStore((st) => st.removeTab);
  useTabTitle(s?.name);

  if (error) return <p className="text-destructive">{error.message}</p>;
  if (!s) return <Skeleton className="h-96" />;
  const linkedIds = accounts.data ? supplierAccounts(s, accounts.data).linked.map((x) => x.account.id) : [];
  const changed = () => {
    refetch();
    invalidate("suppliers", "supplier-monitors");
  };
  const addGood = async () => {
    if (!ng.name.trim()) return toast.error("先填货物名称");
    try {
      await post(`/suppliers/${id}/goods`, ng);
      setNg({ name: "", rate: "" });
      changed();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const remove = async () => {
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
      await del(`/suppliers/${id}`);
      toast.success("已删除");
      invalidate("suppliers", "supplier-monitors");
      router.push("/dashboard/suppliers");
      removeTab(`/dashboard/suppliers/${id}`); // 已删除的详情页不再留在标签栏
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={
          <Link
            prefetch={false}
            href="/dashboard/suppliers"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="size-4" />
            供应商
          </Link>
        }
        title={
          <>
            {s.name} <Tag tone={STATUS[s.status]?.[1]}>{STATUS[s.status]?.[0]}</Tag> <CategoryTags list={s.category} />
          </>
        }
        description={`创建于 ${time(s.created_at)} · 最近更新 ${time(s.updated_at)}`}
        actions={
          <>
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil />
              编辑
            </Button>
            <Button variant="outline" className="text-destructive" onClick={remove}>
              <Trash2 />
              删除
            </Button>
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[22rem_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>联系方式</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <CopyLine label="TG" value={s.contact} />
            <CopyLine label="微信" value={s.wechat} />
            {!s.contact && !s.wechat ? <p className="text-muted-foreground text-sm">没有留联系方式</p> : null}
            {s.base_url ? (
              <a
                href={s.base_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary flex items-center gap-1 text-sm break-all hover:underline"
              >
                <ExternalLink className="size-3.5 shrink-0" />
                {s.base_url}
              </a>
            ) : null}
            {s.notes ? (
              <p className="text-muted-foreground border-t pt-2 text-sm whitespace-pre-wrap">{s.notes}</p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>可以提供的货</CardTitle>
            <CardDescription>名称 + 倍率（倍率可填区间，如 0.8-1.2）</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {s.goods.map((g) => (
              <GoodRow key={`${g.id}-${g.name}-${g.rate}`} sid={id} g={g} onChanged={changed} />
            ))}
            <div className="flex items-center gap-2 border-t pt-3">
              <Input
                placeholder="新增货物，如 Claude Max 号"
                value={ng.name}
                onChange={(e) => setNg({ ...ng, name: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && addGood()}
              />
              <Input
                className="w-32"
                placeholder="倍率"
                value={ng.rate}
                onChange={(e) => setNg({ ...ng, rate: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && addGood()}
              />
              <Button onClick={addGood}>
                <Plus />
                添加
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>线路质量</CardTitle>
          <CardDescription>名下 sub2api 账号在监控大盘里近 24 小时的延迟评级（真实流量，每小时一格）</CardDescription>
          <CardAction>
            {accounts.data && mon.data ? (
              <LineQualityBadge q={lineQuality(linkedIds, mon.data)} total={linkedIds.length} />
            ) : null}
          </CardAction>
        </CardHeader>
        <CardContent>
          {accounts.data ? (
            <SupplierLines supplier={s} accounts={accounts.data} mon={mon.data} onChanged={changed} />
          ) : (
            <Skeleton className="h-40" />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>接口监测</CardTitle>
          <CardDescription>对供应商的 API 地址定时发一次「ping」，记录状态与延迟</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => setMonOpen(true)}>
              <Plus />
              新增监测项
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <MonitorTable monitors={s.monitors} suppliers={[s]} onChanged={changed} />
        </CardContent>
      </Card>
      <SupplierDialog open={editOpen} onOpenChange={setEditOpen} supplier={s} onSaved={changed} />
      <MonitorDialog open={monOpen} onOpenChange={setMonOpen} suppliers={[s]} presetSupplier={id} onSaved={changed} />
      {confirmEl}
    </div>
  );
}
