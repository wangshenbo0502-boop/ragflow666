import { Button } from '@/components/ui/button';
import {
  AlertCircle,
  FolderOpen,
  LoaderCircle,
  RotateCw,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

export function RailListState({
  label,
  detail,
  icon: Icon = FolderOpen,
  loading,
  error,
  onRetry,
  children,
  testId,
}: {
  label: string;
  detail?: string;
  icon?: LucideIcon;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => unknown;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="rail-empty"
      data-testid={testId}
      role={error ? 'alert' : loading ? 'status' : undefined}
    >
      {loading ? (
        <LoaderCircle className="size-6 motion-safe:animate-spin" aria-hidden />
      ) : error ? (
        <AlertCircle className="size-6 text-state-error" aria-hidden />
      ) : (
        <Icon className="size-6" aria-hidden />
      )}
      <h2>{label}</h2>
      {detail && <p>{detail}</p>}
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          <RotateCw className="size-4" /> 重试
        </Button>
      )}
      {children}
    </div>
  );
}
