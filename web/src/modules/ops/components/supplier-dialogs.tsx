"use client";

import { useEffect, useState } from "react";

import { Copy, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { patch, post } from "../api";
import { readErr } from "../format";
import type { Supplier, SupplierMonitor } from "../types";

import { Tag, type Tone } from "./badges";
import { FormError, ResponsiveDialog } from "./shared";

export const CATEGORIES: [string, string, Tone][] = [
  ["gpt", "GPT", "info"],
  ["claude", "Claude", "warn"],
  ["aws", "AWS", "bad"],
  ["cardshop", "卡网", "ok"],
];
export const STATUS: Record<string, [string, Tone]> = {
  active: ["合作中", "ok"],
  paused: ["暂停", "warn"],
  closed: ["已终止", "muted"],
};
export const KINDS: [SupplierMonitor["kind"], string][] = [
  ["openai", "GPT Completions"],
  ["openai_response", "GPT Responses"],
  ["claude", "Claude"],
];
export const DEFAULT_MODEL: Record<string, string> = {
  openai: "gpt-5.5",
  openai_response: "gpt-5.5",
  claude: "claude-sonnet-4-6",
};

export function CategoryTags({ list }: { list: string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {list.map((c) => {
        const m = CATEGORIES.find(([k]) => k === c);
        return (
          <Tag key={c} tone={m?.[2] ?? "muted"}>
            {m?.[1] ?? c}
          </Tag>
        );
      })}
    </span>
  );
}

// 从货名里认 GPT / Claude / AWS / 卡网关键词给个颜色（同 zhongtai goodsKeyword）
export function goodsTone(name: string): Tone {
  const s = name.toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku/.test(s)) return "warn";
  if (/aws|bedrock|kiro/.test(s)) return "bad";
  if (/gpt|openai|codex|o\d/.test(s)) return "info";
  if (/卡|card/.test(s)) return "ok";
  return "muted";
}

// 新建 / 编辑供应商（新建时可一并填可提供的货）
export function SupplierDialog({
  open,
  onOpenChange,
  supplier,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  supplier?: Supplier | null;
  onSaved: (s: Supplier) => void;
}) {
  const [v, setV] = useState({ name: "", base_url: "", contact: "", wechat: "", status: "active", notes: "" });
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [goods, setGoods] = useState<{ name: string; rate: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setV({
      name: supplier?.name ?? "",
      base_url: supplier?.base_url ?? "",
      contact: supplier?.contact ?? "",
      wechat: supplier?.wechat ?? "",
      status: supplier?.status ?? "active",
      notes: supplier?.notes ?? "",
    });
    setCats(new Set(supplier?.category ?? []));
    setGoods(supplier ? [] : [{ name: "", rate: "" }]);
    setError(null);
  }, [open, supplier]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...v, category: [...cats] };
      const r = supplier
        ? await patch<Supplier>(`/suppliers/${supplier.id}`, body)
        : await post<Supplier>("/suppliers", { ...body, goods: goods.filter((g) => g.name.trim()) });
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
      title={supplier ? "编辑供应商" : "新建供应商"}
      className="sm:max-w-xl"
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>名称 *</Label>
            <Input value={v.name} autoFocus onChange={(e) => setV({ ...v, name: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>状态</Label>
            <Select value={v.status} onValueChange={(x) => setV({ ...v, status: x })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(STATUS).map(([k, [l]]) => (
                  <SelectItem key={k} value={k}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <Label>业务分类</Label>
          <div className="flex flex-wrap gap-4">
            {CATEGORIES.map(([k, l]) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={cats.has(k)}
                  onCheckedChange={(x) =>
                    setCats((s) => {
                      const n = new Set(s);
                      if (x) n.add(k);
                      else n.delete(k);
                      return n;
                    })
                  }
                />
                {l}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Telegram</Label>
            <Input
              placeholder="@username"
              value={v.contact}
              onChange={(e) => setV({ ...v, contact: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>微信号</Label>
            <Input value={v.wechat} onChange={(e) => setV({ ...v, wechat: e.target.value })} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>网站 / 对接地址</Label>
          <Input placeholder="https://" value={v.base_url} onChange={(e) => setV({ ...v, base_url: e.target.value })} />
        </div>
        <div className="space-y-2">
          <Label>备注</Label>
          <Textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
        </div>
        {!supplier ? (
          <div className="space-y-2">
            <Label>可以提供的货（名称 + 倍率，倍率可填区间如 0.8-1.2）</Label>
            {goods.map((g, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  placeholder="货物，如 Claude Max 号"
                  value={g.name}
                  onChange={(e) => setGoods((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <Input
                  className="w-32"
                  placeholder="倍率"
                  value={g.rate}
                  onChange={(e) => setGoods((l) => l.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))}
                />
                <Button variant="ghost" size="icon" onClick={() => setGoods((l) => l.filter((_, j) => j !== i))}>
                  <X />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setGoods((l) => [...l, { name: "", rate: "" }])}>
              <Plus />
              加一行
            </Button>
          </div>
        ) : null}
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

// 新建 / 编辑接口监测项
export function MonitorDialog({
  open,
  onOpenChange,
  monitor,
  suppliers,
  presetSupplier,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  monitor?: SupplierMonitor | null;
  suppliers: Pick<Supplier, "id" | "name" | "base_url">[];
  presetSupplier?: number;
  onSaved: () => void;
}) {
  const [v, setV] = useState({
    supplier_id: "",
    name: "",
    kind: "openai_response",
    base_url: "",
    api_key: "",
    model: "",
    slow_ms: "5000",
    enabled: true,
  });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    const sid = String(monitor?.supplier_id ?? presetSupplier ?? "");
    setV({
      supplier_id: sid,
      name: monitor?.name ?? "",
      kind: monitor?.kind ?? "openai_response",
      base_url: monitor?.base_url ?? suppliers.find((s) => String(s.id) === sid)?.base_url ?? "",
      api_key: "",
      model: monitor?.model ?? "",
      slow_ms: String(monitor?.slow_ms ?? 5000),
      enabled: monitor?.enabled ?? true,
    });
  }, [open, monitor, presetSupplier, suppliers]);
  const save = async () => {
    setError(null);
    try {
      const body = { ...v, supplier_id: Number(v.supplier_id), slow_ms: Number(v.slow_ms) };
      if (monitor) await patch(`/supplier-monitors/${monitor.id}`, body);
      else await post("/supplier-monitors", body);
      toast.success("已保存");
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError(readErr(e));
    }
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={monitor ? "编辑监测项" : "新增监测项"}
      description="每 60 秒对供应商接口发一次「ping」（极小的真实请求），记录状态与延迟。本地只读模式下不自动探测，可手动探测。"
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>供应商 *</Label>
            <Select
              value={v.supplier_id}
              onValueChange={(x) =>
                setV({
                  ...v,
                  supplier_id: x,
                  base_url: v.base_url || suppliers.find((s) => String(s.id) === x)?.base_url || "",
                })
              }
              disabled={!!monitor}
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
            <Label>渠道名</Label>
            <Input placeholder="如 官key / AWS" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>接口格式</Label>
            <Select value={v.kind} onValueChange={(x) => setV({ ...v, kind: x })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map(([k, l]) => (
                  <SelectItem key={k} value={k}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>模型</Label>
            <Input
              placeholder={`默认 ${DEFAULT_MODEL[v.kind]}`}
              value={v.model}
              onChange={(e) => setV({ ...v, model: e.target.value })}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label>接口地址 *</Label>
          <Input
            placeholder="https://api.example.com"
            value={v.base_url}
            onChange={(e) => setV({ ...v, base_url: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label>
            API Key {monitor ? (monitor.has_key ? `（当前 ${monitor.key_masked}，留空 = 不修改）` : "") : ""}
          </Label>
          <Input
            type="password"
            autoComplete="new-password"
            value={v.api_key}
            onChange={(e) => setV({ ...v, api_key: e.target.value })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-6">
          <label className="flex items-center gap-2 text-sm">
            偏慢阈值（ms）
            <Input
              type="number"
              className="h-8 w-24"
              value={v.slow_ms}
              onChange={(e) => setV({ ...v, slow_ms: e.target.value })}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            启用 <Switch checked={v.enabled} onCheckedChange={(x) => setV({ ...v, enabled: x })} />
          </label>
        </div>
        <FormError>{error}</FormError>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save}>保存</Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

// 联系方式：点击复制
export function CopyLine({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs"
      title="点击复制"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast.success(`已复制${label}`);
        } catch {
          toast.error("复制失败");
        }
      }}
    >
      <span>{label}</span>
      <span className="text-foreground font-medium">{value}</span>
      <Copy className="size-3" />
    </button>
  );
}
