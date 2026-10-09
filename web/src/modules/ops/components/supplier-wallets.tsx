"use client";

import { useEffect, useState } from "react";

import Link from "next/link";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { del, patch, post } from "../api";
import { ago, readErr } from "../format";
import type { Supplier, SupplierWallet } from "../types";

import { Tag } from "./badges";
import { FormError, Pager, ResponsiveDialog, useConfirm, usePaged } from "./shared";

export const PLATFORMS: [SupplierWallet["platform"], string][] = [
  ["newapi", "new-api"],
  ["sub2api", "sub2api"],
];
const KIND_LABEL: Record<string, string> = {
  wallet: "钱包余额",
  token: "Key 剩余额度",
  quota: "Key 限额剩余",
  subscription: "订阅剩余",
};

// 额度数字：两位小数、千分位，不带币种（供应商站点的额度单位，一般是 $）
export const amt = (v: number | null | undefined) =>
  v == null ? "-" : Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function ratioSource(w: SupplierWallet) {
  const s = w.last_ratio_source;
  if (w.custom) return "自定义";
  if (s === "billing") return "Key 计费接口";
  if (s === "usage") return "按消费记录反推";
  if (s.startsWith("log")) return `最近消费日志${s.includes(":") ? `（${s.split(":")[1]} 分组）` : ""}`;
  if (s === "pricing-default") return "站点 default 分组（估计）";
  return s;
}

// 新增 / 编辑余额监控：平台 + 站点地址 + Key，可选自定义倍率
export function WalletDialog({
  open,
  onOpenChange,
  wallet,
  suppliers,
  presetSupplier,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  wallet?: SupplierWallet | null;
  suppliers: Pick<Supplier, "id" | "name" | "base_url">[];
  presetSupplier?: number;
  onSaved: () => void;
}) {
  const empty = {
    supplier_id: presetSupplier ? String(presetSupplier) : "",
    name: "",
    platform: "newapi" as SupplierWallet["platform"],
    base_url: suppliers.find((s) => s.id === presetSupplier)?.base_url || "",
    api_key: "",
    custom: false,
    custom_ratio: "",
  };
  const [v, setV] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setV(
      wallet
        ? {
            supplier_id: String(wallet.supplier_id),
            name: wallet.name,
            platform: wallet.platform,
            base_url: wallet.base_url,
            api_key: "",
            custom: wallet.custom,
            custom_ratio: wallet.custom_ratio == null ? "" : String(wallet.custom_ratio),
          }
        : empty,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, wallet]);

  const save = async () => {
    if (!v.supplier_id) return setError("先选择供应商");
    if (!/^https?:\/\//i.test(v.base_url.trim())) return setError("站点地址需以 http:// 或 https:// 开头");
    if (!wallet && !v.api_key.trim()) return setError("API Key 必填");
    if (v.custom && !(Number(v.custom_ratio) > 0)) return setError("自定义倍率必须大于 0");
    setSaving(true);
    setError(null);
    const body = {
      supplier_id: Number(v.supplier_id),
      name: v.name,
      platform: v.platform,
      base_url: v.base_url.trim(),
      custom: v.custom,
      custom_ratio: v.custom ? Number(v.custom_ratio) : null,
      ...(v.api_key.trim() ? { api_key: v.api_key.trim() } : {}),
    };
    try {
      const r = wallet
        ? await patch<SupplierWallet>(`/supplier-wallets/${wallet.id}`, body)
        : await post<SupplierWallet>("/supplier-wallets", body);
      if (r.last_error) toast.error(`已保存，但抓取失败：${r.last_error}`);
      else toast.success(`已保存 · ${KIND_LABEL[r.last_wallet_kind] ?? "余额"} ${amt(r.last_wallet)}`);
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError(readErr(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={wallet ? "编辑余额监控" : "添加余额监控"}
      description="用我们在供应商站点的 API Key 抓钱包额度和这把 Key 的倍率。只发查询请求，不产生费用。"
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>供应商 *</Label>
            <Select
              value={v.supplier_id}
              disabled={!!wallet || !!presetSupplier}
              onValueChange={(x) =>
                setV({
                  ...v,
                  supplier_id: x,
                  base_url: v.base_url || suppliers.find((s) => String(s.id) === x)?.base_url || "",
                })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择供应商" />
              </SelectTrigger>
              <SelectContent>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>名称</Label>
            <Input
              placeholder="如 Claude 号池 / 主 Key"
              value={v.name}
              onChange={(e) => setV({ ...v, name: e.target.value })}
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          <div className="space-y-2">
            <Label>平台 *</Label>
            <Select value={v.platform} onValueChange={(x) => setV({ ...v, platform: x as SupplierWallet["platform"] })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORMS.map(([k, l]) => (
                  <SelectItem key={k} value={k}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>站点地址 *</Label>
            <Input
              placeholder="https://api.example.com"
              value={v.base_url}
              onChange={(e) => setV({ ...v, base_url: e.target.value })}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label>API Key {wallet ? (wallet.has_key ? `（当前 ${wallet.key_masked}，留空 = 不修改）` : "") : "*"}</Label>
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="sk-..."
            value={v.api_key}
            onChange={(e) => setV({ ...v, api_key: e.target.value })}
          />
        </div>
        <div className="bg-muted/40 space-y-3 rounded-lg border p-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              <span className="font-medium">自定义倍率</span>
              <span className="text-muted-foreground block text-xs">
                供应商倍率始终显示 1、充值时按倍率折算额度（如充 9000、3 倍率 → 给 3000 额度）时打开：
                不抓倍率，实际余额 = 钱包额度 × 自定义倍率
              </span>
            </span>
            <Switch checked={v.custom} onCheckedChange={(x) => setV({ ...v, custom: x })} />
          </label>
          {v.custom ? (
            <div className="flex items-center gap-2">
              <Label className="shrink-0">倍率</Label>
              <Input
                inputMode="decimal"
                className="w-32"
                placeholder="如 3"
                value={v.custom_ratio}
                onChange={(e) => setV({ ...v, custom_ratio: e.target.value })}
              />
              {Number(v.custom_ratio) > 0 ? (
                <span className="text-muted-foreground text-xs">
                  钱包 3,000 → 实际余额 {amt(3000 * Number(v.custom_ratio))}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <FormError>{error}</FormError>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "保存并抓取中…" : "保存并抓取"}
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

// 余额表：钱包额度 / 倍率（来源）/ 实际余额，可手动刷新
export function WalletTable({
  wallets,
  suppliers,
  showSupplier,
  onChanged,
}: {
  wallets: SupplierWallet[];
  suppliers: Pick<Supplier, "id" | "name" | "base_url">[];
  showSupplier?: boolean;
  onChanged: () => void;
}) {
  const [confirm, confirmEl] = useConfirm();
  const [editing, setEditing] = useState<SupplierWallet | null>(null);
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const { rows, pager } = usePaged(wallets, String(wallets.length));

  const refresh = async (w: SupplierWallet) => {
    setBusy((s) => new Set(s).add(w.id));
    try {
      const r = await post<SupplierWallet>(`/supplier-wallets/${w.id}/refresh`);
      if (r.last_error) toast.error(`${w.name}：${r.last_error}`);
      else toast.success(`${w.name}：实际余额 ${amt(r.last_actual)}`);
      onChanged();
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(w.id);
        return n;
      });
    }
  };
  const toggle = async (w: SupplierWallet, on: boolean) => {
    try {
      await patch(`/supplier-wallets/${w.id}`, { enabled: on });
      onChanged();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const remove = async (w: SupplierWallet) => {
    if (!(await confirm({ title: `删除余额监控「${w.name}」？`, destructive: true, confirmText: "删除" }))) return;
    try {
      await del(`/supplier-wallets/${w.id}`);
      toast.success("已删除");
      onChanged();
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  const cols = showSupplier ? 8 : 7;
  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {showSupplier ? <TableHead>供应商</TableHead> : null}
              <TableHead>名称 / 平台</TableHead>
              <TableHead className="text-right">钱包额度</TableHead>
              <TableHead className="text-right">倍率</TableHead>
              <TableHead className="text-right">实际余额</TableHead>
              <TableHead>最近抓取</TableHead>
              <TableHead>启用</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {wallets.length ? (
              rows.map((w) => (
                <TableRow key={w.id}>
                  {showSupplier ? (
                    <TableCell>
                      <Link
                        prefetch={false}
                        href={`/dashboard/suppliers/${w.supplier_id}`}
                        className="font-medium hover:underline"
                      >
                        {w.supplier_name}
                      </Link>
                    </TableCell>
                  ) : null}
                  <TableCell className="max-w-64">
                    <div className="flex items-center gap-1.5">
                      {w.name}
                      <Tag tone={w.platform === "sub2api" ? "info" : "ok"}>
                        {w.platform === "sub2api" ? "sub2api" : "new-api"}
                      </Tag>
                      {w.custom ? <Tag tone="warn">自定义倍率</Tag> : null}
                    </div>
                    <div className="text-muted-foreground truncate font-mono text-xs" title={w.base_url}>
                      {w.base_url} · {w.has_key ? w.key_masked : "未填 Key"}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {amt(w.last_wallet)}
                    {w.last_wallet_kind ? (
                      <div className="text-muted-foreground text-xs">
                        {KIND_LABEL[w.last_wallet_kind] ?? w.last_wallet_kind}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {w.last_ratio == null ? "-" : `× ${+w.last_ratio.toFixed(4)}`}
                    <div className="text-muted-foreground max-w-44 truncate text-xs" title={ratioSource(w)}>
                      {ratioSource(w)}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {amt(w.last_actual)}
                    <div className="text-muted-foreground text-xs font-normal">
                      {w.custom ? "= 钱包 × 倍率" : "= 钱包额度"}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <span className="text-muted-foreground text-xs">{ago(w.last_checked_at)}</span>
                    {w.last_error ? (
                      <div className="text-danger max-w-64 truncate text-xs" title={w.last_error}>
                        {w.last_error}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Switch checked={w.enabled} onCheckedChange={(x) => toggle(w, x)} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="flex gap-2 text-sm">
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        disabled={busy.has(w.id)}
                        onClick={() => refresh(w)}
                      >
                        {busy.has(w.id) ? "抓取中…" : "刷新"}
                      </button>
                      <button type="button" className="text-primary hover:underline" onClick={() => setEditing(w)}>
                        编辑
                      </button>
                      <button type="button" className="text-muted-foreground hover:underline" onClick={() => remove(w)}>
                        删除
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={cols} className="text-muted-foreground py-8 text-center">
                  还没有余额监控，点「添加」填平台和 Key
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <Pager {...pager} className="mt-3" />
      <WalletDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        wallet={editing}
        suppliers={suppliers}
        onSaved={onChanged}
      />
      {confirmEl}
    </>
  );
}
