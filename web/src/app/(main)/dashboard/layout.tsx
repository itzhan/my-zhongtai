import { ReactNode } from "react";

import { AppSidebar } from "@/app/(main)/dashboard/_components/sidebar/app-sidebar";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { OpsProvider } from "@/modules/ops/provider";
import { TabsStoreProvider } from "@/stores/tabs/tab-store-provider";

import { AlertBar, ReadonlyBadge } from "./_components/alert-bar";
import { LayoutControls } from "./_components/sidebar/layout-controls";
import { PersistedSidebarProvider } from "./_components/sidebar/persisted-sidebar-provider";
import { SearchDialog } from "./_components/sidebar/search-dialog";
import { ThemeSwitcher } from "./_components/sidebar/theme-switcher";
import { TabBar } from "./_components/tab-bar";

// 布局偏好用默认值（偏好面板的改动只作用于当前页面 DOM，不写 cookie）。
// 这里不读 cookies()：否则每个页面都成了动态渲染，切 tab 都要先等服务器渲染一次。
const sidebarVariant = "inset";
const sidebarCollapsible = "icon";
const contentLayout = "centered";
const navbarStyle = "scroll";
const layoutPreferences = {
  contentLayout,
  variant: sidebarVariant,
  collapsible: sidebarCollapsible,
  navbarStyle,
} as const;

export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <TabsStoreProvider>
      <OpsProvider>
        <PersistedSidebarProvider>
          <AppSidebar variant={sidebarVariant} collapsible={sidebarCollapsible} />
          <SidebarInset
            data-content-layout={contentLayout}
            className={cn(
              // min-w-0：宽表格只在自己的容器里横向滚动，不把主内容区撑出屏幕
              "min-w-0",
              // Adds right margin for inset sidebar up to certain breakpoints
              "max-[113rem]:peer-data-[variant=inset]:!mr-2 min-[101rem]:peer-data-[variant=inset]:peer-data-[state=collapsed]:!mr-auto",
            )}
          >
            <header
              data-navbar-style={navbarStyle}
              className={cn(
                "flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12",
                // Handle sticky navbar style with conditional classes so blur, background, z-index, and rounded corners remain consistent across all SidebarVariant layouts.
                "data-[navbar-style=sticky]:bg-background/50 data-[navbar-style=sticky]:sticky data-[navbar-style=sticky]:top-0 data-[navbar-style=sticky]:z-50 data-[navbar-style=sticky]:overflow-hidden data-[navbar-style=sticky]:rounded-t-[inherit] data-[navbar-style=sticky]:backdrop-blur-md",
              )}
            >
              <div className="flex w-full items-center justify-between px-4 lg:px-6">
                <div className="flex items-center gap-1 lg:gap-2">
                  <SidebarTrigger className="-ml-1" />
                  <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
                  <SearchDialog />
                </div>
                <div className="flex items-center gap-2">
                  <ReadonlyBadge />
                  <LayoutControls {...layoutPreferences} />
                  <ThemeSwitcher />
                </div>
              </div>
            </header>
            <TabBar />
            <AlertBar />
            <div className="h-full p-4 md:p-6">{children}</div>
          </SidebarInset>
        </PersistedSidebarProvider>
      </OpsProvider>
    </TabsStoreProvider>
  );
}
