"use client";

import { useState } from "react";

import { Pencil, Plus, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { del, patch, post, put } from "../api";
import { ms, num, readErr } from "../format";
import { useInvalidate } from "../hooks";
import type { TrafficSite } from "../traffic";

import { Tag } from "./badges";
import { Pager, ResponsiveDialog, useConfirm, usePaged } from "./shared";

const EMPTY = { name: "", base_url: "", api_key: "" };

// 设置：要监控的 sub2api 服务器（URL + Admin Key）
export function TrafficSettings({ sites }: { sites: TrafficSite[] }) {
  const invalidate = useInvalidate();
  const [confirm, confirmEl] = useConfirm();
  const [editing, setEditing] = useState<TrafficSite | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<number | null>(null);
  const { rows, pager } = usePaged(sites, String(sites.length));
  const reload = () => invalidate("traffic");

  const openForm = (s: TrafficSite | null) => {
    setEditing(s);
    setForm(s ? { name: s.name, base_url: s.base_url, api_key: "" } : EMPTY);
    setOpen(true);
  };
  const submit = async () => {
    setBusy(true);
    try {
      if (editing) await patch(`/traffic/sites/${editing.id}`, form);
      else await post("/traffic/sites", form);
      toast.success(editing ? "已保存" : "已添加");
      setOpen(false);
      reload();
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setBusy(false);
    }
  };
  const check = async (s: TrafficSite) => {
    setChecking(s.id);
    try {
      const r = await post<{ latency_ms: number; rpm: number; tpm: number }>(`/traffic/sites/${s.id}/check`);
      toast.success(`${s.name} 连接正常 · ${ms(r.latency_ms)} · 当前 RPM ${num(r.rpm)} · TPM ${num(r.tpm)}`);
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setChecking(null);
    }
  };
  const remove = async (s: TrafficSite) => {
    if (!(await confirm({ title: `删除监控服务器「${s.name}」？`, destructive: true, confirmText: "删除" }))) return;
    try {
      await del(`/traffic/sites/${s.id}`);
      toast.success("已删除");
      reload();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const setDefault = async (s: TrafficSite) => {
    try {
      await put(`/traffic/sites/${s.id}/default`, {});
      reload();
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>监控的服务器</CardTitle>
        <CardDescription>
          sub2api 类型的服务器：填站点地址和 Admin Key。Key 只保存在后端，不会发到浏览器。
        </CardDescription>
        <CardAction>
          <Button onClick={() => openForm(null)}>
            <Plus />
            添加服务器
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>Admin Key</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length ? (
                rows.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      {s.name} {s.is_default ? <Tag tone="info">默认</Tag> : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{s.base_url}</TableCell>
                    <TableCell className="font-mono text-xs">{s.key_masked}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Button size="sm" variant="outline" disabled={checking === s.id} onClick={() => check(s)}>
                          {checking === s.id ? "测试中…" : "测试连接"}
                        </Button>
                        {!s.is_default ? (
                          <Button size="sm" variant="ghost" onClick={() => setDefault(s)}>
                            <Star />
                            设为默认
                          </Button>
                        ) : null}
                        <Button size="sm" variant="ghost" onClick={() => openForm(s)}>
                          <Pencil />
                          编辑
                        </Button>
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove(s)}>
                          <Trash2 />
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground py-10 text-center">
                    还没有监控的服务器，点右上角「添加服务器」
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <Pager {...pager} />
      </CardContent>
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title={editing ? `编辑「${editing.name}」` : "添加监控服务器"}
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ts-name">名称</Label>
            <Input id="ts-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ts-url">URL</Label>
            <Input
              id="ts-url"
              placeholder="https://example.com"
              value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ts-key">Admin Key</Label>
            <Input
              id="ts-key"
              type="password"
              autoComplete="off"
              placeholder={editing ? `留空保持原值（${editing.key_masked}）` : "admin-…"}
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={busy} onClick={submit}>
              保存
            </Button>
          </div>
        </div>
      </ResponsiveDialog>
      {confirmEl}
    </Card>
  );
}
