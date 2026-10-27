import { useState } from 'react';
import clsx from 'clsx';

export function ChannelLogo({ src, name, size }: { src?: string | null; name: string; size?: 'lg' }) {
  const [failed, setFailed] = useState(false);
  const className = clsx('logo', size === 'lg' && 'logo--lg');

  if (!src || failed) {
    return <div className={clsx(className, 'logo--fallback')}>{name.slice(0, 1)}</div>;
  }
  return <img className={className} src={src} alt={name} loading="lazy" onError={() => setFailed(true)} />;
}
