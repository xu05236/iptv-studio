# 交接记录 · 2026-10-27

> 明天继续时先读这一页，再按「明日待办」顺序推进。

## 一、今日完成

### 部署

- Worker：`https://iptv.xu05236.dpdns.org`（自定义域名，workers.dev 在国内被 TLS 阻断）
- 当前 Worker 版本：`aa523a13-3bba-41a5-9e05-fed4d151cf2b`
- D1：`iptv-studio` / `da4e65ee-de99-455e-88ed-eb06d10cd139`
- KV：`iptv-studio-kv` / `d4fc0301922746df8af08e288172c1c4`
- 仓库：`github.com/xu05236/iptv-studio`（Private，SSH 推送）
- 凭据：`packages/worker/.deploy-secrets.txt`（已 gitignore，**不要提交**）

### 功能

- 首个 Actions 采集 + 测速 + 发布成功（1200 条预算、216 条可用）
- 订阅自动渲染与预渲染、ETag/304、KV 自缓存
- 默认 EPG 源（fanmingming + epg.pw）+ CNTV 央视增强源
  - 央视 18 频道 / 787 条节目
  - EPG 产物约 6.1MB，516 个频道条目
- 浏览器试播修复：
  - 公开 API 不再返回真实 `url` / 请求头
  - 新增线路级中继 `/relay/line/<key>`，HLS 分片 HMAC 签名，15s 上游超时
  - 播放器区分 HTTP 混合内容、RTSP/RTMP、HLS 跨域
- 后台「采集站」：显示站点域名、完整地址、条目/可用、信誉、启停/检查/抽样/删除
- 检测中心：统计卡 + 分辨率分布 + 搜索/状态筛选 + 明细表（分辨率/速率/首字节/检测时间/来源站点）
- 分辨率：URL/名称推断 + ffprobe 实测补全（仅 alive 且缺分辨率的线路，`FFPROBE_LIMIT` 默认 150）
- 订阅：新增「指定频道」多选，支持分组 + 频道组合
- 频道分类修复：
  - 同步时「其他」只能升级为有效分组
  - 后台「频道」新增「修复分类」按钮
  - 重建索引后央视分组 19 个频道，`CCTV-12` 已归入央视

### 线上数据快照

- 频道：855；线路：2020；可用：25（最近一次导出）
- 分辨率：1080p 193、720p 130、480p 19、2160p 8、1440p 1，其余为实测/未知
- 未知分辨率 1646：名称/URL 无清晰度标记且线路未测通

## 二、明日待办（P0）

1. **补 Hunan TV 别名**
   - `Hunan TV (2160p)` 目前被归到「地方」，应映射到 `hunan-weishi`
   - 位置：后台频道 → 别名，或 `packages/core/src/normalize/channels.ts` 种子
2. **全量测速 / 提高可用数**
   - 当前只有 25 条 alive，大量线路未测或失效
   - 现有 `planProbes` 只测「到期」线路，无法强制全量
   - 建议：增加 `PROBE_FORCE=1`（忽略 TTL，按预算全测），或临时把 tier TTL 调小
3. **订阅名称**
   - 创建时被 PowerShell 编码成 `????`，后台手动改名即可；若仍是乱码，检查 API 写入编码
4. **轮换 ADMIN_TOKEN**
   - 令牌曾出现在聊天记录，建议 `wrangler secret put ADMIN_TOKEN` 后重新登录
5. **确认 CI**
   - `ci.yml` 在 push 时运行；本地网络看不到 Actions 状态，明天在 GitHub 页面确认是否绿

## 三、下周可做（P2，已记录）

- **EPG 卫视/地方台官方源适配器**（原计划等紧急修改后提醒）
  - 候选：湖南/浙江/江苏/东方/北京
  - 复用 `core/src/epg/cctv.ts` 模式
  - 详见 `docs/ROADMAP.md` P2-1
- 反馈数据折算进源信誉分
- 规则可视化编辑器
- 快照一键回滚
- 多地区探测（self-hosted runner）
- 非 HLS 分辨率（TS PMT/SPS 解析）
- 截图 AI 视觉校验

## 四、运行手册

```bash
# 本地类型检查 / 测试
npm run typecheck
npm test

# 改代码后部署（本机 wrangler 已登录）
npm run deploy

# 仅部署 Worker（前端已构建）
cd packages/worker && npx wrangler deploy

# 数据库迁移
npm run db:migrate

# 推送代码（SSH key 在 .tools/ssh，需 GIT_SSH_COMMAND）
$key=(Resolve-Path .tools\ssh\id_ed25519).Path
$env:GIT_SSH_COMMAND="ssh -i `"$key`" -o IdentitiesOnly=yes"
git push
```

Actions 手动入口：

- 采集 + 测速：`command=collect`，`budget=300/1200/6000`
- 仅重建导出（含 ffprobe）：`command=export`
- 仅更新 EPG：`command=epg`

## 五、关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/core/src/epg/cctv.ts` | 央视 EPG 解析 |
| `packages/core/src/util/text.ts` | `inferResolution` / 频道归一化 |
| `packages/runner/src/pipeline/ffprobe.ts` | 分辨率实测补全 |
| `packages/runner/src/pipeline/publish.ts` | 目录/分桶/`probe.json` 发布 |
| `packages/worker/src/routes/relay.ts` | 线路级中继 |
| `packages/worker/src/routes/admin.ts` | 检测数据接口 |
| `packages/worker/src/routes/channels.ts` | 频道 CRUD / 修复分类 |
| `apps/web/src/pages/admin/Probe.tsx` | 检测中心 |
| `apps/web/src/pages/ChannelDetail.tsx` | 前台频道详情/试播 |

## 六、已知限制（避免明天重复踩）

- 本机到自定义域名的 HTTPS 抖动严重（30–90s 超时），验证尽量用 `curl -m 90` 或 GitHub Actions
- 本地 `wrangler d1 ... --local` 会因 Windows 权限起不来，远程命令正常
- Workers 免费版 CPU 10ms，订阅必须走预渲染/R2→KV 静态对象
- KV 单值 25MB，EPG/线路状态有 24MB 保护
- RTSP/RTMP 浏览器无法播放，只能 VLC/盒子
- 中继已开启，会消耗 Worker 流量；如遇限速可在「设置 → 高级」关闭
