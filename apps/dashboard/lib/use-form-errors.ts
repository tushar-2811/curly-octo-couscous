'use client';

import { useState } from 'react';
import { ClientApiError } from './client-api';

/**
 * Error state for a form: the last API error, its per-field messages (hidden for fields
 * edited since), and whether to show a form-level alert (no field to attach it to).
 */
export function useFormErrors() {
  const [error, setError] = useState<ClientApiError | null>(null);
  const [edited, setEdited] = useState<ReadonlySet<string>>(new Set());
  const all = error?.fieldErrors ?? {};
  const fieldErrors = Object.fromEntries(
    Object.entries(all).filter(([k]) => !edited.has(k)),
  ) as Record<string, string>;
  return {
    error,
    fieldErrors,
    alert: error && Object.keys(all).length === 0 ? error : null,
    touch: (key: string) => setEdited((s) => (s.has(key) ? s : new Set(s).add(key))),
    clear: () => setError(null),
    /** Record a failed request. Anything other than an API error is rethrown. */
    fail: (err: unknown) => {
      if (!(err instanceof ClientApiError)) throw err;
      setError(err);
      setEdited(new Set());
    },
  };
}
