"use client";

import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { TableCell } from "@/components/ui/table";

import { put } from "../api";
import { readErr } from "../format";

import { useConfirm } from "./shared";

export type SchedGroupRow = {
  id: number;
  name: string;
  platform: string;
  status: string;
  member_count: number;
  member_available: number;
  enrolled_count: number;
  alive: number | null;
  min_alive: number;
  auto: boolean;
  routing: boolean;
  model_routing_enabled: boolean;
  routing_rules: number;
};

// 分组的「智能调度 / 自动路由」开关（两个单元格）
export function GroupSwitches({
  g,
  onChanged,
  asCells = true,
}: {
  g: Pick<SchedGroupRow, "id" | "auto" | "routing">;
  onChanged: () => void;
  asCells?: boolean;
}) {
  const [confirm, confirmEl] = useConfirm();
  const setAuto = async (on: boolean) => {
    try {
      await put(`/sched/groups/${g.id}`, { auto: on });
      toast.success(on ? "已开启该分组智能调度（只作用于已关联账号）" : "已关闭该分组智能调度");
      onChanged();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const setRouting = async (on: boolean) => {
    if (
      on &&
      !(await confirm({
        title: "开启自动路由？",
        description:
          "开启后引擎会改写这个分组在 sub2api 的「模型路由」：每个模型优先走表现最好的 2~3 个已关联账号，都不可用时自动回退到整组。关闭后会还原为开启前的路由配置。需要同时开启「智能调度」才会生效。",
        confirmText: "开启",
      }))
    )
      return;
    try {
      await put(`/sched/groups/${g.id}`, { routing: on });
      toast.success(on ? "已开启自动路由" : "已关闭自动路由并还原配置");
      onChanged();
    } catch (e) {
      toast.error(readErr(e));
    }
  };
  const auto = <Switch checked={g.auto} onCheckedChange={setAuto} />;
  const routing = <Switch checked={g.routing} onCheckedChange={setRouting} />;
  if (!asCells)
    return (
      <>
        <label className="flex items-center gap-2 text-sm">智能调度 {auto}</label>
        <label className="flex items-center gap-2 text-sm">自动路由 {routing}</label>
        {confirmEl}
      </>
    );
  return (
    <>
      <TableCell>{auto}</TableCell>
      <TableCell>
        {routing}
        {confirmEl}
      </TableCell>
    </>
  );
}
