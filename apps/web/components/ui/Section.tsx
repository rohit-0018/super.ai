import type { ReactNode } from 'react';

export function Section({
  title,
  subtitle,
  actions,
  children,
  flush,
  className,
  interactive,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  interactive?: boolean;
}) {
  return (
    <section className={`section${interactive ? ' section-interactive' : ''}${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <header className="section-header">
          <div className="min-w-0 flex items-baseline gap-2">
            {title && <h3 className="section-title truncate">{title}</h3>}
            {subtitle && (
              <span className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>
                {subtitle}
              </span>
            )}
          </div>
          {actions && <div className="section-actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? 'section-body-flush' : 'section-body'}>{children}</div>
    </section>
  );
}
