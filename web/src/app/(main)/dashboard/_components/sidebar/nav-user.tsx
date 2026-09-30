"use client";

import { EllipsisVertical, LogOut, ShieldCheck } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { post } from "@/modules/ops/api";
import { useOps } from "@/modules/ops/provider";

// 运维中台是单密码登录（同旧版客户中台）
export function NavUser() {
  const { isMobile } = useSidebar();
  const { readonly } = useOps();
  const logout = async () => {
    await post("/logout").catch(() => {});
    window.location.href = "/auth/login";
  };
  const who = (
    <>
      <span className="bg-primary text-primary-foreground flex size-8 items-center justify-center rounded-lg text-sm font-medium">
        管
      </span>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">管理员</span>
        <span className="text-muted-foreground truncate text-xs">{readonly ? "只读模式" : "juhecode.cn"}</span>
      </div>
    </>
  );
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {who}
              <EllipsisVertical className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">{who}</div>
            </DropdownMenuLabel>
            {readonly ? (
              <DropdownMenuItem disabled className="text-xs">
                <ShieldCheck />
                不会写入线上 sub2api
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout}>
              <LogOut />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
