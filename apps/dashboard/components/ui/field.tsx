import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Labelled text input with hint and error. The error is announced to screen readers and
 * shown with weight and an icon-free "Error:" prefix rather than color.
 */
export function Field({
  id,
  label,
  hint,
  error,
  className,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
}) {
  const describedBy =
    [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        name={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          'block h-9 w-full rounded-md border bg-white px-3 text-sm placeholder:text-gray-600 disabled:bg-gray-100 disabled:text-gray-600',
          error ? 'border-2 border-black' : 'border-gray-300 focus-visible:border-black',
        )}
        {...input}
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-gray-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs font-semibold">
          Error: {error}
        </p>
      )}
    </div>
  );
}
