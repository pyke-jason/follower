// Custom helpers instead of @hono/zod-validator: that package lags Zod v4
// (honojs/middleware#1148). Revisit once it ships v4 support.

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}

export async function validateBody<T extends z.ZodType>(schema: T, c: Context): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, { message: formatIssues(parsed.error) });
  }
  return parsed.data;
}

export function validateQuery<T extends z.ZodType>(schema: T, c: Context): z.infer<T> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new HTTPException(400, { message: formatIssues(parsed.error) });
  }
  return parsed.data;
}

export function validateParams<T extends z.ZodType>(schema: T, c: Context): z.infer<T> {
  const parsed = schema.safeParse(c.req.param());
  if (!parsed.success) {
    throw new HTTPException(400, { message: formatIssues(parsed.error) });
  }
  return parsed.data;
}
