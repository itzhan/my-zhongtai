"use client";

import { Suspense, use, useState } from "react";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ArrowLeft, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CustomerDialog } from "@/modules/ops/components/customer-dialog";
import { ChannelsTab, ErrorsTab, GroupsTab, OverviewTab, UsageTab } from "@/modules/ops/components/customer-tabs";
import { Embedded, PageHeader } from "@/modules/ops/components/shared";
import { useCustomerOverview, useInvalidate } from "@/modules/ops/hooks";
import { BillingView } from "@/modules/ops/views/billing-view";
import { useTabTitle } from "@/stores/tabs/tab-store-provider";

const TABS: [string, string][] = [
  ["overview", "概览"],
  ["channels", "接入渠道"],
  ["groups", "分组"],
  ["usage", "使用日志"],
  ["errors", "报错日志"],
  ["billing", "账单"],
];

function CustomerInner({ id }: { id: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const tab = useSearchParams().get("tab") || "overview";
  const { data: ov, error } = useCustomerOverview(id);
  const invalidate = useInvalidate();
  const [editOpen, setEditOpen] = useState(false);
  useTabTitle(ov?.customer.name);

  const back = (
    <Link
      prefetch={false}
      href="/dashboard/customers"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
    >
      <ArrowLeft className="size-4" />
      客户
    </Link>
  );
  if (error) return <div className="text-destructive">{error.message}</div>;
  if (!ov) return <Skeleton className="h-96" />;
  const c = ov.customer;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={back}
        title={c.name}
        description={c.contact || undefined}
        actions={
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil />
            编辑客户
          </Button>
        }
      />
      {!c.user_ids.length ? (
        <Card>
          <CardContent className="space-y-3 py-10 text-center">
            <p className="text-muted-foreground">这个客户还没有关联 sub2api 用户。</p>
            <Button onClick={() => setEditOpen(true)}>去关联用户</Button>
          </CardContent>
        </Card>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(v) => router.replace(`${pathname}?tab=${v}`, { scroll: false })}
          className="gap-4"
        >
          <TabsList>
            {TABS.map(([k, l]) => (
              <TabsTrigger key={k} value={k}>
                {l}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="overview">
            <OverviewTab ov={ov} />
          </TabsContent>
          <TabsContent value="channels">{tab === "channels" ? <ChannelsTab id={id} /> : null}</TabsContent>
          <TabsContent value="groups">{tab === "groups" ? <GroupsTab ov={ov} id={id} /> : null}</TabsContent>
          <TabsContent value="usage">{tab === "usage" ? <UsageTab ov={ov} id={id} /> : null}</TabsContent>
          <TabsContent value="errors">{tab === "errors" ? <ErrorsTab ov={ov} id={id} /> : null}</TabsContent>
          <TabsContent value="billing">
            {tab === "billing" ? (
              <Embedded>
                <BillingView presetUsers={ov.users.map((u) => ({ id: u.id, email: u.email }))} />
              </Embedded>
            ) : null}
          </TabsContent>
        </Tabs>
      )}
      <CustomerDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        customer={{ ...c, users: ov.users.map((u) => ({ id: u.id, email: u.email })) }}
        onSaved={() => invalidate("overview", "customers", "channels")}
      />
    </div>
  );
}

export default function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <CustomerInner id={id} />
    </Suspense>
  );
}
