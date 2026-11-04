import type { ReactNode } from 'react';

export function AdminPageHeader({
  eyebrow,
  title,
  description,
  meta,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="admin-hero admin-page-head">
      <div className="admin-hero__content">
        <div className="admin-eyebrow">{eyebrow}</div>
        <h1 className="large-title">{title}</h1>
        <p className="subhead" style={{ marginTop: 4 }}>{description}</p>
        {meta ? <p className="caption" style={{ marginTop: 4 }}>{meta}</p> : null}
      </div>
      {actions ? <div className="admin-hero__actions">{actions}</div> : null}
    </div>
  );
}
