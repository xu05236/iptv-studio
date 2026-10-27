import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import clsx from 'clsx';

const KEY = 'iptv.theme';

type Theme = 'system' | 'light' | 'dark';

function apply(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(KEY) as Theme | null) ?? 'system');

  useEffect(() => {
    apply(theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);

  const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const label = theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '自动';

  return (
    <button
      className={clsx('btn', compact && 'btn--icon')}
      onClick={() => setTheme(next)}
      title={`外观：${label}（点击切换）`}
      aria-label={`外观：${label}`}
    >
      {theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
      {compact ? null : <span>{label}</span>}
    </button>
  );
}
