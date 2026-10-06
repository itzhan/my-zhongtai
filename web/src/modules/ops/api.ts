// 后端（ops-center/server）经 next.config.mjs 的 rewrites 同源代理在 /ops/api 下
export const OPS_API = "/ops/api";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${OPS_API}${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  let isJson = true;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应：出错时按空对象处理；成功状态码却不是 JSON（代理页面、响应被截断等）当失败，免得把 {} 当数据用
    isJson = false;
  }
  if (res.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/auth")) {
    window.location.href = `/auth/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  if (!res.ok) throw new ApiError(String(data.error || `请求失败 (${res.status})`), res.status);
  if (!isJson) throw new ApiError(`返回内容不是 JSON (${res.status})`, res.status);
  return data as T;
}

export const get = <T>(path: string) => api<T>("GET", path);
export const post = <T>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
export const put = <T>(path: string, body: unknown) => api<T>("PUT", path, body);
export const patch = <T>(path: string, body: unknown) => api<T>("PATCH", path, body);
export const del = <T>(path: string) => api<T>("DELETE", path);

// 查询串：去掉空值
export const qs = (o: Record<string, unknown>) =>
  new URLSearchParams(
    Object.entries(o)
      .filter(([, v]) => v !== "" && v !== null && v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  ).toString();
