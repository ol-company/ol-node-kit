import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { HealthState, healthRouter, type HealthCheck } from '../src/index.js';

function buildApp(state: HealthState, checks?: Record<string, HealthCheck>, timeoutMs?: number) {
  const app = express();
  app.use(healthRouter(state, checks, timeoutMs));
  return app;
}

const readyState = () => Object.assign(new HealthState(), { ready: true });

describe('HealthState', () => {
  it('mặc định chưa sẵn sàng và chưa tắt', () => {
    expect(new HealthState()).toMatchObject({ ready: false, shuttingDown: false });
  });
});

describe('GET /health/live', () => {
  it('luôn 200, kể cả khi chưa sẵn sàng hay đang tắt', async () => {
    const state = Object.assign(new HealthState(), { shuttingDown: true });
    const res = await request(buildApp(state)).get('/health/live').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('không chạy các check phụ thuộc', async () => {
    let called = false;
    const checks = {
      db: async () => {
        called = true;
      },
    };
    await request(buildApp(readyState(), checks)).get('/health/live').expect(200);
    expect(called).toBe(false);
  });
});

describe('GET /health/ready', () => {
  it('chưa listen xong → 503 starting', async () => {
    const res = await request(buildApp(new HealthState())).get('/health/ready').expect(503);
    expect(res.body).toEqual({ status: 'starting' });
  });

  it('đang tắt → 503 shutting_down (ưu tiên hơn starting)', async () => {
    const state = Object.assign(new HealthState(), { ready: true, shuttingDown: true });
    const res = await request(buildApp(state)).get('/health/ready').expect(503);
    expect(res.body).toEqual({ status: 'shutting_down' });

    const notReady = Object.assign(new HealthState(), { shuttingDown: true });
    const res2 = await request(buildApp(notReady)).get('/health/ready').expect(503);
    expect(res2.body).toEqual({ status: 'shutting_down' });
  });

  it('không có check nào → 200', async () => {
    const res = await request(buildApp(readyState())).get('/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: {} });
  });

  it('mọi check đạt → 200 kèm kết quả từng check', async () => {
    const checks = { db: async () => 'ok', cache: async () => undefined };
    const res = await request(buildApp(readyState(), checks)).get('/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { db: 'ok', cache: 'ok' } });
  });

  it('một check reject → 503 degraded, check khác vẫn được báo ok', async () => {
    const checks = {
      db: async () => {
        throw new Error('connection refused');
      },
      cache: async () => 'ok',
    };
    const res = await request(buildApp(readyState(), checks)).get('/health/ready').expect(503);
    expect(res.body).toEqual({ status: 'degraded', checks: { db: 'fail', cache: 'ok' } });
  });

  it('check ném lỗi đồng bộ cũng tính là fail', async () => {
    const checks: Record<string, HealthCheck> = {
      db: () => {
        throw new Error('lỗi đồng bộ');
      },
    };
    const res = await request(buildApp(readyState(), checks)).get('/health/ready').expect(503);
    expect(res.body.checks).toEqual({ db: 'fail' });
  });

  it('check chậm quá timeout → fail', async () => {
    const checks = { db: () => new Promise(() => undefined) }; // Không bao giờ xong
    const res = await request(buildApp(readyState(), checks, 20))
      .get('/health/ready')
      .expect(503);
    expect(res.body).toEqual({ status: 'degraded', checks: { db: 'fail' } });
  });

  it('check xong trong hạn timeout → ok', async () => {
    const checks = { db: () => new Promise((resolve) => setTimeout(resolve, 5)) };
    const res = await request(buildApp(readyState(), checks, 500))
      .get('/health/ready')
      .expect(200);
    expect(res.body.checks).toEqual({ db: 'ok' });
  });
});
