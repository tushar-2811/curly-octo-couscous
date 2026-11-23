import { ChevronDown } from 'lucide-react';
import type { SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label: string;
}

/** Labelled native select (keyboard and screen-reader friendly), styled like Field. */
export function SelectField({
  id,
  label,
  options,
  hint,
  error,
  className,
  ...select
}: SelectHTMLAttributes<HTMLSelectElement> & {
  id: string;
  label: string;
  options: SelectOption[];
  hint?: string;
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
      <div className="relative">
        <select
          id={id}
          name={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            'block h-9 w-full appearance-none rounded-md border bg-white pl-3 pr-9 text-sm disabled:bg-gray-100 disabled:text-gray-600',
            error
              ? 'border-2 border-red-600 focus-visible:outline-red-600'
              : 'border-gray-300 focus-visible:border-black',
          )}
          {...select}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2"
          aria-hidden
        />
      </div>
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
