# 部署指南（KV 版，无需 R2）

目标：一个自有域名下同时提供前台、管理后台、订阅与 EPG。
重计算交给 GitHub Actions，状态与产物放在 **D1 + Workers KV**，不需要 R2，也不需要任何 S3 凭据。

> 如果你之前按 R2 版部署过：删掉 `wrangler.jsonc` 里的 `r2_buckets`，重新部署即可；
> 历史产物不用迁移，跑一次采集会自动写入 KV。

## 0. 准备

- Node.js ≥ 22，npm ≥ 10
- Cloudflare 账号（免费计划即可）
- 一个 GitHub 仓库（Actions 用于每日采集）

```bash
git clone <your-repo> iptv-studio
cd iptv-studio
npm install
```

## 1. 创建 Cloudflare 资源

```bash
cd packages/worker
npx wrangler login

npx wrangler d1 create iptv-studio
npx wrangler kv namespace create KV
```

把输出填进 `packages/worker/wrangler.jsonc`：

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "iptv-studio", "database_id": "<D1_ID>", "migrations_dir": "migrations" }
],
"kv_namespaces": [
  { "binding": "KV", "id": "<KV_ID>" }
]
```

同一个 KV 命名空间承担两类 key：

- `out/*`、`state/*`、`snapshots/*`、`logs/*`、`shots/*`：产物
- `login:*`、`fb:*`：登录/反馈限流

不需要创建 R2 bucket，也不需要 R2 API Token。

> `apps/web/dist` 必须存在才能部署（Worker 用它托管前端）。先在根目录执行一次 `npm run build`，或直接 `npm run deploy`。

## 2. 配置密钥

```bash
npx wrangler secret put ADMIN_TOKEN        # 管理令牌，登录后台用
npx wrangler secret put SESSION_SECRET     # 会话签名密钥，随机 32+ 字符
```

可选（后台「立即采集」按钮需要）：

```bash
npx wrangler secret put GITHUB_TOKEN       # fine-grained PAT: Actions: write
```

在 `wrangler.jsonc` 的 `vars` 里补：

```jsonc
"PUBLIC_BASE_URL": "https://iptv.example.com",
"GITHUB_REPO": "your-name/iptv-studio",
"GITHUB_WORKFLOW": "collect.yml",
"GITHUB_REF": "main"
```

`PUBLIC_BASE_URL` 会写进 M3U 头部的 EPG 地址，必须是播放器可访问的公网地址。

## 3. 初始化数据库

```bash
npm run db:migrate -w @iptv/worker
```

执行 `migrations/0001_init.sql`（表结构）与 `0002_seed.sql`（两条示例源 + 默认设置）。

## 4. 构建并部署

```bash
cd ../..
npm run deploy
```

等价于：

```bash
npm run build
cd packages/worker && npx wrangler deploy
```

部署后访问 `https://<worker>.workers.dev`。建议在 Cloudflare 控制台
**Workers → 你的 Worker → Settings → Domains & Routes** 绑定自定义域名，例如 `iptv.example.com`。

## 5. 配置 GitHub Actions

采集器不再直连对象存储，而是通过 `PUT /api/admin/artifacts/*` 把产物上传给 Worker，
所以只需要 API 地址与管理令牌。

仓库 **Settings → Secrets and variables → Actions**：

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| Secret | `API_BASE_URL` | Worker 公网地址，例如 `https://iptv.example.com` |
| Secret | `ADMIN_TOKEN` | 与 Worker 的 `ADMIN_TOKEN` 相同 |
| Secret | `TELEGRAM_BOT_TOKEN` | 可选，日报 |
| Secret | `TELEGRAM_CHAT_ID` | 可选 |
| Variable | `PUBLIC_BASE_URL` | 同 API_BASE_URL |
| Variable | `PROBE_BUDGET` | 每日测速条数，建议 6000 |
| Variable | `PROBE_CONCURRENCY` | 建议 48–64 |
| Variable | `SHOT_LIMIT` | 截图上限，默认 60；关闭截图请在后台上关掉开关 |

部署 Worker 的 workflow 需要：

| Secret | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 权限：Workers Scripts:Edit、D1:Edit、KV:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID |

## 6. 第一次运行

1. 打开后台 → 概览 → 「立即采集」（或 GitHub Actions 手动运行 `collect`）。
2. 等待 5–20 分钟（取决于源数量与测速预算）。
3. 回到概览，应看到频道与可用线路数量；前台 `/channels` 出现频道。
4. 后台 → 订阅与导出 → 新建订阅，复制 M3U 地址到播放器。

采集器会依次写入 `out/catalog.json`、`state/index.json`、64 个分桶、EPG、快照与日志，
并预渲染所有订阅；整个流程约 70–100 次 KV 写，远低于免费额度。

## 7. 可选：Cloudflare Access

**Zero Trust → Access → Applications → Add an application (Self-hosted)**

- 域名：`iptv.example.com/admin*`
- Policy：Allow，Include Emails = 你的邮箱
- 登录方式：One-time PIN

访问后台先过邮箱 OTP，再输入 ADMIN_TOKEN。

## 8. 本地开发

```bash
npm run db:migrate:local
cp packages/worker/.dev.vars.example packages/worker/.dev.vars
npm run build
npm run dev
```

- Worker：<http://127.0.0.1:8787>（D1/KV 均为本地模拟）
- 前端：<http://127.0.0.1:5173>（Vite 代理 `/api`、`/sub`、`/epg` 到 Worker）

本地跑采集器需要指向一个已部署的 Worker（本地 `wrangler dev` 也行，保持运行）：

```bash
cp .env.example .env
node --env-file=.env node_modules/.bin/tsx packages/runner/src/cli.ts collect
```

## 9. 额度与限制

| 资源 | 免费额度 | 本项目典型消耗 |
| --- | --- | --- |
| Workers | 10 万请求/天 | 订阅轮询 + 页面，个人使用 < 1 万 |
| KV 读 | 10 万次/天 | 每次页面/订阅 1–3 次 |
| KV 写 | **1000 次/天** | 每轮采集约 70–100 次 |
| KV 存储 | 1 GB | 目录 + 分桶 + EPG + 7 天快照，约 100–200 MB |
| D1 | 5GB、500 万行读/天 | 配置 + 运行记录 |
| Actions | 公开仓库免费；私有 2000 分钟/月 | 每次 10–25 分钟 |

关键限制：

- **单个 KV value 上限 25 MiB**。采集器对 `state/lines.json` 与 `out/epg.xml` 做了 24MB 保护：
  超过时自动裁剪失效墓碑 / 跳过 EPG 发布并在日志里告警。频道特别多时可缩短 EPG 天数。
- **KV 最终一致**（通常 < 60 秒）。刚发布的订阅可能短暂读到旧版本，这是可接受的。
- 免费版 Workers 单请求 CPU 10ms，因此订阅预渲染为静态 KV 对象，频道详情读分桶而不是整份目录。
- 带宽：`PROBE_BUDGET=6000`、每条最多 2.5MB，单日上限约 15GB 出站，Actions 不计费。

## 10. 排错

| 现象 | 排查 |
| --- | --- |
| 订阅 409「尚未生成频道数据」 | 还没跑过采集，或 `out/catalog.json` 未写入；看后台运行日志 |
| 订阅 404 | 订阅 token 错误或已停用；在后台重新复制链接 |
| 页面显示旧数据 | KV 最终一致；等 1 分钟或刷新两次 |
| Actions 报 413 | 单个产物超过 24MB；检查 EPG 天数/频道数 |
| Actions 报 401 | `ADMIN_TOKEN` 不一致 |
| 「立即采集」失败 | 未配 `GITHUB_TOKEN`/`GITHUB_REPO`，或 token 缺少 Actions 权限 |
| EPG 为空 | 设置里没配 XMLTV 地址；或频道 id 无法匹配（补别名） |
| 页面 404 | 前端未构建就部署；`npm run build` 后重新 deploy |
| KV 写超限 | 一天内重复手动采集太多次；免费额度 1000 写/天 |

## 11. 回滚

- Worker：`wrangler rollback`（控制台 Deployments 也可）
- 产物：`snapshots/<日期>/catalog.json` 保留 7 天；可手动 `PUT` 回 `out/catalog.json`
- 数据库：D1 Time Travel（控制台 → D1 → Backups）可恢复到任意时间点
