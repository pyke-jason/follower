import type { Page } from 'playwright';

export type SignalRMessage = {
  Id: string;
  MessageText: string;
  User: { Name: string };
  PostTime: string;
  Tag: string;
  Votes: number;
  Reactions: unknown[];
};

export type MessageHandler = (msg: SignalRMessage) => void;

export async function injectSignalRListener(page: Page, handler: MessageHandler): Promise<void> {
  // Expose the handler to the browser context
  await page.exposeFunction('__onSignalRMessage', (raw: unknown) => {
    handler(raw as SignalRMessage);
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
