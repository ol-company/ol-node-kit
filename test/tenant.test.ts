import { describe, expect, it, vi } from 'vitest';
import { withTenant } from '../src/index.js';

const TENANT = '123e4567-e89b-42d3-a456-426614174000';
const SET_TENANT = "SELECT set_config('app.tenant_id', $1, true)";

function fakePool(failOn?: string) {
  const client = {
    query: vi.fn(async (text: string, _values?: unknown[]) => {
      if (text === failOn) throw new Error(`${text} lỗi`);
      return undefined as unknown;
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) };
  return { pool, client };
}

const statements = (client: ReturnType<typeof fakePool>['client']) =>
  client.query.mock.calls.map(([text]) => text);

describe('withTenant', () => {
  it('chạy trong transaction: BEGIN → gắn tenant → fn → COMMIT → release', async () => {
    const { pool, client } = fakePool();
    const result = await withTenant(pool, TENANT, async (c) => {
      expect(c).toBe(client);
      await c.query('SELECT 1');
      return 'kết quả';
    });

    expect(result).toBe('kết quả');
    expect(statements(client)).toEqual(['BEGIN', SET_TENANT, 'SELECT 1', 'COMMIT']);
    expect(client.query).toHaveBeenNthCalledWith(2, SET_TENANT, [TENANT]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('chấp nhận UUID viết hoa', async () => {
    const { pool } = fakePool();
    await expect(withTenant(pool, TENANT.toUpperCase(), async () => 'ok')).resolves.toBe('ok');
  });

  it('fn lỗi → ROLLBACK, không COMMIT, ném lại đúng lỗi gốc, vẫn release', async () => {
    const { pool, client } = fakePool();
    const boom = new Error('nghiệp vụ lỗi');
    await expect(
      withTenant(pool, TENANT, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(statements(client)).toEqual(['BEGIN', SET_TENANT, 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('ROLLBACK cũng lỗi → vẫn ném lỗi gốc, không bị lỗi ROLLBACK che mất', async () => {
    const { pool, client } = fakePool('ROLLBACK');
    const boom = new Error('nghiệp vụ lỗi');
    await expect(
      withTenant(pool, TENANT, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('COMMIT lỗi → ROLLBACK và ném lỗi COMMIT', async () => {
    const { pool, client } = fakePool('COMMIT');
    await expect(withTenant(pool, TENANT, async () => 'x')).rejects.toThrow('COMMIT lỗi');
    expect(statements(client)).toEqual(['BEGIN', SET_TENANT, 'COMMIT', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'abc', 't1', "' OR 1=1 --", '123e4567-e89b-42d3-a456-42661417400'])(
    'tenantId "%s" không phải UUID → từ chối, không lấy kết nối',
    async (tenantId) => {
      const { pool } = fakePool();
      const fn = vi.fn();
      await expect(withTenant(pool, tenantId, fn)).rejects.toThrow('tenantId phải là UUID');
      expect(pool.connect).not.toHaveBeenCalled();
      expect(fn).not.toHaveBeenCalled();
    },
  );
});
