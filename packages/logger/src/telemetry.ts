import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

/**
 * Start OpenTelemetry tracing for this process. Spans are exported only when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise tracing still runs in-process so that
 * log lines carry trace_id and span_id, which ties logs from one request together.
 */
export function startTelemetry(options: {
  service: string;
  version: string;
  otlpEndpoint?: string | undefined;
}): void {
  if (sdk) return;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.service,
      [ATTR_SERVICE_VERSION]: options.version,
    }),
    ...(options.otlpEndpoint
      ? { traceExporter: new OTLPTraceExporter({ url: `${options.otlpEndpoint}/v1/traces` }) }
      : {}),
    instrumentations: [new HttpInstrumentation(), new PgInstrumentation()],
  });
  sdk.start();
}

export async function stopTelemetry(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
}
