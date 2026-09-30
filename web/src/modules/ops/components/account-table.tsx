"use client";

import { useEffect, useMemo, useState } from "react";

import Link from "next/link";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import { post } from "../api";
import { ago, money, num, readErr } from "../format";
import { useMonitor, useNow } from "../hooks";
import { useOps } from "../provider";
import type { Account } from "../types";

import { AccountStatus, GroupTags, PlatformBadge, Tag } from "./badges";
import { AccountErrorsDialog, GroupsDialog } from "./dialogs";
import { GradeBadge, LatencyBar, accountCells } from "./latency-bar";
import { useConfirm } from "./shared";

export const MONITOR_RANGES: [string, string][] = [
  ["2h", "2 小时"],
  ["6h", "6 小时"],
  ["24h", "24 小时"],
];

type BulkBody = Record<string, unknown>;
type BulkResult = {
  verified?: { id: number; ok: boolean; mismatch: string[] }[];
  failed?: number;
  failed_count?: number;
};

// 批量改 sub2api 账号，改完读回核对（逻辑同旧版 accountTable.bulk）
export function useBulk() {
  const [confirm, confirmEl] = useConfirm();
  const bulk = async (ids: number[], body: BulkBody, okMsg: string): Promise<boolean> => {
    try {
      const r = await post<BulkResult>("/accounts/bulk", { account_ids: ids, ...body });
      const failed = r.failed ?? r.failed_count ?? 0;
      const bad = (r.verified || []).filter((v) => !v.ok);
      if (failed) toast.error(`部分失败：${JSON.stringify(r).slice(0, 200)}`);
      else if (bad.length)
        toast.error(`sub2api 返回成功，但读回不一致：${bad.map((v) => `#${v.id} ${v.mismatch.join(" ")}`).join("；")}`);
      else toast.success(`${okMsg}（已同步到 sub2api，读回确认）`);
      return true;
    } catch (e) {
      const msg = readErr(e);
      if (
        /mixed|混合/i.test(msg) &&
        body.group_ids &&
        (await confirm({ title: "混合渠道风险", description: `sub2api 提示：${msg}。仍要继续？` }))
      )
        return bulk(ids, { ...body, confirm_mixed_channel_risk: true }, okMsg);
      toast.error(msg);
      return false;
    }
  };
  return { bulk, confirm, confirmEl };
}

export function AccountTable({
  accounts,
  customer,
  reload,
}: {
  accounts: Account[];
  customer?: boolean;
  reload: () => void;
}) {
  const { groupName } = useOps();
  const { bulk, confirm, confirmEl } = useBulk();
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [range, setRange] = useState("2h");
  const [batchPrio, setBatchPrio] = useState("");
  const [groupsFor, setGroupsFor] = useState<Account[] | null>(null);
  const [errorsFor, setErrorsFor] = useState<Account | null>(null);
  const rows = useMemo(() => [...accounts].sort((a, b) => a.priority - b.priority || a.id - b.id), [accounts]);
  const mon = useMonitor(
    range,
    rows.map((a) => a.id),
  );
  useEffect(() => setSel((s) => new Set([...s].filter((id) => rows.some((a) => a.id === id)))), [rows]);

  const toggle = (id: number, on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const byId = (id: number) => rows.find((a) => a.id === id)!;

  const setStatus = async (a: Account, on: boolean) => {
    if (
      !on &&
      !(await confirm({
        title: `禁用账号「${a.name}」？`,
        description: "禁用后所有分组都不会再调度到它。",
        destructive: true,
        confirmText: "禁用",
      }))
    )
      return;
    if (await bulk([a.id], { status: on ? "active" : "inactive" }, on ? "已启用" : "已禁用")) reload();
  };
  const simple = async (path: string, msg: string) => {
    try {
      await post(path);
      toast.success(msg);
      reload();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const batch = async (act: string) => {
    const ids = [...sel];
    let body: BulkBody = {};
    let msg = "";
    if (act === "prio") {
      if (batchPrio === "") return toast.error("先填优先级数字");
      body = { priority: +batchPrio };
      msg = `${ids.length} 个账号优先级改为 ${batchPrio}`;
    }
    if (act === "on") [body, msg] = [{ status: "active" }, `已启用 ${ids.length} 个账号`];
    if (act === "off") {
      if (!(await confirm({ title: `禁用选中的 ${ids.length} 个账号？`, destructive: true, confirmText: "禁用" })))
        return;
      [body, msg] = [{ status: "inactive" }, `已禁用 ${ids.length} 个账号`];
    }
    if (act === "son") [body, msg] = [{ schedulable: true }, "已开启调度"];
    if (act === "soff") [body, msg] = [{ schedulable: false }, "已停止调度"];
    if (await bulk(ids, body, msg)) reload();
  };

  const now = useNow();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {sel.size ? (
          <div className="bg-muted/60 flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-sm">
            <b>已选 {sel.size} 个账号</b>
            <Input
              value={batchPrio}
              onChange={(e) => setBatchPrio(e.target.value)}
              type="number"
              placeholder="优先级"
              className="h-8 w-20"
            />
            <Button size="sm" variant="outline" onClick={() => batch("prio")}>
              设置优先级
            </Button>
            <Button size="sm" variant="outline" onClick={() => batch("on")}>
              启用
            </Button>
            <Button size="sm" variant="outline" onClick={() => batch("off")}>
              禁用
            </Button>
            <Button size="sm" variant="outline" onClick={() => batch("son")}>
              开启调度
            </Button>
            <Button size="sm" variant="outline" onClick={() => batch("soff")}>
              停止调度
            </Button>
            <Button size="sm" variant="outline" onClick={() => setGroupsFor([...sel].map(byId))}>
              修改分组
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>
              取消选择
            </Button>
          </div>
        ) : null}
        <div className="text-muted-foreground ml-auto flex items-center gap-2 text-xs">
          延迟条
          <ToggleGroup type="single" size="sm" variant="outline" value={range} onValueChange={(v) => v && setRange(v)}>
            {MONITOR_RANGES.map(([k, l]) => (
              <ToggleGroupItem key={k} value={k} className="px-2 text-xs">
                {l}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  checked={rows.length > 0 && sel.size === rows.length}
                  onCheckedChange={(v) => setSel(v ? new Set(rows.map((a) => a.id)) : new Set())}
                />
              </TableHead>
              <TableHead>账号</TableHead>
              <TableHead>延迟（首字）</TableHead>
              <TableHead>优先级</TableHead>
              <TableHead>启用</TableHead>
              <TableHead>调度</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>分组</TableHead>
              <TableHead className="text-right">并发</TableHead>
              {customer ? (
                <>
                  <TableHead className="text-right">该客户 7 天请求</TableHead>
                  <TableHead className="text-right">该客户 7 天消费</TableHead>
                  <TableHead className="text-right">该客户 7 天报错</TableHead>
                </>
              ) : (
                <>
                  <TableHead className="text-right">今日请求</TableHead>
                  <TableHead className="text-right">今日费用</TableHead>
                  <TableHead className="text-right">24h 报错</TableHead>
                </>
              )}
              <TableHead>最近使用</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((a) => {
                const m = mon.data?.accounts[a.id];
                const limited = !!a.rate_limit_reset_at && new Date(a.rate_limit_reset_at).getTime() > now;
                return (
                  <TableRow key={a.id} data-state={sel.has(a.id) ? "selected" : undefined}>
                    <TableCell>
                      <Checkbox checked={sel.has(a.id)} onCheckedChange={(v) => toggle(a.id, !!v)} />
                    </TableCell>
                    <TableCell className="min-w-44">
                      <Link
                        prefetch={false}
                        href={`/dashboard/accounts/${a.id}`}
                        className="font-medium hover:underline"
                      >
                        {a.name}
                      </Link>{" "}
                      <span className="text-muted-foreground text-xs">#{a.id}</span>
                      <div className="mt-0.5 flex items-center gap-1">
                        <PlatformBadge platform={a.platform} />
                        <span className="text-muted-foreground text-xs">{a.type}</span>
                      </div>
                      {a.notes ? <div className="text-muted-foreground text-xs">{a.notes}</div> : null}
                    </TableCell>
                    <TableCell>
                      {m && mon.data ? (
                        <div className="flex items-center gap-2">
                          <LatencyBar cells={accountCells(m.samples, mon.data.bucket_min)} />
                          <GradeBadge score={m.score} />
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">加载中…</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <PrioInput
                        a={a}
                        onSave={async (v) =>
                          (await bulk([a.id], { priority: v }, `「${a.name}」优先级改为 ${v}`)) && reload()
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Switch checked={a.status !== "inactive"} onCheckedChange={(v) => setStatus(a, v)} />
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={a.schedulable}
                        onCheckedChange={async (v) =>
                          (await bulk([a.id], { schedulable: v }, v ? "已开启调度" : "已停止调度")) && reload()
                        }
                      />
                    </TableCell>
                    <TableCell className="min-w-28">
                      <AccountStatus a={a} />
                      {a.error_message ? (
                        <div className="text-danger mt-1 max-w-56 truncate text-xs" title={a.error_message}>
                          {a.error_message}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-56">
                      <GroupTags
                        ids={a.group_ids}
                        name={groupName}
                        highlight={customer ? (g) => !!a.in_customer_groups?.includes(g) : undefined}
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {a.current_concurrency ?? 0}/{a.concurrency}
                    </TableCell>
                    {customer ? (
                      <>
                        <TableCell className="text-right tabular-nums">{num(a.cust_requests_7d)}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(a.cust_cost_7d)}</TableCell>
                        <TableCell className="text-right">
                          {a.cust_errors_7d ? <Tag tone="bad">{num(a.cust_errors_7d)}</Tag> : 0}
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell className="text-right tabular-nums">
                          {a.today ? num(a.today.requests) : "-"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {a.today ? money(a.today.cost ?? a.today.actual_cost) : "-"}
                        </TableCell>
                        <TableCell className="text-right">
                          {a.errors_24h ? (
                            <button type="button" onClick={() => setErrorsFor(a)}>
                              <Tag tone="bad">{num(a.errors_24h)}</Tag>
                            </button>
                          ) : (
                            0
                          )}
                        </TableCell>
                      </>
                    )}
                    <TableCell className="text-muted-foreground whitespace-nowrap">{ago(a.last_used_at)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <div className="flex gap-2 text-sm">
                        <button
                          type="button"
                          className="text-primary hover:underline"
                          onClick={() => setGroupsFor([a])}
                        >
                          分组
                        </button>
                        <button type="button" className="text-primary hover:underline" onClick={() => setErrorsFor(a)}>
                          报错
                        </button>
                        {a.status === "error" ? (
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => simple(`/accounts/${a.id}/clear-error`, "已清除错误状态")}
                          >
                            清除错误
                          </button>
                        ) : null}
                        {limited ? (
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => simple(`/accounts/${a.id}/clear-rate-limit`, "已解除限流")}
                          >
                            解除限流
                          </button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={15} className="text-muted-foreground py-10 text-center">
                  没有账号
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <GroupsDialog
        accounts={groupsFor}
        onClose={() => setGroupsFor(null)}
        onSave={async (ids) => {
          const ok = await bulk(
            groupsFor!.map((a) => a.id),
            { group_ids: ids },
            "分组已更新",
          );
          if (ok) reload();
          return ok;
        }}
      />
      <AccountErrorsDialog account={errorsFor} onClose={() => setErrorsFor(null)} />
      {confirmEl}
    </div>
  );
}

// 行内优先级：改完回车 / 失焦提交，失败恢复原值
export function PrioInput({ a, onSave }: { a: Pick<Account, "priority">; onSave: (v: number) => Promise<unknown> }) {
  const [v, setV] = useState(String(a.priority));
  useEffect(() => setV(String(a.priority)), [a.priority]);
  const commit = async () => {
    if (v === "" || isNaN(+v) || +v === a.priority) return setV(String(a.priority));
    const ok = await onSave(+v);
    if (!ok) setV(String(a.priority));
  };
  return (
    <Input
      type="number"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={cn("h-8 w-16 tabular-nums")}
    />
  );
}
