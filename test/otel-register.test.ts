import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Không khởi động OpenTelemetry thật (sẽ đăng ký loader hook toàn process và mở kết nối mạng).
// Thay các thư viện bằng bản giả để kiểm tra cách register.ts cấu hình chúng.
const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  getNodeAutoInstrumentations: vi.fn((_config?: unknown) => ['auto-instrumentations']),
  start: vi.fn(),
  shutdown: vi.fn(async () => undefined),
  sdkOptions: undefined as unknown,
}));

vi.mock('node:module', () => ({ register: mocks.register }));
vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: mocks.getNodeAutoInstrumentations,
}));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    readonly kind = 'trace-exporter';
  },
}));
vi.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
  OTLPMetricExporter: class {
    readonly kind = 'metric-exporter';
  },
}));
vi.mock('@opentelemetry/sdk-metrics', () => ({
  PeriodicExportingMetricReader: class {
    constructor(readonly options: unknown) {}
  },
}));
vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    readonly start = mocks.start;
    readonly shutdown = mocks.shutdown;
    constructor(options: unknown) {
      mocks.sdkOptions = options;
    }
  },
}));

type TelemetryGlobal = { __olTelemetryShutdown?: () => Promise<void> };
type AutoConfig = {
  '@opentelemetry/instrumentation-fs': { enabled: boolean };
  '@opentelemetry/instrumentation-http': {
    ignoreIncomingRequestHook: (req: { url?: string }) => boolean;
  };
};

const ENV_KEYS = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_SDK_DISABLED'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

async function loadRegister(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules(); // Chạy lại register.ts vì nó có tác dụng phụ khi import
  await import('../src/otel/register.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sdkOptions = undefined;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete (globalThis as TelemetryGlobal).__olTelemetryShutdown;
});

describe('otel/register', () => {
  it('luôn đăng ký hook cho ES Modules', async () => {
    await loadRegister({});
    expect(mocks.register).toHaveBeenCalledWith(
      '@opentelemetry/instrumentation/hook.mjs',
      expect.stringMatching(/otel\/register\.ts$/),
    );
  });

  it('không có OTEL_EXPORTER_OTLP_ENDPOINT → không khởi động SDK', async () => {
    await loadRegister({});
    expect(mocks.sdkOptions).toBeUndefined();
    expect(mocks.start).not.toHaveBeenCalled();
    expect((globalThis as TelemetryGlobal).__olTelemetryShutdown).toBeUndefined();
  });

  it('endpoint rỗng → coi như tắt', async () => {
    await loadRegister({ OTEL_EXPORTER_OTLP_ENDPOINT: '' });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('OTEL_SDK_DISABLED=true → tắt dù có endpoint', async () => {
    await loadRegister({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_SDK_DISABLED: 'true',
    });
    expect(mocks.sdkOptions).toBeUndefined();
    expect(mocks.start).not.toHaveBeenCalled();
    expect((globalThis as TelemetryGlobal).__olTelemetryShutdown).toBeUndefined();
  });

  it('có endpoint → dựng SDK với exporter trace/metric (chu kỳ 60 giây) và gọi start()', async () => {
    await loadRegister({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' });

    expect(mocks.start).toHaveBeenCalledTimes(1);
    const options = mocks.sdkOptions as {
      traceExporter: { kind: string };
      metricReader: { options: { exporter: { kind: string }; exportIntervalMillis: number } };
      instrumentations: unknown[];
    };
    expect(options.traceExporter.kind).toBe('trace-exporter');
    expect(options.metricReader.options.exporter.kind).toBe('metric-exporter');
    expect(options.metricReader.options.exportIntervalMillis).toBe(60_000);
    // getNodeAutoInstrumentations() tự trả về một mảng nên mảng instrumentations bị lồng một cấp
    expect(options.instrumentations).toEqual([['auto-instrumentations']]);
  });

  it('OTEL_SDK_DISABLED khác "true" thì vẫn bật', async () => {
    await loadRegister({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_SDK_DISABLED: 'false',
    });
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  it('tắt instrumentation fs và bỏ qua trace của /health', async () => {
    await loadRegister({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' });

    const config = mocks.getNodeAutoInstrumentations.mock.calls[0]?.[0] as AutoConfig;
    expect(config['@opentelemetry/instrumentation-fs'].enabled).toBe(false);

    const ignore = config['@opentelemetry/instrumentation-http'].ignoreIncomingRequestHook;
    expect(ignore({ url: '/health/live' })).toBe(true);
    expect(ignore({ url: '/health/ready' })).toBe(true);
    expect(ignore({ url: '/v1/tenants/t1/items' })).toBe(false);
    expect(ignore({})).toBe(false); // Không có url
  });

  it('công bố hàm tắt để server.ts đẩy nốt dữ liệu khi shutdown', async () => {
    await loadRegister({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' });

    const shutdown = (globalThis as TelemetryGlobal).__olTelemetryShutdown;
    expect(shutdown).toBeTypeOf('function');
    await shutdown?.();
    expect(mocks.shutdown).toHaveBeenCalledTimes(1);
  });
});
