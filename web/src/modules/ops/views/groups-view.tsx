"use client";

import Link from "next/link";

import { useQuery } from "@tanstack/react-query";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { get } from "@/modules/ops/api";
import { PlatformBadge, Tag } from "@/modules/ops/components/badges";
import { GroupSwitches, type SchedGroupRow } from "@/modules/ops/components/group-switches";
import { PageHeader, Pager, usePaged } from "@/modules/ops/components/shared";
import { qk } from "@/modules/ops/hooks";

export function GroupsView() {
  const { data, refetch } = useQuery({
    queryKey: qk.schedOverview,
    queryFn: () => get<{ enabled: boolean; groups: SchedGroupRow[] }>("/sched/overview"),
  });
  const { rows, pager } = usePaged(data?.groups ?? []);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="分组"
        description="在分组里手动关联账号后，智能调度只监测和调整这些账号；没关联的完全不动"
        actions={
          data ? <Tag tone={data.enabled ? "ok" : "muted"}>智能调度总开关：{data.enabled ? "开" : "关"}</Tag> : null
        }
      />
      <Card className="py-0">
        <CardContent className="p-0">
          {!data ? (
            <Skeleton className="m-4 h-64" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">分组</TableHead>
                  <TableHead>平台</TableHead>
                  <TableHead className="text-right">组内账号</TableHead>
                  <TableHead className="text-right">组内可用</TableHead>
                  <TableHead className="text-right">已关联</TableHead>
                  <TableHead>关联存活 / 最少</TableHead>
                  <TableHead>智能调度</TableHead>
                  <TableHead>自动路由</TableHead>
                  <TableHead>sub2api 模型路由</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="pl-4">
                      <Link prefetch={false} href={`/dashboard/groups/${g.id}`} className="font-medium hover:underline">
                        {g.name}
                      </Link>{" "}
                      <span className="text-muted-foreground text-xs">#{g.id}</span>{" "}
                      {g.status !== "active" ? <Tag>停用</Tag> : null}
                    </TableCell>
                    <TableCell>
                      <PlatformBadge platform={g.platform} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{g.member_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.member_available}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {g.enrolled_count || <span className="text-muted-foreground">0</span>}
                    </TableCell>
                    <TableCell>
                      {g.alive == null ? (
                        <span className="text-muted-foreground text-sm">未关联</span>
                      ) : (
                        <Tag tone={g.alive >= g.min_alive ? "ok" : g.alive === 0 ? "bad" : "warn"}>
                          {g.alive} / {g.min_alive}
                        </Tag>
                      )}
                    </TableCell>
                    <GroupSwitches g={g} onChanged={() => refetch()} />
                    <TableCell>
                      {g.model_routing_enabled ? (
                        <Tag tone="info">开 · {g.routing_rules} 条</Tag>
                      ) : (
                        <span className="text-muted-foreground text-sm">关</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link
                        prefetch={false}
                        href={`/dashboard/groups/${g.id}`}
                        className="text-primary text-sm hover:underline"
                      >
                        管理账号
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <Pager {...pager} className="border-t px-4 py-3" />
        </CardContent>
      </Card>
    </div>
  );
}
