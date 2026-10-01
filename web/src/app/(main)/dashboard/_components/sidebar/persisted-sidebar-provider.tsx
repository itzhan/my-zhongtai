"use client";

import { type ReactNode, useEffect, useState } from "react";

import { SidebarProvider } from "@/components/ui/sidebar";

// 侧栏展开状态在客户端读 cookie（sidebar_state，由 SidebarProvider 写入）。
// 布局不再在服务端读 cookies()，dashboard 下的页面才能静态预渲染、预加载，切换 tab 不必每次等服务器。
export function PersistedSidebarProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (/(?:^|;\s*)sidebar_state=false/.test(document.cookie)) setOpen(false);
  }, []);
  return (
    <SidebarProvider open={open} onOpenChange={setOpen}>
      {children}
    </SidebarProvider>
  );
}
