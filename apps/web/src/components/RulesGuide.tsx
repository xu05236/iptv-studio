import type { ReactNode } from 'react';
import { REPUTATION_RULE } from './ReputationBadge';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="title-3" style={{ marginBottom: 6 }}>{title}</div>
      <div className="caption" style={{ lineHeight: 1.7 }}>{children}</div>
    </section>
  );
}

/**
 * Shared rule book for admin and public pages. Keeping it in one component
 * prevents the explanations from drifting apart.
 */
export function RulesGuide({ scope = 'admin' }: { scope?: 'admin' | 'public' }) {
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Section title="信誉分（0–100）">
        <p>{REPUTATION_RULE}</p>
        <p>
          信誉分由抓取成功率、可用线路占比、平均线路质量和连续失败次数共同决定，不是线路数量。
          分数低的源会排在后面、分到更少的完整测速预算；连续失败达到 5 次会自动删除该采集站，避免长期占位。
        </p>
        <p>
          后台可以手动「收藏」采集站（权重 ×2）。收藏源排在最前面，它提供的线路在频道排序和导出时也会更靠前。
        </p>
      </Section>

      <Section title="线路状态与线路池">
        <p>
          每条线路会经历：待测（pending）→ 可用（alive）→ 可疑（suspect）→ 失效（dead）。
          一次失败只先进入可疑；连续 3 次失败才判定失效。可疑线路约 12 小时后会再次进入复测，
          不会因为一次抖动被永久搁置。
        </p>
        <p>
          线路池分为：精品（premium）、备用（backup）、候选（candidate，可用但质量未确认）、
          待测（pending）、隔离（quarantine，近期失败）、淘汰（rejected，失效）。
        </p>
        <p>
          线路池里可以给单条线路点星「收藏」。收藏线路会在频道线路列表和播放器导出中优先排序，
          适合你逐条实测后标记“这条好用”。
        </p>
        {scope === 'admin' ? (
          <p>删除只是从当前状态移除，源下次刷新可能重新出现；墓碑是永久拉黑，之后不会再导入该 URL。</p>
        ) : null}
      </Section>

      <Section title="线路展示与导出上限">
        <p>
          前台频道页支持每页 10 条 / 20 条 / 全部三种查看方式，默认 10 条。线路数量多时不会一次铺满页面。
        </p>
        <p>
          管理后台「设置 → 基础」可以分别调整：
          「前台默认显示行数」控制频道页最多展示多少条；
          「播放器导出行数」控制每个频道写入 M3U 的线路数量。
          两项都支持填 0 表示不限制。当前默认不限制，方便你逐条实测后自行收紧。
        </p>
      </Section>

      <Section title="探测与预算">
        <p>
          完整探测会实际拉流、测速和识别分辨率；轻量测活只检查清单/前 2KB，用来先筛掉明显死链。
          采集前会对 pending/suspect 做轻量预筛，通过后才进入完整测速。
        </p>
        <p>
          分批探测分「待测 → 待复测 → 已淘汰」三个阶段。每批条数、间隔和阶段顺序都可以在后台设置里改；
          每轮预算按“本轮最多完整测速多少条”计算，不是每天总量。
        </p>
      </Section>

      <Section title="节目单（EPG）">
        <p>
          节目单来自多个公开 XMLTV / CNTV 源，合并后写入当前 catalog。每个订阅会有自己的 EPG 文件，
          播放器通过 M3U 里的 tvg-id 与 XMLTV 频道 id 对齐。播放器显示“暂无节目单”时，优先重新导入/刷新订阅。
        </p>
      </Section>

      {scope === 'public' ? (
        <Section title="多久更新一次">
          <p>
            抓源大约每周一次；探测按后台设置的批次持续进行。线路池更新后，系统会自动发布目录和订阅
            （最多两小时一次），也可以由管理员手动点「发布更新」立即生效。
          </p>
          <p>
            前台看到的「已发布频道 / 已发布线路 / 已发布可用」是已经写入订阅的版本；
            「线路池」是包含备用、重复和未入选线路的实时统计，两者数量本来就会不同。
          </p>
        </Section>
      ) : null}

      {scope === 'admin' ? (
        <>
          <Section title="任务队列（当前）">
            <p>
              抓源、分批探测、发布、EPG、孤儿清理、手动检测和新增源都会进入全局任务队列，同一时间只运行一个。
              手动/检测中心优先级最高，新增源次之，定时任务最后。
            </p>
            <p>
              概览的「计划任务」会同时显示未到期的定时任务（抓源/发布/探测）；到点后进入真实队列。
              任务带来源徽章、当前阶段、进度和预计剩余时间，支持暂停、恢复、取消、插队和上移/下移。
            </p>
            <p>
              每个任务都有心跳。10–15 分钟无心跳、GitHub run 找不到或已失败时，看门狗会自动失败并重试，
              最多重试 2 次；失败和重试都会发 Telegram。KV 写入 ≥920 时队列暂停派发。
            </p>
          </Section>

          <Section title="自动发布与日报">
            <p>
              分批探测只更新线路池。只要线路池比已发布目录新，调度器会自动创建 publish 任务，
              但最多每 2 小时一次，避免每小时探测把 KV 写额度用完。概览有常驻「发布更新」按钮，可随时手动发布。
            </p>
            <p>
              Telegram 日报只在每日定时发布时发送，且使用独立的日报基线（不是“上次任意发布”），
              和后台当前目录可能相差几小时，报告里会显示数据截至时间。自动发布不会重复发日报。
            </p>
          </Section>

          <Section title="收藏与排序">
            <p>
              采集站收藏：权重 ×2，收藏源排在最前，线路排序更靠前。
              单条线路收藏：在线路池点星，导出和频道页会优先展示这些线路。
            </p>
            <p>
              台标优先使用采集站/线路自带的 tvg-logo，其次按频道名匹配公共台标包；都找不到时才显示首字占位。
            </p>
          </Section>

          <Section title="定时抓源与清理">
            <p>
              抓源默认每 7 天一次，也可以在新源加入时自动抓取；连续失败 5 次的源会自动删除。
              设置页「维护」可以手动清理孤儿线路和 D1 里旧的裸台标文件名。
            </p>
          </Section>

          <Section title="Telegram 机器人">
            <p>
              配置 Bot Token 和 Chat ID 后，可以发 /status 查看概览、/tasks 查看当前任务、
              /usage 查看 KV/D1/Actions 额度。任务失败、自动重试和系统告警会主动推送。
            </p>
          </Section>

          <Section title="留存与墓碑">
            <p>
              源刷新后不再列出的线路，默认保留 30 天（仍计入池和复测），方便源临时抽风后恢复；
              墓碑 URL 永久移除且不会再被导入。
            </p>
          </Section>
        </>
      ) : null}
    </div>
  );
}
