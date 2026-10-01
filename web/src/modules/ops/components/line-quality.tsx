"use client";

import { useState } from "react";

import Link from "next/link";

import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { put } from "../api";
import { ms, readErr } from "../format";
import type { Account, Grade, MonitorResp, Supplier } from "../types";

import { AccountStatus, Tag } from "./badges";
import { GRADE, GradeBadge, LatencyBar, accountCells } from "./latency-bar";
import { Pager, usePaged } from "./shared";

// 线路质量：取该供应商名下 sub2api 账号在监控大盘里的延迟评级（近 24 小时，每小时一格）
export const LINE_RANGE = "24h";

// 账号名以供应商名开头、后面紧跟分隔符（或结束）即视为该供应商的账号，如「巴总--codex」「pig-codex」
const SEP = /^[\s\-_.·—–|/()（）[\]【】]/;
export function nameMatches(supplierName: string, accountName: string) {
  const s = supplierName.trim().toLowerCase();
  const a = accountName.trim().toLowerCase();
  if (!s || !a.startsWith(s)) return false;
  const rest = a.slice(s.length);
  return rest === "" || SEP.test(rest);
}

export type LinkedAccount = { account: Account; source: "auto" | "manual" };

// 自动匹配 + 手动关联 − 手动排除
export function supplierAccounts(s: Pick<Supplier, "name" | "links">, accounts: Account[]) {
  const mode = new Map((s.links ?? []).map((l) => [l.account_id, l.mode]));
  const linked: LinkedAccount[] = [];
  const excluded: Account[] = [];
  for (const a of accounts) {
    const m = mode.get(a.id);
    if (m === "include") linked.push({ account: a, source: "manual" });
    else if (nameMatches(s.name, a.name)) {
      if (m === "exclude") excluded.push(a);
      else linked.push({ account: a, source: "auto" });
    }
  }
  return { linked, excluded };
}

export type LineQuality = {
  grade: Grade["grade"];
  excellent: number;
  unstable: number;
  unavailable: number;
  unknown: number;
};

// 总评级取账号数最多的那一档（并列取更差的）；都没有数据 = 无数据
export function lineQuality(ids: number[], mon: MonitorResp | undefined): LineQuality {
  const c = { excellent: 0, unstable: 0, unavailable: 0, unknown: 0 };
  for (const id of ids) c[mon?.accounts[id]?.score.grade ?? "unknown"]++;
  let grade: Grade["grade"] = "unknown";
  let best = 0;
  // 从差到好遍历，严格大于才替换：并列时保留更差的一档
  for (const g of ["unavailable", "unstable", "excellent"] as const) if (c[g] > best) [grade, best] = [g, c[g]];
  return { grade, ...c };
}

export function LineQualityBadge({ q, total }: { q: LineQuality; total: number }) {
  if (!total) return <span className="text-muted-foreground text-xs">未关联账号</span>;
  const g = GRADE[q.grade];
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs">
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className={cn("cursor-default", g.className)}>
            {g.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>按名下账号近 24 小时的延迟评级，取账号数最多的一档</TooltipContent>
      </Tooltip>
      <span className="text-muted-foreground">
        {q.grade === "unknown"
          ? `${total} 个账号近 24 小时没有流量`
          : [
              q.excellent ? `优秀 ${q.excellent}` : "",
              q.unstable ? `不稳定 ${q.unstable}` : "",
              q.unavailable ? `不可用 ${q.unavailable}` : "",
              q.unknown ? `无数据 ${q.unknown}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
      </span>
    </span>
  );
}

// 供应商详情：名下账号的延迟条 + 关联管理
export function SupplierLines({
  supplier,
  accounts,
  mon,
  onChanged,
}: {
  supplier: Supplier;
  accounts: Account[];
  mon: MonitorResp | undefined;
  onChanged: () => void;
}) {
  const { linked, excluded } = supplierAccounts(supplier, accounts);
  const { rows, pager } = usePaged(linked, String(linked.length));
  const [pick, setPick] = useState("");
  const linkedIds = new Set(linked.map((x) => x.account.id));
  const candidates = accounts.filter((a) => !linkedIds.has(a.id));

  const setLink = async (accountId: number, mode: "include" | "exclude" | null) => {
    try {
      await put(`/suppliers/${supplier.id}/links`, { account_id: accountId, mode });
      onChanged();
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={pick} onValueChange={setPick}>
          <SelectTrigger className="w-72">
            <SelectValue placeholder="手动关联一个账号" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.name} #{a.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          disabled={!pick}
          onClick={async () => {
            await setLink(Number(pick), "include");
            setPick("");
          }}
        >
          关联
        </Button>
        <span className="text-muted-foreground text-xs">账号名以「{supplier.name}」开头的会自动算进来</span>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>账号</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>近 24 小时延迟</TableHead>
              <TableHead>评级</TableHead>
              <TableHead className="text-right">最近首字 P50</TableHead>
              <TableHead>状态</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map(({ account: a, source }) => {
                const m = mon?.accounts[a.id];
                const last = m ? [...m.samples].reverse().find((x) => x.p50 != null) : undefined;
                return (
                  <TableRow key={a.id}>
                    <TableCell className="min-w-40">
                      <Link
                        prefetch={false}
                        href={`/dashboard/accounts/${a.id}`}
                        className="font-medium hover:underline"
                      >
                        {a.name}
                      </Link>{" "}
                      <span className="text-muted-foreground text-xs">#{a.id}</span>
                    </TableCell>
                    <TableCell>
                      <Tag tone={source === "manual" ? "info" : "muted"}>
                        {source === "manual" ? "手动关联" : "名称匹配"}
                      </Tag>
                    </TableCell>
                    <TableCell>
                      {m && mon ? <LatencyBar cells={accountCells(m.samples, mon.bucket_min)} /> : null}
                    </TableCell>
                    <TableCell>{m ? <GradeBadge score={m.score} /> : null}</TableCell>
                    <TableCell className="text-right tabular-nums">{ms(last?.p50 ?? null)}</TableCell>
                    <TableCell>
                      <AccountStatus a={a} />
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="text-muted-foreground text-sm hover:underline"
                        onClick={() => setLink(a.id, source === "manual" ? null : "exclude")}
                      >
                        移除
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                  没有匹配到账号，可以在上方手动关联
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <Pager {...pager} />
      {excluded.length ? (
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          已移除的名称匹配账号：
          {excluded.map((a) => (
            <button
              key={a.id}
              type="button"
              className="hover:text-foreground underline-offset-2 hover:underline"
              onClick={() => setLink(a.id, null)}
              title="点击恢复"
            >
              {a.name} ↺
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
