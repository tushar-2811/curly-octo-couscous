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

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** "26 Nov 2026, 14:12:05 UTC". Fixed locale and zone, like formatDate. */
export function formatDateTime(iso: string): string {
  return `${DATE_TIME_FORMAT.format(new Date(iso))} UTC`;
}
