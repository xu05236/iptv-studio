import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Signal, Tv } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import type { ChannelsResponse } from '../lib/types';
import { formatResolution, formatSpeed } from '../lib/format';
import { Badge, Button, EmptyState, Skeleton } from '../components/ui';
import { ChannelLogo } from '../components/ChannelLogo';

export function Channels() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const group = params.get('group') ?? '';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(search);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 280);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const next = new URLSearchParams(params);
    if (debounced) next.set('q', debounced);
    else next.delete('q');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const query = useInfiniteQuery({
    queryKey: ['channels', debounced, group],
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({ page: String(pageParam), limit: '60' });
      if (debounced) search.set('q', debounced);
      if (group) search.set('group', group);
      return api.get<ChannelsResponse>(`/api/public/channels?${search.toString()}`);
    },
    initialPageParam: 1,
    getNextPageParam: (last, pages) => (pages.length * last.limit < last.total ? pages.length + 1 : undefined),
  });

  const pages = query.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const groups = pages[0]?.groups ?? [];
  const total = pages[0]?.total ?? 0;

  return (
    <div className="stack" style={{ marginTop: 6 }}>
      <div className="row row--between">
        <div>
          <h1 className="large-title">频道</h1>
          <p className="subhead" style={{ marginTop: 4 }}>
            {query.data ? `${total} 个频道 · ${items.reduce((sum, item) => sum + item.alive, 0)} 条可用线路` : '正在读取频道索引'}
          </p>
        </div>
        <Badge tone="blue">{group || '全部'}</Badge>
      </div>

      <div className="search">
        <Search size={16} className="search__icon" />
        <input
          className="input"
          placeholder="搜索频道、CCTV、卫视…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoComplete="off"
        />
      </div>

      <div className="scroll-x">
        <button className={clsx('chip', !group && 'chip--active')} onClick={() => updateGroup('')}>
          全部
        </button>
        {groups.map((item) => (
          <button
            key={item.group}
            className={clsx('chip', group === item.group && 'chip--active')}
            onClick={() => updateGroup(item.group)}
          >
            {item.group}
            <span style={{ opacity: 0.7 }}>{item.channels}</span>
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <div className="stack stack--tight">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} height={66} radius={16} />
          ))}
        </div>
      ) : items.length ? (
        <div className="list">
          {items.map((channel) => (
            <button key={channel.id} className="list__row" onClick={() => navigate(`/channels/${encodeURIComponent(channel.id)}`)}>
              <ChannelLogo src={channel.logo} name={channel.name} />
              <div className="grow">
                <div className="row" style={{ gap: 6 }}>
                  <span className="list__title truncate">{channel.name}</span>
                  {channel.bestResolution ? <Badge tone="blue">{formatResolution(channel.bestResolution)}</Badge> : null}
                </div>
                <div className="list__sub">
                  {channel.group} · {channel.alive} 可用 / {channel.lines} 线路
                  {channel.bestSpeedKbps ? ` · ${formatSpeed(channel.bestSpeedKbps)}` : ''}
                </div>
              </div>
              <Signal size={16} color={channel.alive > 0 ? 'var(--green)' : 'var(--label-3)'} />
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Tv size={24} />}
          title={pages[0]?.ready === false ? '尚未生成频道数据' : '没有找到频道'}
          description={pages[0]?.ready === false ? '请先在管理后台触发一次采集任务。' : '换个关键词或分类试试。'}
          action={
            pages[0]?.ready === false ? (
              <Button variant="primary" onClick={() => navigate('/admin')}>
                去管理后台
              </Button>
            ) : undefined
          }
        />
      )}

      {query.hasNextPage ? (
        <Button block loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          加载更多
        </Button>
      ) : null}
    </div>
  );

  function updateGroup(next: string): void {
    const paramsNext = new URLSearchParams(params);
    if (next) paramsNext.set('group', next);
    else paramsNext.delete('group');
    setParams(paramsNext, { replace: true });
  }
}
