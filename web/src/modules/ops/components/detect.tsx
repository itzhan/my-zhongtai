"use client";

import { useEffect, useState } from "react";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { get, post, put } from "../api";
import { ago, ms, readErr, time } from "../format";

import { Tag, VERDICT } from "./badges";
import { useConfirm } from "./shared";

export type DetectResult = {
  at: string;
  reason: string;
  model: string;
  expect: string;
  verdict: string;
  ms: number;
  checks: { name: string; level: string; detail: string }[];
};
export type DetectInfo = { has_key?: boolean; key_masked?: string; latest?: DetectResult | null; running?: boolean };

export function VerdictTag({ v, title }: { v: string; title?: string }) {
  const [tone, label] = VERDICT[v] ?? ["muted", v];
  return (
    <Tag tone={tone} title={title}>
      {label}
    </Tag>
  );
}

// 深度检测单元格：录入 Key / 最近结果 / 立即检测（直接请求上游，会产生费用；只读模式下后端会拦截）
export function DetectCell({
  a,
  onChanged,
}: {
  a: { id: number; name: string; detect?: DetectInfo };
  onChanged: () => void;
}) {
  const [keyOpen, setKeyOpen] = useState(false);
  const [result, setResult] = useState<{ r: DetectResult; history: DetectResult[] } | null>(null);
  const [running, setRunning] = useState(false);
  const dt = a.detect || {};
  const run = async () => {
    setRunning(true);
    try {
      const r = await post<DetectResult>(`/detect/accounts/${a.id}/run`);
      setResult({ r, history: [] });
      onChanged();
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setRunning(false);
    }
  };
  const show = async () => {
    const h = await get<{ history: DetectResult[] }>(`/detect/accounts/${a.id}`);
    if (h.history[0]) setResult({ r: h.history[0], history: h.history });
  };
  return (
    <>
      {!dt.has_key ? (
        <button type="button" className="text-primary text-xs hover:underline" onClick={() => setKeyOpen(true)}>
          录入 Key
        </button>
      ) : (
        <div className="space-y-1 text-xs">
          {dt.latest ? (
            <button type="button" onClick={show} className="flex items-center gap-1">
              <VerdictTag v={dt.latest.verdict} title={time(dt.latest.at)} />
              <span className="text-muted-foreground">{ago(dt.latest.at)}</span>
            </button>
          ) : (
            <span className="text-muted-foreground">未检测</span>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="text-primary hover:underline"
              disabled={running || dt.running}
              onClick={run}
            >
              {running || dt.running ? "检测中…" : "检测"}
            </button>
            <button type="button" className="text-muted-foreground hover:underline" onClick={() => setKeyOpen(true)}>
              Key
            </button>
          </div>
        </div>
      )}
      <DetectKeyDialog open={keyOpen} onOpenChange={setKeyOpen} account={a} onSaved={onChanged} />
      <DetectResultDialog account={a} data={result} onClose={() => setResult(null)} />
    </>
  );
}

export function DetectKeyDialog({
  open,
  onOpenChange,
  account,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  account: { id: number; name: string; detect?: DetectInfo };
  onSaved: () => void;
}) {
  const [key, setKey] = useState("");
  const [confirm, confirmEl] = useConfirm();
  const dt = account.detect || {};
  useEffect(() => setKey(""), [open]);
  const save = async () => {
    if (
      !key.trim() &&
      dt.has_key &&
      !(await confirm({ title: "删除这个账号的检测 Key 和检测记录？", destructive: true, confirmText: "删除" }))
    )
      return;
    try {
      await put(`/detect/accounts/${account.id}/key`, { key: key.trim() });
      toast.success(key.trim() ? "已保存 Key" : "已删除 Key");
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>检测 Key · {account.name}</DialogTitle>
        </DialogHeader>
        <p className="text-muted-foreground text-sm">
          检测请求会用这个 Key 直接请求该账号在 sub2api 里配置的上游地址（域名不变），不经过 sub2api，也不影响客户流量。
          {dt.has_key ? (
            <>
              当前：<span className="font-mono">{dt.key_masked}</span>
            </>
          ) : null}
        </p>
        <div className="space-y-2">
          <Label htmlFor="dkey">上游 Key</Label>
          <Input
            id="dkey"
            type="password"
            autoComplete="off"
            placeholder={dt.has_key ? "留空并保存 = 删除 Key" : "sk-…"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={save}>保存</Button>
        </div>
        {confirmEl}
      </DialogContent>
    </Dialog>
  );
}

export function DetectResultDialog({
  account,
  data,
  onClose,
}: {
  account: { name: string };
  data: { r: DetectResult; history: DetectResult[] } | null;
  onClose: () => void;
}) {
  const r = data?.r;
  return (
    <Dialog open={!!r} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            深度检测 · {account.name} {r ? <VerdictTag v={r.verdict} /> : null}
          </DialogTitle>
        </DialogHeader>
        {r ? (
          <div className="space-y-4">
            <p className="text-muted-foreground text-xs">
              {time(r.at)} · {r.reason} · 模型 {r.model || "-"} · 期望上游{" "}
              {r.expect === "bedrock" ? "AWS Bedrock" : "不限"} · 耗时 {ms(r.ms)}
            </p>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>检测项</TableHead>
                    <TableHead>结果</TableHead>
                    <TableHead>详情</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.checks.map((c, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell>
                        <VerdictTag v={c.level} />
                      </TableCell>
                      <TableCell className="text-xs break-all whitespace-normal">{c.detail}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {data && data.history.length > 1 ? (
              <div className="space-y-2">
                <div className="text-sm font-medium">最近记录</div>
                <div className="flex flex-wrap gap-1">
                  {data.history.slice(0, 30).map((h, i) => (
                    <VerdictTag key={i} v={h.verdict} title={`${time(h.at)} ${h.reason}`} />
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
