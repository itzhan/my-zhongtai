# 运维中台

在 sub2api（juhecode.cn）之上管理客户、分组、上游账号、智能调度、账单，并提供**延迟监控**与**供应商管理**。
由原「客户中台」（`../kehu-zhongtai`，纯 JS）迁移而来，界面换成 shadmin（Next.js + shadcn/ui），前后端完全独立。

```
ops-center/
├── server/   后端：Express，只提供 /api（客户中台后端 + 延迟监控 + 供应商模块）
│   ├── server.js      路由；只读保护（READONLY）
│   ├── scheduler.js   智能调度（熔断 / 探测 / 评分 / 路由）；只读模式下只观察
│   ├── detector.js    深度检测
│   ├── monitor.js     账号延迟监控条：按时间分桶统计真实流量，不发探测请求
│   ├── suppliers.js   供应商 + 可提供的货 + 供应商接口监测 + 线路质量的账号关联（node:sqlite，data/ops.db）
│   ├── traffic.js     流量监控：多台 sub2api 的实时 RPM/TPM/并发、渠道调度、分组使用、错误排行
│   └── scripts/import-zhongtai.mjs  从 zhongtai 一次性导入供应商数据
└── web/      前端：Next.js 16（shadmin 外壳），/ops/api 同源代理到后端
```

## 页面

| 侧栏 | 内容 |
|---|---|
| 监控大盘 | 账号概况、智能调度分组存活、按分组折叠的账号延迟监控条（有异常的分组排前并展开） |
| 流量监控 | 设置里配置要监控的 sub2api（URL + Admin Key）；当前 RPM / TPM / 用户实时并发；渠道调度（按分组看渠道并发、今日消费，可启停 / 清错 / 编辑 / 新增 / 测试）；分组使用；错误排行 |
| 客户 | 列表 → 详情：概览 / 接入渠道 / 分组 / 使用日志 / 报错日志 |
| 分组 | 列表 → 详情：调度配置、账号大表（含延迟条、熔断、评分、首字 P50/P90）、模型路由排名 |
| 账号 | 列表（含延迟条）→ 详情（大延迟条、统计、连接与调度、使用 / 报错）→ 新建 / 编辑 |
| 智能调度 | 总开关、已关联分组、报警、参数、决策日志 |
| 账单 | 选日期和用户 → 折扣 → 每日柱状图、按用户 / 按模型、导出 xlsx |
| 供应商管理 | 供应商卡片（联系方式点击复制、货物 + 倍率、线路质量）→ 详情（编辑货物、名下账号的线路质量、接口监测） |
| 接口监测 | 供应商 API 的延迟监控条（每次探测一格）、评级、手动探测 |

**延迟监控条**（同 zhongtai）：一排 24 个色块，绿 = 正常、黄 = 偏慢、红 = 异常、蓝 = 限流、灰 = 无数据，悬停看详情。
评级取最近 12 格：末尾连续 3 格异常或失败率 ≥ 50% 为「不可用」，失败率 ≤ 10% 且偏慢率 ≤ 25% 为「优秀」，其余「不稳定」。
- 账号：按真实流量每 5 / 15 / 60 分钟一格（2 / 6 / 24 小时），首字 P50 ≥ 5s 记偏慢；零成本。
- 供应商接口：每次主动探测（发一次极小的 ping 请求）一格，保留最近 48 次。

所有列表都分页，每页条数可选 10 / 20 / 50 / 100，默认 20。

**线路质量**：供应商名下 sub2api 账号在监控大盘里近 24 小时的延迟评级，取账号数最多的一档。账号名以供应商名开头（后面接 `-`、`_`、空格等分隔符）自动算作该供应商的账号，也可以在供应商详情里手动关联 / 移除。

**流量监控**的服务器 Admin Key 保存在 `data/ops.db`，只在后端使用，接口只返回打码后的值；改渠道、测试渠道同样受只读保护。

## 只读保护（重要）

后端默认 **READONLY=1**，只有显式设置 `READONLY=0` 才会真正改线上：

- 所有对 sub2api 的写请求（改账号 / 分组 / 用户 / Key、测试连接等）在发出前就被拦截，返回「只读模式：已拦截…」；
- 智能调度只观察（读指标、算评分），不熔断、不调优先级、不改路由，也不改本地 scheduler.json；
- 深度检测（会直接请求上游并产生费用）不运行，调度与检测设置不可修改；
- 供应商接口不自动定时探测（可手动探测，只请求供应商接口，与 sub2api 无关）。

客户列表（data/customers.json）和供应商（data/ops.db）是本系统自己的数据，只读模式下也可以增删改。
页面右上角会显示「只读模式」标识。

## 本地运行

后端需要连 sub2api 的 Postgres（只读角色 `zhongtai_ro`）和管理 API。它们在服务器 Docker 内网，本地用 SSH 隧道：

```bash
# 1. 隧道：本地 15433 → sub2api Postgres，本地 18082 → sub2api 管理 API
# <PG_CONTAINER_IP>：sub2api Postgres 容器在服务器 Docker 网络里的 IP（docker inspect 查看）
ssh -N -L 15433:<PG_CONTAINER_IP>:5432 -L 18082:127.0.0.1:8082 <user>@<server>

# 2. 后端（默认只读）
cd server && npm install
PORT=3400 DATA_DIR=./data PG_HOST=127.0.0.1 PG_PORT=15433 SUB2API_BASE=http://127.0.0.1:18082/api/v1 \
  node --env-file=.env server.js

# 3. 前端（限制内存；next.config 已关闭开发期磁盘缓存，避免拖垮机器）
cd web && pnpm install
NODE_OPTIONS=--max-old-space-size=2048 OPS_API_URL=http://127.0.0.1:3400 pnpm dev -p 3002
```

打开 http://localhost:3002 ，用 `.env` 里的 `APP_PASSWORD` 登录。

`server/.env` 需要：`APP_PASSWORD`、`SESSION_SECRET`、`SUB2API_BASE`、`SUB2API_ADMIN_KEY`、`PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DB`、`DATA_DIR`。

## 数据

- `server/data/` 下的 customers.json、scheduler.json、scheduler-audit.jsonl、detect-*.json 复制自线上客户中台（2026-09-30）；
- `server/data/ops.db` 的供应商、货物、接口监测与样本由 `npm run import:zhongtai -- ../../zhongtai/data/app.db` 从 zhongtai 导入（只读打开源库；目标库已有供应商时拒绝重复导入）。

## 部署（服务器通过 GitHub 更新）

仓库根目录的 `docker-compose.yml` 起两个容器：`ops-server`（后端，只在容器网络内，接入 sub2api 的 Docker 网络）和 `ops-web`（前端，对外 3190）。

首次部署：

```bash
git clone git@github.com:itzhan/my-zhongtai.git /opt/ops-center && cd /opt/ops-center
cp server/.env.example server/.env      # 填写密码 / 密钥 / 数据库，线上设 READONLY=0
mkdir -p data                           # 运行数据（不入库）；也可用 OPS_DATA_DIR 指到别处
docker compose up -d --build
```

之后每次更新：在服务器上执行 `./deploy.sh`（git pull + 重建容器，data 与 .env 不受影响）。

注意：
- 敏感信息只放在服务器的 `server/.env` 和 `data/` 里，仓库中只有 `.env.example`；
- 线上以 `READONLY=0` 运行时，智能调度会真实调整 sub2api，**同一时间只能有一套调度在跑**（切换前先停掉旧的客户中台）。
