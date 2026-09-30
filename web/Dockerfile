# 运维中台前端：Next.js standalone
FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile || pnpm install --frozen-lockfile --registry=https://registry.npmmirror.com

FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
# rewrites 在构建时确定：/ops/api/* → 后端
ARG OPS_API_URL=http://ops-server:3400
ENV OPS_API_URL=$OPS_API_URL NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Shanghai NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
