// Đọc runtime config từ biến môi trường và kiểm tra bằng Zod ngay khi khởi động.
// Thiếu hoặc sai biến → process dừng ngay với thông báo rõ ràng (fail fast),
// thay vì chạy được nửa chừng rồi lỗi khó hiểu khi có request.
import type { z } from 'zod';

export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Chỉ in tên biến và lý do, KHÔNG in giá trị (có thể là bí mật)
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Cấu hình không hợp lệ:\n${problems}`);
  }
  return result.data;
}

// Chuyển chuỗi "true"/"false"/"1"/"0" của biến môi trường thành boolean
export function envBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
}
