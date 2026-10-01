"use client";

import { PageHeader } from "@/modules/ops/components/shared";
import { TrafficSettings } from "@/modules/ops/components/traffic-settings";
import { useOps } from "@/modules/ops/provider";
import { useTrafficSites } from "@/modules/ops/traffic";

export default function SettingsPage() {
  const { readonly } = useOps();
  const sites = useTrafficSites();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="设置"
        description={
          readonly
            ? "当前为只读模式：不会改动线上 sub2api，智能调度只观察"
            : "线上模式：改账号 / 渠道、智能调度都会真实作用到 sub2api"
        }
      />
      {sites.data ? <TrafficSettings sites={sites.data} /> : null}
    </div>
  );
}
