"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

import { num } from "../format";

// 电脑上是对话框，手机上是底部抽屉
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
        <DrawerContent className="max-h-[92dvh]">
          <DrawerHeader className="text-left">
            <DrawerTitle>{title}</DrawerTitle>
            {description ? <DrawerDescription>{description}</DrawerDescription> : null}
          </DrawerHeader>
          <div className="overflow-y-auto px-4 pb-6">{children}</div>
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-h-[90dvh] overflow-y-auto sm:max-w-lg", className)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function FormError({ children }: { children?: string | null }) {
  if (!children) return null;
  return <p className="text-destructive text-sm">{children}</p>;
}

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1">
        {back}
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <div className="text-muted-foreground text-sm">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export type Stat = { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string };

// shadmin 仪表盘样式的统计卡
export function StatCards({ items, cols = 4 }: { items: Stat[]; cols?: 3 | 4 | 5 }) {
  return (
    <div
      className={cn(
        "*:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card dark:*:data-[slot=card]:bg-card grid grid-cols-2 gap-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:shadow-xs",
        cols === 3 && "lg:grid-cols-3",
        cols === 4 && "lg:grid-cols-4",
        cols === 5 && "lg:grid-cols-5",
      )}
    >
      {items.map((s, i) => (
        <Card key={i} className="@container/card gap-2 py-5">
          <CardHeader className="px-5">
            <CardDescription>{s.label}</CardDescription>
            <CardTitle className={cn("text-2xl font-semibold tabular-nums", s.className)}>{s.value}</CardTitle>
          </CardHeader>
          {s.sub ? <CardFooter className="text-muted-foreground px-5 text-xs">{s.sub}</CardFooter> : null}
        </Card>
      ))}
    </div>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil((total || 0) / (pageSize || 50)));
  return (
    <div className="text-muted-foreground flex items-center justify-end gap-2 text-sm">
      <span>
        共 {num(total)} 条 · 第 {page}/{pages} 页
      </span>
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        上一页
      </Button>
      <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        下一页
      </Button>
    </div>
  );
}

type ConfirmOpts = {
  title: string;
  description?: ReactNode;
  confirmText?: string;
  destructive?: boolean;
  typeToConfirm?: string;
};

// 用 AlertDialog 替代原生 confirm()：const [confirm, confirmEl] = useConfirm()
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const [typed, setTyped] = useState("");
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOpts) => {
    setTyped("");
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpts(null);
  };

  const blocked = !!opts?.typeToConfirm && typed.trim() !== opts.typeToConfirm;
  const el = (
    <AlertDialog open={!!opts} onOpenChange={(o) => !o && close(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
          {opts?.description ? (
            <AlertDialogDescription asChild>
              <div>{opts.description}</div>
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        {opts?.typeToConfirm ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm">
              确认请输入：<b className="text-foreground">{opts.typeToConfirm}</b>
            </p>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => close(false)}>取消</AlertDialogCancel>
          <AlertDialogAction
            disabled={blocked}
            className={cn(opts?.destructive && "bg-destructive hover:bg-destructive/90 text-white")}
            onClick={(e) => {
              e.preventDefault();
              if (!blocked) close(true);
            }}
          >
            {opts?.confirmText ?? "确定"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return [confirm, el] as const;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground py-10 text-center text-sm">{children}</div>;
}
