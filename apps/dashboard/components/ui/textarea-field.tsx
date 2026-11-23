import type { ReactNode, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Labelled multi-line input with hint and error, styled like Field. */
export function TextareaField({
  id,
  label,
  hint,
  error,
  className,
  ...textarea
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
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
      <textarea
        id={id}
        name={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          'block min-h-28 w-full rounded-md border bg-white px-3 py-2 text-sm placeholder:text-gray-600 disabled:bg-gray-100 disabled:text-gray-600',
          error
            ? 'border-2 border-red-600 focus-visible:outline-red-600'
            : 'border-gray-300 focus-visible:border-black',
        )}
        {...textarea}
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-gray-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs font-semibold text-red-600">
          Error: {error}
        </p>
      )}
    </div>
  );
}
