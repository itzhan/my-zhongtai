#!/bin/sh
# 服务器上执行：从 GitHub 拉最新代码并重建容器（数据目录与 .env 不受影响）
set -e
cd "$(dirname "$0")"
git pull --ff-only
docker compose up -d --build
docker image prune -f >/dev/null
docker compose ps
