"use client";

import { useEffect, useState } from "react";

import { ArrowDown, ArrowUp, Edit3, Eye, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { del, post, put } from "../api";
import { Tag } from "../components/badges";
import { ResponsiveDialog, useConfirm } from "../components/shared";
import { readErr, time } from "../format";
import { useInvalidate, useVerifyChannels } from "../hooks";
import type { VerifyChannel, VerifyProbe, VerifyProtocol } from "../types";

const PROTOCOL_OPTS: [VerifyProtocol, string][] = [
  ["gemini_native", "Gemini 原生 (:generateContent)"],
  ["anthropic_messages", "Anthropic Messages (/v1/messages)"],
  ["openai_chat", "OpenAI Chat (/v1/chat/completions)"],
  ["openai_responses", "OpenAI Responses (/v1/responses)"],
];

function emptyProbe(): VerifyProbe {
  return {
    id: `probe_${Date.now().toString(36)}`,
    name: "",
    kind: "fingerprint",
    rounds: 1,
    enabled: true,
    request_desc: "",
    expect_desc: "",
    request_body: { contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: {} },
    fallback_on_200: null,
    expect_status: [400],
    match_mode: "all",
    must_match: [],
    strong_match: [],
    counter_match: [],
    pass_200_hint: "",
  };
}

function NewChannelDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (code: string) => void;
}) {
  const invalidate = useInvalidate();
  const [f, setF] = useState({
    code: "",
    name: "",
    protocol: "gemini_native" as VerifyProtocol,
    platform_hint: "",
    pass_ratio: "0.8",
    summary: "",
  });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await post<VerifyChannel>("/verify/channels", {
        code: f.code.trim(),
        name: f.name.trim(),
        protocol: f.protocol,
        platform_hint: f.platform_hint.trim(),
        pass_ratio: Number(f.pass_ratio) || 0.8,
        summary: f.summary.trim(),
        methodology_md: `### ${f.name.trim()} 检测方法论\n\n请补充特征探针与判定依据。`,
        probes: [],
      });
      toast.success(`已新增渠道「${r.name}」`);
      invalidate("verify-channels");
      setF({ code: "", name: "", protocol: "gemini_native", platform_hint: "", pass_ratio: "0.8", summary: "" });
      onOpenChange(false);
      onCreated(r.code);
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title="新增渠道类型"
      description="创建新的上游渠道检测模板，随后可配置对应的方法论与探针规则。"
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>渠道编码 *</Label>
            <Input
              placeholder="如 vertex_claude"
              value={f.code}
              onChange={(e) => setF({ ...f, code: e.target.value })}
            />
            <p className="text-muted-foreground text-[11px]">2-40 位小写字母/数字/下划线</p>
          </div>
          <div className="space-y-1.5">
            <Label>显示名称 *</Label>
            <Input
              placeholder="如 vertex claude"
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>请求协议</Label>
            <Select value={f.protocol} onValueChange={(v) => setF({ ...f, protocol: v as VerifyProtocol })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROTOCOL_OPTS.map(([k, l]) => (
                  <SelectItem key={k} value={k}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>判定通过比例 (0.1 ~ 1)</Label>
            <Input
              type="number"
              step="0.05"
              min={0.1}
              max={1}
              value={f.pass_ratio}
              onChange={(e) => setF({ ...f, pass_ratio: e.target.value })}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>简述</Label>
          <Input
            placeholder="一句话描述该渠道的检测思路"
            value={f.summary}
            onChange={(e) => setF({ ...f, summary: e.target.value })}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy || !f.code.trim() || !f.name.trim()} onClick={submit}>
            创建
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

function ProbeEditorDialog({
  probe,
  open,
  onOpenChange,
  onSave,
}: {
  probe: VerifyProbe | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSave: (p: VerifyProbe) => void;
}) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [kind, setKind] = useState<"baseline" | "fingerprint">("fingerprint");
  const [roundsText, setRoundsText] = useState("1");
  const [enabled, setEnabled] = useState(true);
  const [requestDesc, setRequestDesc] = useState("");
  const [expectDesc, setExpectDesc] = useState("");
  const [expectStatusText, setExpectStatusText] = useState("400");
  const [matchMode, setMatchMode] = useState<"all" | "any">("all");
  const [mustMatchText, setMustMatchText] = useState("");
  const [strongMatchText, setStrongMatchText] = useState("");
  const [counterMatchText, setCounterMatchText] = useState("");
  const [pass200Hint, setPass200Hint] = useState("");
  const [requestBodyText, setRequestBodyText] = useState("{}");
  const [fallbackText, setFallbackText] = useState("");

  useEffect(() => {
    if (!open || !probe) return;
    setName(probe.name);
    setId(probe.id);
    setKind(probe.kind);
    setRoundsText(String(probe.rounds ?? 1));
    setEnabled(probe.enabled);
    setRequestDesc(probe.request_desc);
    setExpectDesc(probe.expect_desc);
    setExpectStatusText(probe.expect_status.join(", "));
    setMatchMode(probe.match_mode);
    setMustMatchText(probe.must_match.join("\n"));
    setStrongMatchText(probe.strong_match.join("\n"));
    setCounterMatchText(probe.counter_match.join("\n"));
    setPass200Hint(probe.pass_200_hint);
    setRequestBodyText(JSON.stringify(probe.request_body, null, 2));
    setFallbackText(probe.fallback_on_200 ? JSON.stringify(probe.fallback_on_200, null, 2) : "");
  }, [open, probe]);

  const splitLines = (t: string) =>
    t
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

  const handleConfirm = () => {
    if (!name.trim()) return toast.error("探针名称不能为空");
    let bodyObj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(requestBodyText || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return toast.error("请求体必须是 JSON 对象");
      }
      bodyObj = parsed as Record<string, unknown>;
    } catch (e) {
      return toast.error(`请求体 JSON 格式错误：${readErr(e)}`);
    }

    let fallbackObj: Record<string, unknown> | null = null;
    if (fallbackText.trim()) {
      try {
        const parsed = JSON.parse(fallbackText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return toast.error("200 补发请求体必须是 JSON 对象");
        }
        fallbackObj = parsed as Record<string, unknown>;
      } catch (e) {
        return toast.error(`200 补发请求体 JSON 格式错误：${readErr(e)}`);
      }
    }

    const statuses = expectStatusText
      .split(/[,\s，]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 100 && n < 600);

    onSave({
      id: id.trim() || `probe_${Date.now().toString(36)}`,
      name: name.trim(),
      kind,
      runner: probe?.runner,
      rounds: Math.min(5, Math.max(1, parseInt(roundsText, 10) || 1)),
      enabled,
      request_desc: requestDesc.trim(),
      expect_desc: expectDesc.trim(),
      request_body: bodyObj,
      fallback_on_200: fallbackObj,
      expect_status: statuses.length ? statuses : [kind === "baseline" ? 200 : 400],
      match_mode: matchMode,
      must_match: splitLines(mustMatchText),
      strong_match: splitLines(strongMatchText),
      counter_match: splitLines(counterMatchText),
      pass_200_hint: pass200Hint.trim(),
    });
    onOpenChange(false);
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={probe?.name ? `编辑探针 · ${probe.name}` : "新增探针"}
      description="修改完成后请点击外层的「保存方法论与探针」使规则生效。"
      className="sm:max-w-3xl"
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>探针名称 *</Label>
            <Input value={name} placeholder="如 temperature: 5" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>类型</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as "baseline" | "fingerprint")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fingerprint">指纹探针</SelectItem>
                <SelectItem value="baseline">基准连通性</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>重复轮数 (1~5)</Label>
            <Input type="number" min={1} max={5} value={roundsText} onChange={(e) => setRoundsText(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>探针 ID</Label>
            <Input className="font-mono text-xs" value={id} onChange={(e) => setId(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>期望 HTTP 状态码</Label>
            <Input
              className="font-mono text-xs"
              placeholder="400 或 400, 403"
              value={expectStatusText}
              onChange={(e) => setExpectStatusText(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>必中正则匹配模式</Label>
            <Select value={matchMode} onValueChange={(v) => setMatchMode(v as "all" | "any")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部命中 (AND)</SelectItem>
                <SelectItem value="any">命中其一 (OR)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>请求方式说明</Label>
          <Input
            value={requestDesc}
            placeholder="在界面上向操作员展示这个探针发了什么参数"
            onChange={(e) => setRequestDesc(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>目标特征说明</Label>
          <Input
            value={expectDesc}
            placeholder="符合真实渠道时应返回怎样的报错/特征"
            onChange={(e) => setExpectDesc(e.target.value)}
          />
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label>请求体 JSON *</Label>
            <Textarea
              className="min-h-36 font-mono text-xs"
              value={requestBodyText}
              onChange={(e) => setRequestBodyText(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>若首轮返回 200 时补发请求体 JSON（可选）</Label>
            <Textarea
              className="min-h-36 font-mono text-xs"
              placeholder="留空则不补发；如 logprobs 探针可在 200 时补发缺少开关的 logprobs 校验"
              value={fallbackText}
              onChange={(e) => setFallbackText(e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label>必中特征正则（每行一条）</Label>
            <Textarea
              className="min-h-28 font-mono text-xs"
              placeholder="正则规则，不区分大小写"
              value={mustMatchText}
              onChange={(e) => setMustMatchText(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>强特征正则（加分标签）</Label>
            <Textarea
              className="min-h-28 font-mono text-xs"
              value={strongMatchText}
              onChange={(e) => setStrongMatchText(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>反例特征正则（命中即假）</Label>
            <Textarea
              className="min-h-28 font-mono text-xs"
              placeholder="例如 AI Studio 特有文案"
              value={counterMatchText}
              onChange={(e) => setCounterMatchText(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>返回 HTTP 200 吞参数提示语</Label>
          <Input
            value={pass200Hint}
            placeholder="当期望触发 400/403 却返回 200 时展示的分析说明"
            onChange={(e) => setPass200Hint(e.target.value)}
          />
        </div>

        <div className="flex items-center justify-between pt-2">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            启用该探针
          </label>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button onClick={handleConfirm}>应用到列表</Button>
          </div>
        </div>
      </div>
    </ResponsiveDialog>
  );
}

export function VerifyMethodsView({ initialCode }: { initialCode?: string }) {
  const invalidate = useInvalidate();
  const [confirm, confirmEl] = useConfirm();
  const channelsQ = useVerifyChannels();
  const channels = channelsQ.data ?? [];

  const [selectedCode, setSelectedCode] = useState<string>(initialCode || "vertex_gemini");
  const [newOpen, setNewOpen] = useState(false);
  const [mdTab, setMdTab] = useState<"preview" | "edit">("preview");
  const [editingProbe, setEditingProbe] = useState<{ idx: number; probe: VerifyProbe } | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [draft, setDraft] = useState<{
    name: string;
    protocol: VerifyProtocol;
    pass_ratio: string;
    summary: string;
    methodology_md: string;
    probes: VerifyProbe[];
  } | null>(null);

  useEffect(() => {
    if (initialCode) setSelectedCode(initialCode);
  }, [initialCode]);

  const activeChannel = channels.find((c) => c.code === selectedCode) ?? channels[0] ?? null;

  useEffect(() => {
    if (!activeChannel) return;
    setDraft({
      name: activeChannel.name,
      protocol: activeChannel.protocol,
      pass_ratio: String(activeChannel.pass_ratio),
      summary: activeChannel.summary,
      methodology_md: activeChannel.methodology_md,
      probes: activeChannel.probes,
    });
    setDirty(false);
  }, [activeChannel]);

  const updateDraft = (patch: Partial<NonNullable<typeof draft>>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
  };

  const saveChannel = async () => {
    if (!activeChannel || !draft) return;
    setSaving(true);
    try {
      await put(`/verify/channels/${activeChannel.code}`, {
        name: draft.name,
        protocol: draft.protocol,
        pass_ratio: Number(draft.pass_ratio) || 0.8,
        summary: draft.summary,
        methodology_md: draft.methodology_md,
        probes: draft.probes,
      });
      toast.success(`已保存「${draft.name}」方法论`);
      setDirty(false);
      invalidate("verify-channels");
    } catch (e) {
      toast.error(readErr(e));
    } finally {
      setSaving(false);
    }
  };

  const resetBuiltin = async () => {
    if (!activeChannel) return;
    const ok = await confirm({
      title: `恢复「${activeChannel.name}」内置默认方法论？`,
      description: "将覆盖当前对该渠道所做的探针与方法论编辑，恢复到系统最新内置规则。",
      destructive: true,
      confirmText: "恢复默认",
    });
    if (!ok) return;
    try {
      await post(`/verify/channels/${activeChannel.code}/reset`);
      toast.success("已恢复内置默认方法论");
      invalidate("verify-channels");
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  const deleteCustom = async () => {
    if (!activeChannel) return;
    const ok = await confirm({
      title: `删除自定义渠道「${activeChannel.name}」？`,
      description: "删除后渠道列表将移除该模板，已有历史鉴定报告仍保留。",
      destructive: true,
      confirmText: "删除",
    });
    if (!ok) return;
    try {
      await del(`/verify/channels/${activeChannel.code}`);
      toast.success("已删除渠道类型");
      setSelectedCode("vertex_gemini");
      invalidate("verify-channels");
    } catch (e) {
      toast.error(readErr(e));
    }
  };

  const moveProbe = (idx: number, dir: -1 | 1) => {
    if (!draft) return;
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= draft.probes.length) return;
    const copy = [...draft.probes];
    const [item] = copy.splice(idx, 1);
    if (!item) return;
    copy.splice(nextIdx, 0, item);
    updateDraft({ probes: copy });
  };

  const toggleProbe = (idx: number, enabled: boolean) => {
    if (!draft) return;
    updateDraft({
      probes: draft.probes.map((p, i) => (i === idx ? { ...p, enabled } : p)),
    });
  };

  const removeProbe = (idx: number) => {
    if (!draft) return;
    updateDraft({ probes: draft.probes.filter((_, i) => i !== idx) });
  };

  if (channelsQ.isLoading) return <Skeleton className="h-96" />;

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      {/* 左侧渠道列表 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">渠道类型 ({channels.length})</span>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setNewOpen(true)}>
            <Plus className="size-3.5" />
            新增
          </Button>
        </div>
        <div className="space-y-1.5">
          {channels.map((c) => {
            const active = activeChannel?.code === c.code;
            return (
              <button
                key={c.code}
                type="button"
                onClick={() => setSelectedCode(c.code)}
                className={cn(
                  "hover:bg-accent/50 flex w-full flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  active && "border-primary bg-primary/5 ring-primary/20 ring-1",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{c.name}</span>
                  <Badge variant="outline" className="font-mono text-[10px] font-normal">
                    v{c.version}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground font-mono">{c.code}</span>
                  {c.ready ? (
                    <Tag tone="ok" className="text-[10px]">
                      {c.fingerprint_count} 探针
                    </Tag>
                  ) : (
                    <Tag tone="muted" className="text-[10px]">
                      待配置
                    </Tag>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右侧方法论编辑与探针列表 */}
      {activeChannel && draft ? (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {activeChannel.name}
                <Badge variant="outline" className="font-mono text-xs font-normal">
                  v{activeChannel.version}
                </Badge>
                {activeChannel.is_builtin ? (
                  activeChannel.customized ? (
                    <Tag tone="warn">内置 · 已自定义</Tag>
                  ) : (
                    <Tag tone="info">内置默认</Tag>
                  )
                ) : (
                  <Tag>自定义渠道</Tag>
                )}
                {dirty ? <Tag tone="warn">有未保存修改</Tag> : null}
              </CardTitle>
              <CardDescription>
                编码 <span className="font-mono">{activeChannel.code}</span> · 最近更新 {time(activeChannel.updated_at)}
              </CardDescription>
              <CardAction className="flex flex-wrap items-center gap-2">
                {activeChannel.is_builtin ? (
                  <Button size="sm" variant="outline" onClick={resetBuiltin}>
                    <RotateCcw className="size-3.5" />
                    恢复默认
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="text-destructive" onClick={deleteCustom}>
                    <Trash2 className="size-3.5" />
                    删除渠道
                  </Button>
                )}
                <Button size="sm" disabled={saving || !dirty} onClick={saveChannel}>
                  <Save className="size-3.5" />
                  {saving ? "保存中…" : "保存方法论与探针"}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>渠道名称</Label>
                  <Input value={draft.name} onChange={(e) => updateDraft({ name: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>默认检测协议</Label>
                  <Select value={draft.protocol} onValueChange={(v) => updateDraft({ protocol: v as VerifyProtocol })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROTOCOL_OPTS.map(([k, l]) => (
                        <SelectItem key={k} value={k}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>判定「真」命中比例阈值 (0.1 ~ 1)</Label>
                  <Input
                    type="number"
                    step="0.05"
                    min={0.1}
                    max={1}
                    value={draft.pass_ratio}
                    onChange={(e) => updateDraft({ pass_ratio: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>方法论简述</Label>
                <Input value={draft.summary} onChange={(e) => updateDraft({ summary: e.target.value })} />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>方法论说明文档 (Markdown)</Label>
                  <Tabs value={mdTab} onValueChange={(v) => setMdTab(v as "preview" | "edit")}>
                    <TabsList className="h-7">
                      <TabsTrigger value="preview" className="h-5 px-2 text-xs">
                        <Eye className="size-3" /> 预览
                      </TabsTrigger>
                      <TabsTrigger value="edit" className="h-5 px-2 text-xs">
                        <Edit3 className="size-3" /> 编辑
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
                {mdTab === "preview" ? (
                  <div className="[&_blockquote]:border-border [&_blockquote]:text-muted-foreground [&_code]:bg-muted space-y-2 rounded-lg border p-4 text-sm [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_h3]:text-sm [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
                    <Markdown remarkPlugins={[remarkGfm]}>{draft.methodology_md || "暂无说明"}</Markdown>
                  </div>
                ) : (
                  <Textarea
                    className="min-h-48 font-mono text-xs"
                    value={draft.methodology_md}
                    onChange={(e) => updateDraft({ methodology_md: e.target.value })}
                  />
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>检测探针序列 ({draft.probes.length})</CardTitle>
              <CardDescription>
                修改顺序、启停或调整探针规则后，点击上方「保存方法论与探针」即可热更新并递增版本号。
              </CardDescription>
              <CardAction>
                <Button size="sm" variant="outline" onClick={() => setEditingProbe({ idx: -1, probe: emptyProbe() })}>
                  <Plus className="size-3.5" />
                  新增探针
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {draft.probes.length ? (
                draft.probes.map((p, idx) => (
                  <div
                    key={p.id}
                    className={cn(
                      "flex flex-col gap-3 rounded-lg border p-3.5 sm:flex-row sm:items-center sm:justify-between",
                      !p.enabled && "opacity-60",
                    )}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-muted-foreground font-mono text-xs">#{idx + 1}</span>
                        <span className="font-medium">{p.name}</span>
                        <Badge variant="outline" className="text-[10px] font-normal">
                          {p.kind === "baseline" ? "基准连通性" : "指纹探针"}
                        </Badge>
                        <Tag tone="info" className="font-mono text-[10px]">
                          HTTP {p.expect_status.join("/")}
                        </Tag>
                        {(p.rounds ?? 1) > 1 ? (
                          <Badge variant="secondary" className="font-mono text-[10px] font-normal">
                            ×{p.rounds}轮
                          </Badge>
                        ) : null}
                        {p.runner ? (
                          <Badge variant="secondary" className="font-mono text-[10px] font-normal">
                            {p.runner}
                          </Badge>
                        ) : null}
                        {p.must_match.length ? (
                          <span className="text-muted-foreground text-[11px]">
                            {p.must_match.length} 条必中 · {p.counter_match.length} 条反例
                          </span>
                        ) : null}
                      </div>
                      <p className="text-muted-foreground text-xs">{p.request_desc || "-"}</p>
                      <p className="text-xs">
                        <span className="text-muted-foreground">判定特征：</span>
                        {p.expect_desc || "-"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Switch checked={p.enabled} onCheckedChange={(v) => toggleProbe(idx, v)} />
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={idx === 0}
                        onClick={() => moveProbe(idx, -1)}
                        title="上移"
                      >
                        <ArrowUp className="size-3.5" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={idx === draft.probes.length - 1}
                        onClick={() => moveProbe(idx, 1)}
                        title="下移"
                      >
                        <ArrowDown className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        onClick={() => setEditingProbe({ idx, probe: p })}
                      >
                        编辑
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => removeProbe(idx)}
                        title="删除探针"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-muted-foreground rounded-lg border border-dashed py-10 text-center text-sm">
                  当前渠道还没有探针，点击右上角「新增探针」即可开始定义该渠道的真伪检测方法论。
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      <NewChannelDialog open={newOpen} onOpenChange={setNewOpen} onCreated={(c) => setSelectedCode(c)} />
      <ProbeEditorDialog
        open={Boolean(editingProbe)}
        onOpenChange={(o) => !o && setEditingProbe(null)}
        probe={editingProbe?.probe ?? null}
        onSave={(saved) => {
          if (!draft || !editingProbe) return;
          if (editingProbe.idx >= 0) {
            updateDraft({
              probes: draft.probes.map((item, i) => (i === editingProbe.idx ? saved : item)),
            });
          } else {
            updateDraft({ probes: [...draft.probes, saved] });
          }
        }}
      />
      {confirmEl}
    </div>
  );
}
