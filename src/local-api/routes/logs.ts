import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import { PATHS } from '../../lib/paths.js';

const app = new Hono();

app.get('/:id', (c) => {
  const { id } = c.req.param();
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
  const logPath = path.join(PATHS.logs, `${id}.log`);

  try {
    fs.unlinkSync(logPath);
    return c.json({ deleted: true });
  } catch {
    return c.json({ deleted: false });
  }
});

export default app;
