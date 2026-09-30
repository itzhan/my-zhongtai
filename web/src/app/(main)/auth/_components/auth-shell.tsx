import type { ReactNode } from "react";

import { Activity } from "lucide-react";

// shadmin auth v1 版式：左侧品牌色块，右侧表单
export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex h-dvh">
      <div className="bg-primary hidden lg:block lg:w-1/3">
        <div className="flex h-full flex-col items-center justify-center p-12 text-center">
          <div className="space-y-6">
            <Activity className="text-primary-foreground mx-auto size-12" />
            <div className="space-y-2">
              <h1 className="text-primary-foreground text-4xl font-light">运维中台</h1>
              <p className="text-primary-foreground/80 text-lg">客户 · 渠道 · 监控 · 供应商</p>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-background flex w-full items-center justify-center p-8 lg:w-2/3">
        <div className="w-full max-w-md space-y-10 py-24 lg:py-32">
          <div className="space-y-4 text-center">
            <div className="text-xl font-medium tracking-tight">{title}</div>
            <div className="text-muted-foreground mx-auto max-w-xl">{subtitle}</div>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
