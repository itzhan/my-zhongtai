// 格式化工具（口径同旧版客户中台 public/app.js）
export const money = (v: number | null | undefined) =>
  "$" +
  Number(v || 0)
    .toFixed(Number(v || 0) >= 100 ? 2 : 4)
    .replace(/\.?0+$/, (m) => (m.includes(".") ? "" : m));
export const moneyFull = (v: number | null | undefined) =>
  "$" + Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const num = (v: number | null | undefined) => Number(v || 0).toLocaleString("en-US");
export const bigNum = (v: number | string | null | undefined) => {
  const n = Number(v || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};
const p2 = (n: number) => String(n).padStart(2, "0");
export const time = (t: string | number | null | undefined) => {
  if (!t) return "-";
  const d = new Date(t);
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};
export const hm = (t: string | number) => {
  const d = new Date(t);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
export const ago = (t: string | number | null | undefined) => {
  if (!t) return "-";
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 0) return time(t);
  if (s < 60) return Math.floor(s) + " 秒前";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
};
export const ms = (v: number | null | undefined) =>
  v == null ? "-" : v >= 1000 ? (v / 1000).toFixed(1) + "s" : v + "ms";
export const pct = (v: number | null | undefined) =>
  v == null ? "-" : (v * 100).toFixed(v < 0.1 && v > 0 ? 1 : 0) + "%";
export const discLabel = (d: number) => (d === 1 ? "无折扣" : `${+(d * 10).toFixed(2)} 折`);

export const RANGE_OPTS: [string, string][] = [
  ["1h", "近 1 小时"],
  ["today", "今天"],
  ["24h", "近 24 小时"],
  ["7d", "近 7 天"],
  ["30d", "近 30 天"],
];

export const CLAUDE_MODELS = [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
];
export const OPENAI_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
  "codex-auto-review",
  "gpt-image-2",
];

// 北京日期 YYYY-MM-DD
export const ymd = (d: Date) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10);

export const readErr = (e: unknown) => (e instanceof Error ? e.message : String(e));
