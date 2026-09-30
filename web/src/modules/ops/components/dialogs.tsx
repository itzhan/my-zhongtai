"use client";

import { useEffect, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { get, qs } from "../api";
import { RANGE_OPTS, time } from "../format";
import { useOps } from "../provider";
import type { Account, Paged } from "../types";

import { Tag } from "./badges";
import { Pager } from "./shared";

// ---------- 报错详情 ----------
type ErrorDetail = Record<string, unknown> & { id: number; created_at: string; request_id: string };
const pretty = (v: unknown) => {
  if (v == null || v === "") return "";
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  try {
    return JSON.stringify(JSON.parse(String(v)), null, 2);
  } catch {
    return String(v);
  }
};

export function ErrorDetailDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["ops", "error", id],
    queryFn: () => get<ErrorDetail>(`/errors/${id}`),
    enabled: !!id,
  });
  const d = q.data;
  const block = (k: string, v: unknown) =>
    pretty(v) ? (
      <div key={k} className="space-y-1">
        <div className="text-muted-foreground text-xs">{k}</div>
        <pre className="bg-muted max-h-64 overflow-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap">
          {pretty(v)}
        </pre>
      </div>
    ) : null;
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>报错详情 #{id}</DialogTitle>
        </DialogHeader>
        {!d ? (
          q.isError ? (
            <p className="text-destructive text-sm">{q.error.message}</p>
          ) : (
            <Skeleton className="h-40" />
          )
        ) : (
          <div className="space-y-3">
            <p className="text-muted-foreground text-xs break-all">
              {time(d.created_at)} · request_id <span className="font-mono">{d.request_id}</span> ·{" "}
              {String(d.inbound_endpoint || d.request_path || "")} → {String(d.upstream_endpoint || "-")} · 模型{" "}
              {String(d.requested_model || "")}
              {d.upstream_model ? ` → ${String(d.upstream_model)}` : ""}
            </p>
            {block("错误信息", d.error_message)}
            {block("返回给客户端的内容", d.error_body)}
            {block("上游错误", d.upstream_error_message)}
            {block("上游错误详情", d.upstream_error_detail)}
            {block("重试链路（upstream_errors）", d.upstream_errors)}
            {block("其他", {
              provider_error_code: d.provider_error_code,
              provider_error_type: d.provider_error_type,
              network_error_type: d.network_error_type,
              user_agent: d.user_agent,
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- 某账号的报错 ----------
type AccErr = {
  id: number;
  created_at: string;
  email: string | null;
  model: string | null;
  status_code: number | null;
  error_owner: string | null;
  error_message: string;
};

export function AccountErrorsDialog({
  account,
  onClose,
}: {
  account: Pick<Account, "id" | "name"> | null;
  onClose: () => void;
}) {
  const [range, setRange] = useState("24h");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<number | null>(null);
  useEffect(() => setPage(1), [account?.id, range]);
  const q = useQuery({
    queryKey: ["ops", "acc-errors", account?.id, range, page],
    queryFn: () => get<Paged<AccErr>>(`/accounts/${account!.id}/errors?${qs({ range, page })}`),
    enabled: !!account,
  });
  return (
    <>
      <Dialog open={!!account} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{account?.name} 的报错</DialogTitle>
          </DialogHeader>
          <RangeSelect value={range} onChange={setRange} />
          {!q.data ? (
            <Skeleton className="h-40" />
          ) : (
            <div className="space-y-3">
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>用户</TableHead>
                      <TableHead>模型</TableHead>
                      <TableHead>状态码</TableHead>
                      <TableHead>归属</TableHead>
                      <TableHead>错误信息</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {q.data.items.length ? (
                      q.data.items.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell className="whitespace-nowrap">{time(r.created_at)}</TableCell>
                          <TableCell>{r.email || "-"}</TableCell>
                          <TableCell>{r.model || "-"}</TableCell>
                          <TableCell>
                            <Tag tone="bad">{r.status_code ?? "-"}</Tag>
                          </TableCell>
                          <TableCell className="text-xs">{r.error_owner || "-"}</TableCell>
                          <TableCell className="max-w-96 text-xs break-all whitespace-normal">
                            {r.error_message}
                          </TableCell>
                          <TableCell>
                            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setDetail(r.id)}>
                              详情
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                          没有报错
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <Pager page={q.data.page} pageSize={q.data.page_size} total={q.data.total} onPage={setPage} />
            </div>
          )}
        </DialogContent>
      </Dialog>
      <ErrorDetailDialog id={detail} onClose={() => setDetail(null)} />
    </>
  );
}

export function RangeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-36" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RANGE_OPTS.map(([k, l]) => (
          <SelectItem key={k} value={k}>
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---------- 修改账号所属分组 ----------
export function GroupsDialog({
  accounts,
  onClose,
  onSave,
}: {
  accounts: Account[] | null;
  onClose: () => void;
  onSave: (groupIds: number[]) => Promise<boolean>;
}) {
  const { groups } = useOps();
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSel(new Set(accounts?.length === 1 ? accounts[0]!.group_ids : []));
  }, [accounts]);
  const single = accounts?.length === 1;
  return (
    <Dialog open={!!accounts} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>修改分组 · {single ? accounts[0]!.name : `${accounts?.length} 个账号`}</DialogTitle>
        </DialogHeader>
        {!single ? (
          <p className="text-muted-foreground text-sm">批量修改会把选中账号的分组整体替换为下面勾选的分组。</p>
        ) : null}
        <div className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto">
          {groups.map((g) => (
            <label key={g.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={sel.has(g.id)}
                onCheckedChange={(v) =>
                  setSel((s) => {
                    const n = new Set(s);
                    if (v) n.add(g.id);
                    else n.delete(g.id);
                    return n;
                  })
                }
              />
              {g.name} <span className="text-muted-foreground text-xs">{g.platform}</span>
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              if (await onSave([...sel])) onClose();
              setBusy(false);
            }}
          >
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const toastErr = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));
