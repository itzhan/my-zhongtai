"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

// 页面作为另一个页面的 tab 嵌入时，PageHeader 不再显示标题和返回链接（tab 名就是标题），只留说明和按钮
const EmbeddedCtx = createContext(false);
export function Embedded({ children }: { children: ReactNode }) {
  return <EmbeddedCtx.Provider value={true}>{children}</EmbeddedCtx.Provider>;
}

// 页面内 tab 记在地址栏 ?tab=，刷新、分享链接都能回到同一个 tab（使用的页面需包一层 <Suspense>）
export function useTabParam<T extends string>(tabs: readonly T[], fallback: T): [T, (t: string) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const cur = params.get("tab");
  const tab = tabs.includes(cur as T) ? (cur as T) : fallback;
  const setTab = (t: string) => router.replace(t === fallback ? pathname : `${pathname}?tab=${t}`, { scroll: false });
  return [tab, setTab];
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
  const embedded = useContext(EmbeddedCtx);
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1">
        {embedded ? null : back}
        {embedded ? null : (
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">{title}</h1>
        )}
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

export const PAGE_SIZES = [10, 20, 50, 100];
export const DEFAULT_PAGE_SIZE = 20;
const MIN_PAGE_SIZE = 10;

// 分页条：共 N 条 · 每页 [20] 条 · 上一页 x/y 下一页。total 不超过最小档时不显示
export function Pager({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize?: (s: number) => void;
  className?: string;
}) {
  const pages = Math.max(1, Math.ceil((total || 0) / (pageSize || DEFAULT_PAGE_SIZE)));
  if ((total || 0) <= MIN_PAGE_SIZE && page <= 1) return null;
  return (
    <div className={cn("text-muted-foreground flex flex-wrap items-center justify-end gap-2 text-sm", className)}>
      <span>共 {num(total)} 条</span>
      {onPageSize ? (
        <Select
          value={String(pageSize)}
          onValueChange={(v) => {
            onPageSize(Number(v));
            onPage(1);
          }}
        >
          <SelectTrigger size="sm" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} 条/页
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        上一页
      </Button>
      <span className="tabular-nums">
        {page} / {pages}
      </span>
      <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        下一页
      </Button>
    </div>
  );
}

// 前端分页：const { rows, pager } = usePaged(list)；<Pager {...pager} />。
// resetKey（字符串，如 JSON.stringify(筛选条件)）变化时回到第 1 页
export function usePaged<T>(items: T[], resetKey: unknown = null, defaultSize = DEFAULT_PAGE_SIZE) {
  const [state, setState] = useState({ page: 1, key: resetKey });
  const [pageSize, setPageSize] = useState(defaultSize);
  const page = Object.is(state.key, resetKey) ? state.page : 1;
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const cur = Math.min(page, pages);
  return {
    rows: items.slice((cur - 1) * pageSize, cur * pageSize),
    pager: {
      page: cur,
      pageSize,
      total: items.length,
      onPage: (p: number) => setState({ page: p, key: resetKey }),
      onPageSize: setPageSize,
    },
  };
}

// 渲染函数形式的前端分页，用在 .map 循环里（循环里不能直接调 hook）
export function PagedList<T>({
  items,
  children,
  className = "mt-3",
}: {
  items: T[];
  children: (rows: T[]) => ReactNode;
  className?: string;
}) {
  const { rows, pager } = usePaged(items);
  return (
    <>
      {children(rows)}
      <Pager {...pager} className={className} />
    </>
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
