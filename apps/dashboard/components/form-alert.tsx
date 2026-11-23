import { AlertTriangle } from 'lucide-react';

/** Form-level error (not tied to one field), with the request id to quote. */
export function FormAlert({
  title,
  detail,
  requestId,
}: {
  title: string;
  detail?: string | undefined;
  requestId?: string | undefined;
}) {
  return (
    <div role="alert" className="flex gap-3 rounded-md border border-red-600 bg-red-50 px-4 py-3">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden />
      <div className="text-sm">
        <p className="font-semibold text-red-600">{title}</p>
        {detail && <p className="mt-0.5 text-gray-600">{detail}</p>}
        {requestId && (
          <p className="mt-1 font-mono text-xs text-gray-600">Request ID {requestId}</p>
        )}
      </div>
    </div>
  );
}
