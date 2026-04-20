import type { ReactNode } from 'react';

export type BadgeKind = 'concern' | 'break' | 'okay' | 'muted' | 'amber';

interface BadgeProps {
  kind?: BadgeKind;
  children: ReactNode;
}

export function Badge({ kind = 'muted', children }: BadgeProps) {
  return (
    <span className={`badge badge-${kind}`}>
      <span className="pip" />
      {children}
    </span>
  );
}
