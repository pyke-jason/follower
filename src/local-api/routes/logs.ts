import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { PATHS } from '../../lib/paths.js';

const LogIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid log ID format');

const app = new Hono();

app.get('/:id', (c) => {
  const { id: rawId } = c.req.param();

  let id: string;
  try {
    id = LogIdSchema.parse(rawId);
  } catch {
    return c.json({ error: 'Invalid log ID' }, 400);
  }

  const logPath = path.join(PATHS.logs, `${id}.log`);

  const resolvedPath = path.resolve(logPath);
  const logsDir = path.resolve(PATHS.logs);
  if (!resolvedPath.startsWith(logsDir + path.sep) && resolvedPath !== logsDir) {
    return c.json({ error: 'Invalid log ID' }, 400);
  }

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    return c.text(content);
  } catch {
    return c.text('');
  }
});

app.delete('/:id', (c) => {
  const { id: rawId } = c.req.param();

  let id: string;
  try {
    id = LogIdSchema.parse(rawId);
  } catch {
    return c.json({ error: 'Invalid log ID' }, 400);
  }

  const logPath = path.join(PATHS.logs, `${id}.log`);

  const resolvedPath = path.resolve(logPath);
  const logsDir = path.resolve(PATHS.logs);
  if (!resolvedPath.startsWith(logsDir + path.sep) && resolvedPath !== logsDir) {
    return c.json({ error: 'Invalid log ID' }, 400);
  }

  try {
    fs.unlinkSync(logPath);
    return c.json({ deleted: true });
  } catch {
    return c.json({ deleted: false });
  }
});

export default app;
