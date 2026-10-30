import { useEffect, useState } from 'react';
import clsx from 'clsx';

const LOGO_PROVIDERS = [
  // Same/related logo packs behind several CDNs, mirrors and forks. Order is by
  // observed reachability from mainland networks; the browser falls through on
  // error and finally renders the channel-name initial.
  'https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/',
  'https://fastly.jsdelivr.net/gh/fanmingming/live@main/tv/',
  'https://gcore.jsdelivr.net/gh/fanmingming/live@main/tv/',
  'https://testingcf.jsdelivr.net/gh/fanmingming/live@main/tv/',
  'https://ghproxy.net/https://raw.githubusercontent.com/fanmingming/live/main/tv/',
  'https://gh-proxy.com/https://raw.githubusercontent.com/fanmingming/live/main/tv/',
  // Independent forks/packs: useful when the main repo or one CDN path fails.
  'https://cdn.jsdelivr.net/gh/8u8m/live-fanmingming@main/tv/',
  'https://cdn.jsdelivr.net/gh/bxtww/live@main/tv/',
  'https://cdn.jsdelivr.net/gh/bonnie180/live-m3u8@main/tv/',
  'https://cdn.jsdelivr.net/gh/vircloud/TVLogo@main/',
  'https://raw.githubusercontent.com/fanmingming/live/main/tv/',
];

export function ChannelLogo({ src, name, size, tvgId }: { src?: string | null; name: string; size?: 'lg'; tvgId?: string | null }) {
  const className = clsx('logo', size === 'lg' && 'logo--lg');
  const encoded = tvgId ? encodeURIComponent(tvgId) : '';
  const sources = [
    src,
    ...(encoded ? LOGO_PROVIDERS.map((base) => `${base}${encoded}.png`) : []),
  ].filter((value, index, list): value is string => Boolean(value) && list.indexOf(value) === index);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [src, tvgId]);

  if (!sources.length || index >= sources.length) {
    return <div className={clsx(className, 'logo--fallback')}>{name.slice(0, 1)}</div>;
  }
  return (
    <img
      className={className}
      src={sources[index]}
      alt={name}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setIndex((current) => current + 1)}
    />
  );
}
