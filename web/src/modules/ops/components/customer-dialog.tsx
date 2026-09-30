"use client";

import { useEffect, useState } from "react";

import { X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { get, post, put } from "../api";
import { money, readErr } from "../format";
import { useOps } from "../provider";
import type { Customer, S2User } from "../types";

import { FormError, ResponsiveDialog } from "./shared";

type Linkable = Pick<Customer, "id" | "name" | "contact" | "notes"> & { users: { id: number; email: string }[] };

// 新建 / 编辑客户：关联 sub2api 用户（客户的用量、Key、报错都按这些用户归集），也可以直接在 sub2api 新建一个用户
export function CustomerDialog({
  open,
  onOpenChange,
  customer,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  customer?: Linkable | null;
  onSaved: (c: Customer) => void;
}) {
  const { groups } = useOps();
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [notes, setNotes] = useState("");
  const [linked, setLinked] = useState<Map<number, string>>(new Map());
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<S2User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 新建 sub2api 用户
  const [nu, setNu] = useState({
    email: "",
    password: "",
    username: "",
    balance: "0",
    concurrency: "10",
    rpm_limit: "0",
  });
  const [nuGroups, setNuGroups] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!open) return;
    setName(customer?.name ?? "");
    setContact(customer?.contact ?? "");
    setNotes(customer?.notes ?? "");
    setLinked(new Map((customer?.users ?? []).map((u) => [u.id, u.email])));
    setSearch("");
    setResults(null);
    setError(null);
    setNu({
      email: "",
      password: Math.random().toString(36).slice(2, 12),
      username: "",
      balance: "0",
      concurrency: "10",
      rpm_limit: "0",
    });
    setNuGroups(new Set());
  }, [open, customer]);

  // 300ms 防抖搜索 sub2api 用户
  useEffect(() => {
    const v = search.trim();
    if (!v) return setResults(null);
    const t = setTimeout(() => {
      get<S2User[]>(`/s2/users?search=${encodeURIComponent(v)}`)
        .then(setResults)
        .catch((e) => toast.error(readErr(e)));
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const link = (id: number, email: string) => setLinked((m) => new Map(m).set(id, email));
  const unlink = (id: number) =>
    setLinked((m) => {
      const n = new Map(m);
      n.delete(id);
      return n;
    });

  const createUser = async () => {
    try {
      const u = await post<{ id: number; email: string }>("/s2/users", {
        ...nu,
        email: nu.email.trim(),
        allowed_groups: [...nuGroups],
        notes: name ? `客户：${name}` : "",
      });
      link(u.id, u.email);
      toast.success(`已创建用户 ${u.email}（密码：${nu.password}）`);
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name, contact, notes, user_ids: [...linked.keys()] };
      const r = customer
        ? await put<Customer>(`/customers/${customer.id}`, body)
        : await post<Customer>("/customers", body);
      toast.success("已保存");
      onOpenChange(false);
      onSaved(r);
    } catch (e) {
      setError(readErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={customer ? "编辑客户" : "新建客户"}
      className="sm:max-w-2xl"
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="c-name">客户名称 *</Label>
            <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="c-contact">联系方式</Label>
            <Input
              id="c-contact"
              placeholder="微信 / 电话 / 群"
              value={contact}
              onChange={(e) => setContact(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="c-notes">备注</Label>
          <Textarea id="c-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>关联的 sub2api 用户（客户的用量、Key、报错都按这些用户归集）</Label>
          <div className="flex flex-wrap gap-1.5">
            {[...linked].length ? (
              [...linked].map(([id, email]) => (
                <span key={id} className="bg-muted inline-flex items-center gap-1 rounded-md py-0.5 pr-1 pl-2 text-sm">
                  {email} <span className="text-muted-foreground text-xs">#{id}</span>
                  <button type="button" onClick={() => unlink(id)} aria-label="移除">
                    <X className="size-3.5" />
                  </button>
                </span>
              ))
            ) : (
              <span className="text-muted-foreground text-sm">暂未关联</span>
            )}
          </div>
          <Input placeholder="输入邮箱搜索已有用户…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {results ? (
            <div className="max-h-48 divide-y overflow-y-auto rounded-md border">
              {results.length ? (
                results.map((u) => (
                  <div key={u.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span>
                      {u.email}{" "}
                      <span className="text-muted-foreground text-xs">
                        #{u.id} · 余额 {money(u.balance)} · {u.status === "active" ? "正常" : "已禁用"}
                      </span>
                    </span>
                    {linked.has(u.id) ? (
                      <span className="text-muted-foreground text-xs">已关联</span>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => link(u.id, u.email)}>
                        关联
                      </Button>
                    )}
                  </div>
                ))
              ) : (
                <div className="text-muted-foreground px-3 py-2 text-sm">没有匹配的用户</div>
              )}
            </div>
          ) : null}
        </div>
        <Collapsible className="rounded-md border">
          <CollapsibleTrigger className="w-full px-3 py-2 text-left text-sm font-medium">
            在 sub2api 新建一个用户并关联 ▾
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 border-t p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["email", "邮箱 *"],
                  ["password", "密码 *（至少 6 位）"],
                  ["username", "用户名"],
                  ["balance", "初始余额（$）"],
                  ["concurrency", "并发上限"],
                  ["rpm_limit", "RPM 上限（0 = 不限）"],
                ] as const
              ).map(([k, l]) => (
                <div key={k} className="space-y-1">
                  <Label className="text-xs">{l}</Label>
                  <Input value={nu[k]} onChange={(e) => setNu({ ...nu, [k]: e.target.value })} />
                </div>
              ))}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">可用的专属分组</Label>
              <div className="grid max-h-32 grid-cols-2 gap-1 overflow-y-auto">
                {groups.map((g) => (
                  <label key={g.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={nuGroups.has(g.id)}
                      onCheckedChange={(v) =>
                        setNuGroups((s) => {
                          const n = new Set(s);
                          if (v) n.add(g.id);
                          else n.delete(g.id);
                          return n;
                        })
                      }
                    />
                    {g.name}
                  </label>
                ))}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={createUser}>
              创建并关联
            </Button>
          </CollapsibleContent>
        </Collapsible>
        <FormError>{error}</FormError>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={busy}>
            保存
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}
