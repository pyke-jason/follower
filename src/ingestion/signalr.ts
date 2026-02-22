import type { Page } from 'playwright';
import { z } from 'zod';
import { createLogger } from '../lib/logger.js';

const log = createLogger('SignalR');

const SignalRMessageSchema = z.object({
  Id: z.string(),
  MessageText: z.string(),
  User: z.object({ Name: z.string() }),
  PostTime: z.string(),
  Tag: z.string(),
  Votes: z.number(),
  Reactions: z.array(z.unknown()),
});

export type SignalRMessage = z.infer<typeof SignalRMessageSchema>;

export type MessageHandler = (msg: SignalRMessage) => void;

export async function injectSignalRListener(page: Page, handler: MessageHandler): Promise<void> {
  // Expose the handler to the browser context
  await page.exposeFunction('__onSignalRMessage', (raw: unknown) => {
    const parsed = SignalRMessageSchema.safeParse(raw);
    if (!parsed.success) {
      log.error('[SignalR] Invalid message shape:', parsed.error.message);
      return;
    }
    handler(parsed.data);
  });

  await page.evaluate(() => {
    // OneOption uses jQuery SignalR (not @microsoft/signalr)
    const win = window as any;
    if (win.$ && win.$.hubConnection) {
      const connection = win.$.hubConnection();
      const hub = connection.createHubProxy('chatHub');

      hub.on('addMessage', (msg: unknown) => {
        (window as any).__onSignalRMessage(msg);
      });

      console.log('[SignalR] Hook injected on chatHub.addMessage');
    } else {
      console.warn('[SignalR] jQuery SignalR not found on page');
    }
  });

  console.log('[SignalR] Listener injected');
}
