import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { KeyRound, Lock, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { Button, Card, Field } from '../../components/ui';
import { ThemeToggle } from '../../components/ThemeToggle';

export function Login() {
  const { login, token } = useAuth();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (token) {
    return <Navigate to="/admin" replace />;
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!value.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await login(value.trim());
      navigate('/admin', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="shell" style={{ display: 'grid', placeItems: 'center', padding: 20 }}>
      <div className="stack" style={{ width: '100%', maxWidth: 420 }}>
        <div className="row row--between">
          <div className="topbar__brand">
            <span className="brand-mark"><Lock size={14} /></span>
            IPTV Studio
          </div>
          <ThemeToggle compact />
        </div>

        <div style={{ marginTop: 8 }}>
          <h1 className="large-title">管理后台</h1>
          <p className="subhead" style={{ marginTop: 6 }}>输入部署时设置的 ADMIN_TOKEN 进入。</p>
        </div>

        <Card>
          <form onSubmit={submit} className="stack">
            <Field label="管理令牌" hint="令牌保存在 Cloudflare Secret 中，不会下发给浏览器。">
              <input
                className="input"
                type="password"
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="ADMIN_TOKEN"
                autoComplete="current-password"
              />
            </Field>
            {error ? <div className="caption" style={{ color: 'var(--red)' }}>{error}</div> : null}
            <Button type="submit" variant="primary" size="lg" block loading={loading}>
              <KeyRound size={16} /> 进入后台
            </Button>
          </form>
        </Card>

        <div className="row" style={{ gap: 8, color: 'var(--label-2)', fontSize: 12.5, padding: '0 4px' }}>
          <ShieldCheck size={15} />
          建议同时开启 Cloudflare Access（邮箱 OTP），形成双层防护。
        </div>
      </div>
    </div>
  );
}
