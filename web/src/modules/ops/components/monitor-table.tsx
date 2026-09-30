"use client";

import { useState } from "react";

import Link from "next/link";

import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { del, patch, post } from "../api";
import { ago, ms, readErr } from "../format";
import type { Supplier, SupplierMonitor } from "../types";

import { Tag } from "./badges";
import { GradeBadge, LatencyBar, STATUS_LABEL, supplierCells } from "./latency-bar";
import { useConfirm } from "./shared";
import { KINDS, MonitorDialog } from "./supplier-dialogs";

const STATUS_TONE = { up: "ok", slow: "warn", down: "bad", limited: "info", unknown: "muted" } as const;

// 供应商接口监测表：延迟监控条（每次探测一格，保留最近 24 次）+ 评级 + 手动探测
export function MonitorTable({
  monitors,
  suppliers,
  showSupplier,
  onChanged,
}: {
  monitors: SupplierMonitor[];
  suppliers: Pick<Supplier, "id" | "name" | "base_url">[];
  showSupplier?: boolean;
  onChanged: () => void;
}) {
  const [confirm, confirmEl] = useConfirm();
  const [editing, setEditing] = useState<SupplierMonitor | null>(null);
  const [probing, setProbing] = useState<Set<number>>(new Set());

  const probe = async (m: SupplierMonitor) => {
    setProbing((s) => new Set(s).add(m.id));
    try {
      const r = await post<SupplierMonitor>(`/supplier-monitors/${m.id}/probe`);
      const tone = r.last_status === "up" ? toast.success : r.last_status === "down" ? toast.error : toast;
      tone(
        `${m.supplier_name ?? ""} ${m.name}：${STATUS_LABEL[r.last_status]}${r.last_latency_ms ? ` · ${ms(r.last_latency_ms)}` : ""}${r.last_error ? ` · ${r.last_error}` : ""}`,
      );
      onChanged();
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setProbing((s) => {
        const n = new Set(s);
        n.delete(m.id);
        return n;
      });
    }
  };
  const toggle = async (m: SupplierMonitor, on: boolean) => {
    try {
      await patch(`/supplier-monitors/${m.id}`, { enabled: on });
      onChanged();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const remove = async (m: SupplierMonitor) => {
    if (
      !(await confirm({
        title: `删除监测项「${m.name}」？`,
        description: "探测记录一并删除。",
        destructive: true,
        confirmText: "删除",
      }))
    )
      return;
    try {
      await del(`/supplier-monitors/${m.id}`);
      toast.success("已删除");
      onChanged();
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {showSupplier ? <TableHead>供应商</TableHead> : null}
              <TableHead>渠道</TableHead>
              <TableHead>近 24 次探测</TableHead>
              <TableHead>评级</TableHead>
              <TableHead>最近一次</TableHead>
              <TableHead>接口</TableHead>
              <TableHead>启用</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {monitors.length ? (
              monitors.map((m) => (
                <TableRow key={m.id}>
                  {showSupplier ? (
                    <TableCell>
                      <Link
                        prefetch={false}
                        href={`/dashboard/suppliers/${m.supplier_id}`}
                        className="font-medium hover:underline"
                      >
                        {m.supplier_name}
                      </Link>
                    </TableCell>
                  ) : null}
                  <TableCell>
                    {m.name}
                    <div className="text-muted-foreground text-xs">{KINDS.find(([k]) => k === m.kind)?.[1]}</div>
                  </TableCell>
                  <TableCell>
                    <LatencyBar cells={supplierCells(m.samples)} />
                  </TableCell>
                  <TableCell>
                    <GradeBadge score={m.score} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Tag tone={STATUS_TONE[m.last_status]}>{STATUS_LABEL[m.last_status]}</Tag>{" "}
                    <span className="tabular-nums">{m.last_latency_ms ? ms(m.last_latency_ms) : ""}</span>
                    <div className="text-muted-foreground text-xs">{ago(m.last_checked_at)}</div>
                    {m.last_error ? (
                      <div className="text-danger max-w-56 truncate text-xs" title={m.last_error}>
                        {m.last_error}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-64">
                    <div className="truncate font-mono text-xs" title={m.base_url}>
                      {m.base_url}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {m.model || "默认模型"} · 慢于 {ms(m.slow_ms)} 记偏慢 ·{" "}
                      {m.has_key ? `Key ${m.key_masked}` : "未填 Key"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Switch checked={m.enabled} onCheckedChange={(v) => toggle(m, v)} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="flex gap-2 text-sm">
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        disabled={probing.has(m.id)}
                        onClick={() => probe(m)}
                      >
                        {probing.has(m.id) ? "探测中…" : "探测"}
                      </button>
                      <button type="button" className="text-primary hover:underline" onClick={() => setEditing(m)}>
                        编辑
                      </button>
                      <button type="button" className="text-muted-foreground hover:underline" onClick={() => remove(m)}>
                        删除
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={showSupplier ? 8 : 7} className="text-muted-foreground py-8 text-center">
                  还没有监测项
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <MonitorDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        monitor={editing}
        suppliers={suppliers}
        onSaved={onChanged}
      />
      {confirmEl}
    </>
  );
}
