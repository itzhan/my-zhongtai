# 运维中台 · 前端

Next.js 16 + shadcn/ui，外壳基于 [shadmin](https://github.com/Afee2019/shadmin)（Apache-2.0，见 LICENSE）。
接口经 `next.config.mjs` 的 rewrites 同源代理到后端：`/ops/api/*` → `${OPS_API_URL}/api/*`。

```bash
pnpm install
OPS_API_URL=http://127.0.0.1:3400 pnpm dev -p 3002
pnpm build   # standalone；OPS_API_URL 需在构建时设置
```

整体说明见仓库根目录 README。
