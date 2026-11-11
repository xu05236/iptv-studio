# 管理令牌（ADMIN_TOKEN）轮换手册 / Admin Token Rotation Guide

本页说明如何更换 `ADMIN_TOKEN`。它不是 GitHub 令牌，而是本系统自己的管理密码：后台登录、采集程序回调管理接口（请求头 `x-admin-token`）都用它。

This page explains how to rotate `ADMIN_TOKEN`. It is **not** a GitHub token; it is this system's own admin password, used by the admin UI and by the collector when it calls the admin API (`x-admin-token` header).

令牌共存在三处，轮换时要同步：

1. Cloudflare Worker 的密钥（生产接口认这个）
2. GitHub 仓库的 Actions Secret（采集工作流用这个）
3. 本机文件（本地开发/排查用）

The token lives in three places; rotate all of them:

1. Cloudflare Worker secret (what production checks)
2. GitHub Actions repository secret (what the collector uses)
3. Local files (development/troubleshooting)

---

## 中文版

### 1. 生成新令牌

在 PowerShell 里执行：

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
```

得到 48 位字母数字。不要用可猜的短语、日期或旧令牌的变形。

### 2. 更新 Worker 密钥（生产）

界面路径：

1. 打开 Cloudflare Dashboard。
2. 左侧进入 **Workers & Pages**。
3. 选择 Worker：`iptv-studio`。
4. 顶部选 **Settings**（设置）。
5. 找到 **Variables and Secrets**（变量与密钥）。
6. 在列表里找到 `ADMIN_TOKEN`（类型为 Secret / 加密），点 **Edit**（编辑）。
7. 粘贴新值，点 **Save and deploy**（保存并部署）。

命令行替代（本机需要有 Workers Scripts 编辑权限的 Cloudflare 令牌）：

```powershell
cd packages/worker
npx wrangler secret put ADMIN_TOKEN
```

按提示粘贴新值，回车。

> 这一步完成后，线上接口立即只认新令牌；旧令牌调用会返回 401。

### 3. 更新 GitHub Actions Secret（采集用）

界面路径：

1. 打开仓库 `github.com/xu05236/iptv-studio`。
2. 顶部 **Settings**（设置）。
3. 左侧 **Secrets and variables** → **Actions**。
4. 在 Repository secrets 里找到 `ADMIN_TOKEN`，点 **Update**（更新）。
5. 粘贴同一个新值，点 **Save**（保存）。

> 只影响之后新触发的任务；正在运行的那一次仍用旧值。

### 4. 更新本机文件

- `packages/worker/.deploy-secrets.txt`：把 `ADMIN_TOKEN=` 后面改成新值。
- `packages/worker/.dev.vars`：本地开发用的同一个键。

这两个文件都被 `.gitignore` 忽略，**不要提交**。如果平时用 `E2E_ADMIN_TOKEN` 环境变量跑前端冒烟，重新导出新值。

### 5. 验证

```powershell
$env:ADMIN_TOKEN = '新令牌'
curl.exe -s -o NUL -w "%{http_code}`n" -H "x-admin-token: $env:ADMIN_TOKEN" "https://iptv.xu05236.dpdns.org/api/admin/tasks"
```

- 新令牌：应返回 `200`。
- 旧令牌：应返回 `401`。
- 后台页面：刷新后如果提示未登录，用新令牌重新登录；旧会话不会自动换令牌。

### 6. 回滚

如果轮换后出现异常，把第 2、3、4 步改回旧值并重新部署。确认新值稳定前，先别删旧值。

### 7. 注意事项

- 第 2、3 步之间有一小段「一边新、一边旧」的窗口；正在跑的采集可能报一次 401，重试或下一轮会恢复。
- 不要在聊天、截图、提交信息、工单里粘贴令牌。
- 轮换后到「运营事件」看一眼，确认没有持续的 401 报障。

---

## English

### 1. Generate a new token

Run in PowerShell:

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
```

Use a 48-character random string. Do not use guessable phrases, dates, or a variation of the old token.

### 2. Update the Worker secret (production)

In the Cloudflare dashboard:

1. Open the Cloudflare Dashboard.
2. Go to **Workers & Pages**.
3. Select the `iptv-studio` Worker.
4. Open **Settings**.
5. Find **Variables and Secrets**.
6. Locate `ADMIN_TOKEN` (type: Secret / encrypted) and click **Edit**.
7. Paste the new value and click **Save and deploy**.

CLI alternative (requires a Cloudflare token with Workers Scripts edit permission):

```powershell
cd packages/worker
npx wrangler secret put ADMIN_TOKEN
```

Paste the new value when prompted.

> After this step, production accepts only the new token; the old one returns 401.

### 3. Update the GitHub Actions secret (collector)

In the repository:

1. Open `github.com/xu05236/iptv-studio`.
2. Open **Settings**.
3. In the sidebar: **Secrets and variables** → **Actions**.
4. Find `ADMIN_TOKEN` under Repository secrets and click **Update**.
5. Paste the same new value and click **Save**.

> Only new runs pick it up; a run already in progress keeps the old value.

### 4. Update local files

- `packages/worker/.deploy-secrets.txt`: change the value after `ADMIN_TOKEN=`.
- `packages/worker/.dev.vars`: same key, used for local development.

Both files are git-ignored; **never commit them**. If you run the frontend smoke test with `E2E_ADMIN_TOKEN`, export the new value too.

### 5. Verify

```powershell
$env:ADMIN_TOKEN = 'new-token'
curl.exe -s -o NUL -w "%{http_code}`n" -H "x-admin-token: $env:ADMIN_TOKEN" "https://iptv.xu05236.dpdns.org/api/admin/tasks"
```

- New token: expect `200`.
- Old token: expect `401`.
- Admin UI: refresh and sign in again if prompted; existing sessions do not rotate automatically.

### 6. Roll back

If something breaks, restore the old value in steps 2, 3 and 4 and redeploy. Keep the old value until the new one is proven.

### 7. Notes

- There is a short window between steps 2 and 3 where one side has the new token and the other still has the old one; a running collector may hit one 401 and recover on retry or the next run.
- Never paste the token into chat, screenshots, commits, or tickets.
- After rotating, check **运营事件 / Events** for a spike of 401 failures.
- This token is not the GitHub token and has nothing to do with repository permissions.
