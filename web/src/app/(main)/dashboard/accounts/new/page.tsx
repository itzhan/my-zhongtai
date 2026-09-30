"use client";

import { Suspense } from "react";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { ArrowLeft } from "lucide-react";

import { AccountForm } from "@/modules/ops/components/account-form";
import { Tag } from "@/modules/ops/components/badges";
import { PageHeader } from "@/modules/ops/components/shared";
import { useOps } from "@/modules/ops/provider";

function NewAccount() {
  const group = Number(useSearchParams().get("group")) || null;
  const { groups } = useOps();
  const pg = groups.find((g) => g.id === group);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={
          <Link
            prefetch={false}
            href={pg ? `/dashboard/groups/${pg.id}` : "/dashboard/accounts"}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="size-4" />
            {pg ? pg.name : "账号"}
          </Link>
        }
        title={<>新建供应商账号 {pg ? <Tag tone="info">加入分组：{pg.name}</Tag> : null}</>}
      />
      <AccountForm account={null} presetGroup={group} />
    </div>
  );
}

export default function NewAccountPage() {
  return (
    <Suspense>
      <NewAccount />
    </Suspense>
  );
}
