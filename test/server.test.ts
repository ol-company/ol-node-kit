import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { HealthState, startServer, type Logger, type ServerOptions } from '../src/index.js';

type SignalHandler = () => void;
type TelemetryGlobal = { __olTelemetryShutdown?: () => Promise<void> };

let handlers: Map<string, SignalHandler>;
let exit: MockInstance<(code?: number | string | null) => never>;
let servers: Server[];

beforeEach(() => {
  handlers = new Map();
  servers = [];
  // Chỉ chặn đăng ký SIGTERM/SIGINT để test tự kích hoạt, không gửi tín hiệu thật vào process
  const originalOnce = process.once.bind(process);
  vi.spyOn(process, 'once').mockImplementation(((event: string, handler: SignalHandler) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      handlers.set(event, handler);
      return process;
    }
    return originalOnce(event, handler);
  }) as typeof process.once);
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete (globalThis as TelemetryGlobal).__olTelemetryShutdown;
  for (const server of servers) {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

async function start(options: Partial<ServerOptions> = {}) {
  const info = vi.fn();
  const error = vi.fn();
  const health = new HealthState();
  const server = startServer({
    app: express(),
    port: 0, // Hệ điều hành chọn cổng trống
    logger: { info, error } as unknown as Logger,
    health,
    drainDelayMs: 0,
    shutdownTimeoutMs: 5_000,
    ...options,
  });
  servers.push(server);
  await vi.waitFor(() => expect(health.ready).toBe(true));
  return { server, health, info, error };
}

const signal = (name: string) => {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Chưa đăng ký handler ${name}`);
  handler();
};

describe('startServer – khởi động', () => {
  it('đánh dấu ready sau khi listen và ghi log server_started', async () => {
    const { server, health, info } = await start();
    expect(server.listening).toBe(true);
    expect(health.ready).toBe(true);
    expect(health.shuttingDown).toBe(false);
    expect(info).toHaveBeenCalledWith({ port: 0 }, 'server_started');
  });

  it('đặt timeout dài hơn 60 giây của ALB để tránh 502 ngẫu nhiên', async () => {
    const { server } = await start();
    expect(server.keepAliveTimeout).toBe(65_000);
    expect(server.headersTimeout).toBe(66_000);
    expect(server.requestTimeout).toBe(70_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it('đăng ký xử lý cả SIGTERM và SIGINT', async () => {
    await start();
    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
  });
});

describe('startServer – tắt êm', () => {
  it('SIGTERM: readiness 503 ngay, đóng server, chạy hook theo thứ tự rồi thoát mã 0', async () => {
    const order: string[] = [];
    const { server, health, info } = await start({
      onShutdown: [
        async () => void order.push('đóng pool'),
        async () => void order.push('flush cache'),
      ],
    });

    signal('SIGTERM');
    expect(health.shuttingDown).toBe(true); // Đổi trạng thái ngay, trước khi drain

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(server.listening).toBe(false);
    expect(order).toEqual(['đóng pool', 'flush cache']);
    expect(info).toHaveBeenCalledWith({ signal: 'SIGTERM' }, 'shutdown_started');
    expect(info).toHaveBeenCalledWith('shutdown_complete');
  });

  it('SIGINT cũng tắt êm', async () => {
    const { info } = await start();
    signal('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(info).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'shutdown_started');
  });

  it('nhận tín hiệu lần hai trong lúc đang tắt thì bỏ qua (không chạy hook hai lần)', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    const { info } = await start({ onShutdown: [hook] });

    signal('SIGTERM');
    signal('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(hook).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.filter(([, msg]) => msg === 'shutdown_started')).toHaveLength(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('một hook lỗi thì ghi log và vẫn chạy các hook còn lại', async () => {
    const boom = new Error('pool.end() lỗi');
    const second = vi.fn().mockResolvedValue(undefined);
    const { error } = await start({
      onShutdown: [() => Promise.reject(boom), second],
    });

    signal('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(error).toHaveBeenCalledWith({ err: boom }, 'shutdown_hook_failed');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('đẩy nốt dữ liệu OpenTelemetry (nếu đã bật) trước khi thoát', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    (globalThis as TelemetryGlobal).__olTelemetryShutdown = flush;
    await start();

    signal('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('flush OpenTelemetry lỗi cũng không chặn việc thoát', async () => {
    const flush = vi.fn().mockRejectedValue(new Error('collector chết'));
    (globalThis as TelemetryGlobal).__olTelemetryShutdown = flush;
    await start();

    signal('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('quá hạn shutdownTimeoutMs → ghi log và buộc thoát mã 1', async () => {
    const { error } = await start({ drainDelayMs: 200, shutdownTimeoutMs: 20 });

    signal('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(error).toHaveBeenCalledWith('shutdown_timeout_force_exit');

    // Để quy trình tắt chạy nốt, tránh rò sang test sau
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 2_000 });
  });
});
