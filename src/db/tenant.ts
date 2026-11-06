// Chạy truy vấn trong transaction có gắn tenant hiện tại cho PostgreSQL Row-Level Security.
// set_config(..., true) chỉ có hiệu lực trong transaction → không rò sang request khác dùng
// lại cùng kết nối trong pool.
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<unknown>;
  release(err?: Error | boolean): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withTenant<T, C extends PgClientLike = PgClientLike>(
  pool: { connect(): Promise<C> },
  tenantId: string,
  fn: (client: C) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error('tenantId phải là UUID');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
