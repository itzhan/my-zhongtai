FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Shanghai
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com
COPY *.js ./
COPY scripts ./scripts
EXPOSE 3400
CMD ["node", "server.js"]
