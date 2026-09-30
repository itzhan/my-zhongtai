"use client";

import { use } from "react";

import Link from "next/link";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { get } from "@/modules/ops/api";
import { AccountForm, type AccountFull } from "@/modules/ops/components/account-form";
import { PageHeader } from "@/modules/ops/components/shared";
import { qk } from "@/modules/ops/hooks";

export default function EditAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number(use(params).id);
  const { data, error } = useQuery({
    queryKey: qk.accountFull(id),
    queryFn: () => get<{ account: AccountFull }>(`/accounts/${id}/full`),
  });
  if (error) return <p className="text-destructive">{error.message}</p>;
  if (!data) return <Skeleton className="h-96" />;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        back={
          <Link
            prefetch={false}
            href={`/dashboard/accounts/${id}`}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
          >
            <ArrowLeft className="size-4" />
            {data.account.name}
          </Link>
        }
        title="编辑账号"
      />
      <AccountForm account={data.account} />
    </div>
  );
}
