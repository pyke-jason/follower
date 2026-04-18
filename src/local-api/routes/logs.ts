import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { PATHS } from '@/lib/paths.js';
import { validateParams } from '../validate.js';
import { RunIdParamsSchema } from '../http-schemas.js';

const app = new Hono();

app.get('/:id', (c) => {
  const { id } = validateParams(RunIdParamsSchema, c);
  const logPath = path.join(PATHS.logs, `${id}.log`);

  try {
    return c.text(fs.readFileSync(logPath, 'utf-8'));
  } catch {
    return c.text('');
  }
});

app.delete('/:id', (c) => {
  const { id } = validateParams(RunIdParamsSchema, c);
  const logPath = path.join(PATHS.logs, `${id}.log`);

  try {
    fs.unlinkSync(logPath);
    return c.json({ deleted: true });
  } catch {
    return c.json({ deleted: false });
  }
});

export default app;
