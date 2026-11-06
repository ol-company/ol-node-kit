// Logger JSON dùng pino. Mỗi dòng log tự có requestId, principal và (khi bật OpenTelemetry)
// trace_id/span_id do instrumentation của pino thêm vào.
import { pino, type Logger } from 'pino';
import { requestContext } from './context.js';

export type { Logger } from 'pino';

export interface LoggerOptions {
  service: string; // Tên service, xuất hiện ở mọi dòng log
  level?: string; // trace | debug | info | warn | error | fatal
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level ?? 'info',
    base: { service: options.service, env: process.env.APP_ENV ?? 'local' },
    timestamp: pino.stdTimeFunctions.isoTime, // Thời gian ISO 8601, dễ đọc và sắp xếp
    // Che dữ liệu nhạy cảm nếu vô tình bị log
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.token',
        '*.accessToken',
        '*.refreshToken',
        '*.clientSecret',
        'principal.token',
      ],
      censor: '[REDACTED]',
    },
    // mixin chạy cho mỗi dòng log: bổ sung ngữ cảnh request hiện tại
    mixin() {
      const ctx = requestContext.get();
      if (!ctx) return {};
      return { requestId: ctx.requestId, principal: ctx.principal?.id };
    },
  });
}
