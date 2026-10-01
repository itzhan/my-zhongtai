"use client";

import { useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { Plus, Receipt, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { del } from "@/modules/ops/api";
import { Tag } from "@/modules/ops/components/badges";
import { CustomerDialog } from "@/modules/ops/components/customer-dialog";
import { PageHeader, Pager, useConfirm, usePaged } from "@/modules/ops/components/shared";
import { money, num, readErr } from "@/modules/ops/format";
import { useCustomers, useInvalidate } from "@/modules/ops/hooks";
import type { Customer } from "@/modules/ops/types";

export default function CustomersPage() {
  const router = useRouter();
  const { data } = useCustomers();
  const invalidate = useInvalidate();
  const [confirm, confirmEl] = useConfirm();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Customer | null>(null);
  const [open, setOpen] = useState(false);

  const kw = q.trim().toLowerCase();
  const rows = (data ?? []).filter(
    (c) =>
      !kw ||
      c.name.toLowerCase().includes(kw) ||
      c.users.some((u) => u.email.toLowerCase().includes(kw)) ||
      (c.contact || "").toLowerCase().includes(kw),
  );

  const { rows: pageRows, pager } = usePaged(rows, kw);
  const remove = async (c: Customer) => {
    if (
      !(await confirm({
        title: `删除客户「${c.name}」？`,
        description: "只删除中台里的客户记录，不会删除 sub2api 用户和 Key。",
        destructive: true,
        confirmText: "删除",
      }))
    )
      return;
    try {
      await del(`/customers/${c.id}`);
      toast.success("已删除");
      invalidate("customers");
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="客户"
        description={data ? `${data.length} 个客户` : " "}
        actions={
          <>
            <div className="relative w-56">
              <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input placeholder="搜索客户 / 邮箱" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
            </div>
            <Button variant="outline" asChild>
              <Link href="/dashboard/billing">
                <Receipt />
                出账单
              </Link>
            </Button>
            <Button
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
            >
              <Plus />
              新建客户
            </Button>
          </>
        }
      />
      <Card className="py-0">
        <CardContent className="p-0">
          {!data ? (
            <Skeleton className="m-4 h-40" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">客户</TableHead>
                  <TableHead>联系方式</TableHead>
                  <TableHead>关联 sub2api 用户</TableHead>
                  <TableHead className="text-right">今日请求</TableHead>
                  <TableHead className="text-right">今日消费</TableHead>
                  <TableHead className="text-right">24h 报错</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length ? (
                  pageRows.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="pl-4">
                        <Link
                          prefetch={false}
                          href={`/dashboard/customers/${c.id}`}
                          className="font-medium hover:underline"
                        >
                          {c.name}
                        </Link>
                        {c.notes ? <div className="text-muted-foreground text-xs">{c.notes.slice(0, 40)}</div> : null}
                      </TableCell>
                      <TableCell>{c.contact || <span className="text-muted-foreground">-</span>}</TableCell>
                      <TableCell>
                        <span className="inline-flex flex-wrap gap-1">
                          {c.users.length ? (
                            c.users.map((u) => (
                              <Tag key={u.id} tone="info">
                                {u.email}
                              </Tag>
                            ))
                          ) : (
                            <span className="text-muted-foreground">未关联</span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{num(c.today_requests)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(c.today_cost)}</TableCell>
                      <TableCell className="text-right">
                        {c.errors_24h ? <Tag tone="bad">{num(c.errors_24h)}</Tag> : 0}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div className="flex gap-3 text-sm">
                          <Link
                            prefetch={false}
                            href={`/dashboard/customers/${c.id}`}
                            className="text-primary hover:underline"
                          >
                            进入
                          </Link>
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => {
                              setEditing(c);
                              setOpen(true);
                            }}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="text-muted-foreground hover:underline"
                            onClick={() => remove(c)}
                          >
                            删除
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={7} className="text-muted-foreground py-10 text-center">
                      还没有客户，点右上角「新建客户」
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
          <Pager {...pager} className="border-t px-4 py-3" />
        </CardContent>
      </Card>
      <CustomerDialog
        open={open}
        onOpenChange={setOpen}
        customer={editing}
        onSaved={(c) => {
          invalidate("customers", "overview");
          if (!editing) router.push(`/dashboard/customers/${c.id}`);
        }}
      />
      {confirmEl}
    </div>
  );
}
