// Health check cho ALB / ECS / Docker:
//  - /health/live  : process còn sống (không kiểm phụ thuộc — tránh restart dây chuyền khi DB chậm)
//  - /health/ready : sẵn sàng nhận request (DB kết nối được, chưa vào trạng thái tắt)
import { Router } from 'express';

export class HealthState {
  ready = false; // true sau khi server listen
  shuttingDown = false; // true khi nhận SIGTERM → readiness trả 503 để bị rút khỏi load balancer
}

export type HealthCheck = () => Promise<unknown>;

export function healthRouter(state: HealthState, checks: Record<string, HealthCheck> = {}, timeoutMs = 1_000): Router {
  const router = Router();

  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/health/ready', async (_req, res) => {
    if (!state.ready || state.shuttingDown) {
      res.status(503).json({ status: state.shuttingDown ? 'shutting_down' : 'starting' });
      return;
    }
    const results: Record<string, 'ok' | 'fail'> = {};
    await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          // Mỗi check tối đa timeoutMs; quá hạn coi như hỏng
          await Promise.race([
            check(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
          ]);
          results[name] = 'ok';
        } catch {
          results[name] = 'fail';
        }
      }),
    );
    const ok = Object.values(results).every((v) => v === 'ok');
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks: results });
  });

  return router;
}
