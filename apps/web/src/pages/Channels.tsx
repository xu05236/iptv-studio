import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Signal, Tv } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import type { ChannelsResponse } from '../lib/types';
import { formatResolution, formatSpeed } from '../lib/format';
import { Badge, Button, EmptyState, Pagination, Skeleton } from '../components/ui';
import { ChannelLogo } from '../components/ChannelLogo';

const PAGE_SIZE = 50;

export function Channels() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const group = params.get('group') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
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
    next.delete('page');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const query = useQuery({
    queryKey: ['channels', debounced, group, page],
    queryFn: () => {
      const searchParams = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (debounced) searchParams.set('q', debounced);
      if (group) searchParams.set('group', group);
      return api.get<ChannelsResponse>(`/api/public/channels?${searchParams.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  const items = query.data?.items ?? [];
  const groups = query.data?.groups ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    if (query.data && page > totalPages) {
      const next = new URLSearchParams(params);
      next.delete('page');
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, page, totalPages]);

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

      <div className="row row--wrap" style={{ gap: 6 }}>
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
          title={query.data?.ready === false ? '尚未生成频道数据' : '没有找到频道'}
          description={query.data?.ready === false ? '请先在管理后台触发一次采集任务。' : '换个关键词或分类试试。'}
          action={
            query.data?.ready === false ? (
              <Button variant="primary" onClick={() => navigate('/admin')}>
                去管理后台
              </Button>
            ) : undefined
          }
        />
      )}

      <Pagination page={page} totalPages={totalPages} onChange={updatePage} />
    </div>
  );

  function updatePage(next: number): void {
    const nextParams = new URLSearchParams(params);
    if (next > 1) nextParams.set('page', String(next));
    else nextParams.delete('page');
    setParams(nextParams);
  }

  function updateGroup(next: string): void {
    const paramsNext = new URLSearchParams(params);
    if (next) paramsNext.set('group', next);
    else paramsNext.delete('group');
    paramsNext.delete('page');
    setParams(paramsNext, { replace: true });
  }
}
