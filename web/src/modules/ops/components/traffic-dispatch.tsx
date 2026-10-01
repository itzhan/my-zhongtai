"use client";

import { useEffect, useMemo, useState } from "react";

import { CheckCircle2, Loader2, PlayCircle, Power, Search, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { post, put } from "../api";
import { CLAUDE_MODELS, OPENAI_MODELS, readErr } from "../format";
import { useInvalidate } from "../hooks";
import type { TChannel, TGroup } from "../traffic";

import { Tag } from "./badges";
import { Pager, ResponsiveDialog, usePaged } from "./shared";

// 分组渠道设置（移植自 zhongtai 的「智能调度」面板）：列出分组下全部账号，一键检测，
// 把停用 / 未调度 / 出错且测试通过的启用并加入调度；不测也可以直接启用，失败的显示「仍要启用」。
type TestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok" } | { kind: "fail"; output: string };
type View = "all" | "problem" | "passed" | "failed";
const CONCURRENCY = 5;

const problems = (a: TChannel) => {
  const tags: string[] = [];
  if (a.status === "inactive") tags.push("已停用");
  else if (a.status === "error" || a.error_message?.trim()) tags.push("出错");
  else if (a.status !== "active") tags.push(`状态 ${a.status}`);
  if (!a.schedulable) tags.push("未调度");
  return tags;
};

function TestPill({ t }: { t: TestState }) {
  if (t.kind === "idle") return <Tag>未测试</Tag>;
  if (t.kind === "testing")
    return (
      <Tag tone="info">
        <Loader2 className="size-3 animate-spin" /> 测试中
      </Tag>
    );
  if (t.kind === "ok")
    return (
      <Tag tone="ok">
        <CheckCircle2 className="size-3" /> 通过
      </Tag>
    );
  return (
    <Tag tone="bad">
      <XCircle className="size-3" /> 失败
    </Tag>
  );
}

export function ChannelSettingsDialog({
  open,
  onOpenChange,
  siteId,
  group,
  accounts,
  model: savedModel,
  onSaveModel,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  siteId: number;
  group: TGroup;
  accounts: TChannel[];
  // 分组的测试模型（和卡片「测试设置」是同一个，存在后端）；这里改了也会存回去
  model: string;
  onSaveModel: (m: string) => void;
}) {
  const invalidate = useInvalidate();
  const [model, setModel] = useState(savedModel);
  // 每次打开都从已保存的模型开始
  useEffect(() => {
    if (open) setModel(savedModel);
  }, [open, savedModel]);
  const persistModel = () => {
    if (model.trim() !== savedModel) onSaveModel(model.trim());
  };
  const [tests, setTests] = useState<Record<number, TestState>>({});
  const [view, setView] = useState<View>("all");
  const [q, setQ] = useState("");
  const [running, setRunning] = useState(false);
  const [enabling, setEnabling] = useState<Set<number>>(new Set());

  // 有问题的排前面
  const list = useMemo(
    () =>
      [...accounts].sort(
        (a, b) => Number(problems(b).length > 0) - Number(problems(a).length > 0) || a.priority - b.priority,
      ),
    [accounts],
  );
  const state = (id: number): TestState => tests[id] ?? { kind: "idle" };
  const problemN = list.filter((a) => problems(a).length).length;
  const passedN = list.filter((a) => state(a.id).kind === "ok").length;
  const failedN = list.filter((a) => state(a.id).kind === "fail").length;
  const filtered = list.filter((a) => {
    if (q.trim() && !a.name.toLowerCase().includes(q.trim().toLowerCase())) return false;
    const k = state(a.id).kind;
    if (view === "problem") return problems(a).length > 0;
    if (view === "passed") return k === "ok";
    if (view === "failed") return k === "fail";
    return true;
  });
  const { rows, pager } = usePaged(filtered, `${view}|${q}`);

  const testOne = async (id: number): Promise<TestState> => {
    try {
      const m = model.trim();
      const r = await post<{ ok: boolean; output: string }>(
        `/traffic/${siteId}/channels/${id}/test`,
        m ? { model: m } : {},
      );
      return r.ok ? { kind: "ok" } : { kind: "fail", output: r.output.slice(0, 800) };
    } catch (e) {
      return { kind: "fail", output: readErr(e) };
    }
  };
  const testRow = async (a: TChannel) => {
    persistModel();
    setTests((t) => ({ ...t, [a.id]: { kind: "testing" } }));
    const r = await testOne(a.id);
    setTests((t) => ({ ...t, [a.id]: r }));
  };
  // 一键检测：5 个并发测完分组下全部账号
  const testAll = async () => {
    persistModel();
    setRunning(true);
    const queue = [...list];
    setTests(Object.fromEntries(queue.map((a) => [a.id, { kind: "testing" } as TestState])));
    const worker = async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        const id = a.id;
        const r = await testOne(id);
        setTests((t) => ({ ...t, [id]: r }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    setRunning(false);
    toast.success("检测完成");
  };

  // 启用：status → active；未调度的加入调度；有错误的清掉错误状态
  const enable = async (targets: TChannel[]) => {
    setEnabling((s) => new Set([...s, ...targets.map((a) => a.id)]));
    let ok = 0;
    for (const a of targets) {
      try {
        if (a.status !== "active") await put(`/traffic/${siteId}/channels/${a.id}`, { status: "active" });
        if (!a.schedulable) await post(`/traffic/${siteId}/channels/${a.id}/schedulable`, { schedulable: true });
        if (a.error_message?.trim())
          await post(`/traffic/${siteId}/channels/clear-error`, { account_ids: [a.id] }).catch(() => {});
        ok++;
      } catch (e) {
        toast.error(`启用失败：${a.name}`, { description: readErr(e) });
      }
    }
    setEnabling((s) => new Set([...s].filter((id) => !targets.some((a) => a.id === id))));
    if (ok) toast.success(targets.length === 1 ? `已启用 ${targets[0]!.name}` : `已启用 ${ok} 个渠道并加入调度`);
    invalidate("traffic");
  };
  const passedProblems = list.filter((a) => problems(a).length && state(a.id).kind === "ok");

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`渠道设置 · ${group.name}`}
      description={`分组下共 ${list.length} 个账号，其中 ${problemN} 个停用 / 未调度 / 出错。一键检测后把通过的启用并加入调度；不测也可以直接启用。`}
      className="sm:max-w-5xl"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">测试模型（按分组保存；留空用 sub2api 默认）</Label>
            <Input
              list="dispatch-models"
              className="w-56"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={persistModel}
            />
            <datalist id="dispatch-models">
              {[...CLAUDE_MODELS, ...OPENAI_MODELS].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
          <Button disabled={running || !list.length} onClick={testAll}>
            {running ? <Loader2 className="animate-spin" /> : <PlayCircle />}
            一键检测（{list.length}）
          </Button>
          {passedProblems.length && !running ? (
            <Button variant="outline" className="border-success/50 text-success" onClick={() => enable(passedProblems)}>
              <Power />
              启用全部通过的（{passedProblems.length}）
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              ["all", `全部 (${list.length})`],
              ["problem", `待处理 (${problemN})`],
              ["passed", `通过 (${passedN})`],
              ["failed", `失败 (${failedN})`],
            ] as const
          ).map(([v, l]) => (
            <Badge
              key={v}
              variant={view === v ? "default" : "secondary"}
              className="cursor-pointer"
              onClick={() => setView(v)}
            >
              {l}
            </Badge>
          ))}
          <div className="relative ml-auto w-full sm:w-56">
            <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input placeholder="搜索账号名" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-9" />
          </div>
        </div>
        {!filtered.length ? (
          <p className="text-muted-foreground py-8 text-center text-sm">当前筛选下没有账号</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {rows.map((a) => {
              const t = state(a.id);
              const tags = problems(a);
              return (
                <div key={a.id} className="space-y-1.5 rounded-md border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium" title={a.name}>
                        {a.name}{" "}
                        <span className="text-muted-foreground text-xs">
                          #{a.id} · P{a.priority}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {tags.length ? (
                          tags.map((p) => (
                            <Tag key={p} tone="warn">
                              {p}
                            </Tag>
                          ))
                        ) : (
                          <Tag tone="ok">调度中</Tag>
                        )}
                      </div>
                    </div>
                    <TestPill t={t} />
                  </div>
                  {a.error_message ? (
                    <div className="text-danger line-clamp-2 text-xs break-all">{a.error_message}</div>
                  ) : null}
                  {t.kind === "fail" ? (
                    <div className="text-muted-foreground line-clamp-3 text-xs break-all">{t.output}</div>
                  ) : null}
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={running || t.kind === "testing"}
                      onClick={() => testRow(a)}
                    >
                      {t.kind === "testing" ? <Loader2 className="animate-spin" /> : <PlayCircle />}
                      {t.kind === "ok" || t.kind === "fail" ? "重测" : "测试"}
                    </Button>
                    {tags.length ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={enabling.has(a.id)}
                        className={cn(
                          t.kind === "ok" && "border-success/50 text-success",
                          t.kind === "fail" && "border-warning/50 text-warning",
                        )}
                        onClick={() => enable([a])}
                      >
                        {enabling.has(a.id) ? <Loader2 className="animate-spin" /> : <Power />}
                        {t.kind === "fail" ? "仍要启用" : "启用"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <Pager {...pager} />
      </div>
    </ResponsiveDialog>
  );
}
