#!/bin/sh
# 在服务器上执行：拉最新代码，只重建有改动的容器（data 与 server/.env 不受影响）。
# 只改前端时不重启后端，避免智能调度重启（重启后约 5 分钟内模型路由会被清空）。
set -e
cd "$(dirname "$0")"
old=$(git rev-parse HEAD)
git pull --ff-only
changed=$(git diff --name-only "$old" HEAD)
svc=""
echo "$changed" | grep -q '^server/' && svc="$svc ops-server"
echo "$changed" | grep -q '^web/' && svc="$svc ops-web"
echo "$changed" | grep -q '^docker-compose.yml' && svc="ops-server ops-web"
[ "$1" = "--all" ] && svc="ops-server ops-web"
if [ -z "$svc" ]; then
  echo "代码无需重建的改动（重建全部：./deploy.sh --all）"
  exit 0
fi
echo "重建：$svc"
docker compose up -d --build --no-deps $svc
docker image prune -f >/dev/null
docker compose ps
