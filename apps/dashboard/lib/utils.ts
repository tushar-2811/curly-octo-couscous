import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Split a comma- or newline-separated input into trimmed, non-empty items. */
export function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * "25 Nov 2026". Fixed locale and time zone so the server and the browser render the
 * same text (a locale-dependent date breaks hydration).
 */
export function formatDate(iso: string): string {
  return DATE_FORMAT.format(new Date(iso));
}
