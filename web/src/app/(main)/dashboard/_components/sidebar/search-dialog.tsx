"use client";
import * as React from "react";

import { useRouter } from "next/navigation";

import { Layers, Search, Server, Truck, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useAccounts, useCustomers, useSuppliers } from "@/modules/ops/hooks";
import { useOps } from "@/modules/ops/provider";
import { sidebarItems } from "@/navigation/sidebar/sidebar-items";

// ⌘J：跳转页面 / 客户 / 分组 / 账号 / 供应商（打开时才加载列表）
export function SearchDialog() {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "j" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const go = (url: string) => {
    setOpen(false);
    router.push(url);
  };

  return (
    <>
      <Button
        variant="link"
        className="text-muted-foreground !px-0 font-normal hover:no-underline"
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" />
        搜索
        <kbd className="bg-muted inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[10px] font-medium select-none">
          <span className="text-xs">⌘</span>J
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="搜索页面、客户、账号、供应商…" />
        <CommandList>
          <CommandEmpty>未找到结果</CommandEmpty>
          <CommandGroup heading="页面">
            {sidebarItems.flatMap((g) =>
              g.items.map((item) => (
                <CommandItem className="!py-1.5" key={item.url} onSelect={() => go(item.url)}>
                  {item.icon && <item.icon />}
                  <span>{item.title}</span>
                </CommandItem>
              )),
            )}
          </CommandGroup>
          {open ? <SearchData go={go} /> : null}
        </CommandList>
      </CommandDialog>
    </>
  );
}

function SearchData({ go }: { go: (url: string) => void }) {
  const { groups } = useOps();
  const customers = useCustomers();
  const accounts = useAccounts();
  const suppliers = useSuppliers("", "");
  return (
    <>
      <CommandSeparator />
      <CommandGroup heading="客户">
        {customers.data?.map((c) => (
          <CommandItem
            className="!py-1.5"
            key={c.id}
            value={`客户 ${c.name} ${c.users.map((u) => u.email).join(" ")}`}
            onSelect={() => go(`/dashboard/customers/${c.id}`)}
          >
            <Users />
            <span>{c.name}</span>
          </CommandItem>
        ))}
      </CommandGroup>
      <CommandGroup heading="分组">
        {groups.map((g) => (
          <CommandItem
            className="!py-1.5"
            key={g.id}
            value={`分组 ${g.name} ${g.id}`}
            onSelect={() => go(`/dashboard/groups/${g.id}`)}
          >
            <Layers />
            <span>{g.name}</span>
          </CommandItem>
        ))}
      </CommandGroup>
      <CommandGroup heading="账号">
        {accounts.data?.map((a) => (
          <CommandItem
            className="!py-1.5"
            key={a.id}
            value={`账号 ${a.name} ${a.id}`}
            onSelect={() => go(`/dashboard/accounts/${a.id}`)}
          >
            <Server />
            <span>{a.name}</span>
            <span className="text-muted-foreground ml-auto text-xs">#{a.id}</span>
          </CommandItem>
        ))}
      </CommandGroup>
      <CommandGroup heading="供应商">
        {suppliers.data?.map((s) => (
          <CommandItem
            className="!py-1.5"
            key={s.id}
            value={`供应商 ${s.name} ${s.goods.map((g) => g.name).join(" ")}`}
            onSelect={() => go(`/dashboard/suppliers/${s.id}`)}
          >
            <Truck />
            <span>{s.name}</span>
          </CommandItem>
        ))}
      </CommandGroup>
    </>
  );
}
