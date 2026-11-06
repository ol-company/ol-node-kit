// Khởi động HTTP server với timeout hợp lý và tắt êm (graceful shutdown):
// SIGTERM → readiness 503 → chờ drain → ngừng nhận kết nối → chờ request đang chạy → đóng DB → thoát.
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { Logger } from '../logger.js';
import type { HealthState } from './health.js';

export interface ServerOptions {
  app: Express;
  port: number;
  logger: Logger;
  health: HealthState;
  onShutdown?: Array<() => Promise<unknown>>; // Ví dụ: () => pool.end()
  drainDelayMs?: number; // Thời gian chờ load balancer rút task (mặc định 5 giây)
  shutdownTimeoutMs?: number; // Quá hạn thì buộc thoát (mặc định 25 giây < stopTimeout 30 giây của ECS)
}

export function startServer(options: ServerOptions): Server {
  const { app, port, logger, health } = options;

  const server = app.listen(port, () => {
    health.ready = true;
    logger.info({ port }, 'server_started');
  });

  // ALB giữ kết nối nhàn rỗi 60 giây → server phải giữ lâu hơn để tránh lỗi 502 ngẫu nhiên
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000; // Phải lớn hơn keepAliveTimeout
  server.requestTimeout = 70_000; // Thời gian tối đa nhận xong một request

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    health.shuttingDown = true; // /health/ready trả 503 ngay
    logger.info({ signal }, 'shutdown_started');

    const forceExit = setTimeout(() => {
      logger.error('shutdown_timeout_force_exit');
      process.exit(1);
    }, options.shutdownTimeoutMs ?? 25_000);
    forceExit.unref(); // Không giữ process sống chỉ vì timer này

    await new Promise((r) => setTimeout(r, options.drainDelayMs ?? 5_000));
    await new Promise<void>((resolve) => {
      server.close(() => resolve()); // Ngừng nhận kết nối mới, chờ request đang chạy xong
      server.closeIdleConnections(); // Đóng kết nối keep-alive đang rảnh
    });

    for (const fn of options.onShutdown ?? []) {
      try {
        await fn();
      } catch (err) {
        logger.error({ err }, 'shutdown_hook_failed');
      }
    }
    // Đẩy nốt trace/metric còn trong bộ đệm của OpenTelemetry (nếu đã bật)
    const otelShutdown = (globalThis as { __olTelemetryShutdown?: () => Promise<void> }).__olTelemetryShutdown;
    if (otelShutdown) await otelShutdown().catch(() => undefined);

    clearTimeout(forceExit);
    logger.info('shutdown_complete');
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM')); // ECS/Docker gửi khi dừng container
  process.once('SIGINT', () => void shutdown('SIGINT')); // Ctrl+C khi chạy local
  return server;
}
