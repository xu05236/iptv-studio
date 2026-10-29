import { useEffect, useState } from 'react';
import clsx from 'clsx';

const LOGO_PROVIDERS = [
  'https://raw.githubusercontent.com/fanmingming/live/main/tv/',
  'https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/',
  'https://gcore.jsdelivr.net/gh/fanmingming/live@main/tv/',
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
