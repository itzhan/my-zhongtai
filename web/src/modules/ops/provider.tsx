"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Spinner } from "@/components/ui/spinner";

import { useEnv, useMeta } from "./hooks";
import type { Group } from "./types";

type OpsCtx = {
  groups: Group[];
  groupName: (id: number) => string;
  readonly: boolean;
};

const Ctx = createContext<OpsCtx | null>(null);

export function useOps() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useOps 必须在 OpsProvider 内使用");
  return c;
}

export function OpsProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <OpsInner>{children}</OpsInner>
    </QueryClientProvider>
  );
}

// 先拿分组元数据（顺带验证登录，未登录会跳到登录页）
function OpsInner({ children }: { children: ReactNode }) {
  const meta = useMeta();
  const env = useEnv();
  const value = useMemo<OpsCtx | null>(() => {
    if (!meta.data) return null;
    const groups = meta.data.groups;
    return {
      groups,
      groupName: (id) => groups.find((g) => g.id === id)?.name ?? `#${id}`,
      readonly: env.data?.readonly ?? true,
    };
  }, [meta.data, env.data]);

  if (!value) {
    return (
      <div className="text-muted-foreground flex h-[60vh] items-center justify-center gap-2 text-sm">
        <Spinner /> {meta.isError ? meta.error.message : "加载中…"}
      </div>
    );
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
