// Khởi động OpenTelemetry TRƯỚC khi app import express/pg để instrumentation hoạt động.
// Cách dùng: node --import @ol-company/node-kit/otel-register dist/main.js
// (service dùng alias nên viết: node --import @ol/node-kit/otel-register dist/main.js)
// Chỉ bật khi có OTEL_EXPORTER_OTLP_ENDPOINT. Tên service lấy từ OTEL_SERVICE_NAME.
import { register } from 'node:module';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

// Hook cho ES Modules: cho phép instrumentation "vá" các module được import
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const enabled = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) && process.env.OTEL_SDK_DISABLED !== 'true';

if (enabled) {
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(), // Đọc endpoint từ biến OTEL_EXPORTER_OTLP_ENDPOINT
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 60_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false }, // Quá nhiều span, ít giá trị
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => (req.url ?? '').startsWith('/health'), // Bỏ trace health check
        },
      }),
    ],
  });
  sdk.start();
  // server.ts gọi hàm này khi tắt để đẩy nốt dữ liệu
  (globalThis as { __olTelemetryShutdown?: () => Promise<void> }).__olTelemetryShutdown = () => sdk.shutdown();
}
