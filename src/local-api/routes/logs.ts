import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { PATHS } from '@/lib/paths.js';
import { assertSafeRunId } from '@/lib/channel.js';

const app = new Hono();

app.get('/:id', (c) => {
  const { id } = c.req.param();
  try {
    assertSafeRunId(id);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  const logPath = path.join(PATHS.logs, `${id}.log`);

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    return c.text(content);
  } catch {
    return c.text('');
  }
});

app.delete('/:id', (c) => {
  const { id } = c.req.param();
  try {
    assertSafeRunId(id);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  const logPath = path.join(PATHS.logs, `${id}.log`);

  try {
    fs.unlinkSync(logPath);
    return c.json({ deleted: true });
  } catch {
    return c.json({ deleted: false });
  }
});

export default app;
