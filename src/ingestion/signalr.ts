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

type MessageHandler = (msg: SignalRMessage) => void | Promise<void>;

export async function injectSignalRListener(page: Page, handler: MessageHandler): Promise<void> {
  // Expose the handler to the browser context
  await page.exposeFunction('__onSignalRMessage', (raw: unknown) => {
    return handler(raw as SignalRMessage);
  });

  await page.evaluate(async () => {
    // OneOption uses jQuery SignalR 2.x (not @microsoft/signalr).
    // $.hubConnection() returns the default connection singleton — the page
    // manages its own connection separately, so this one starts disconnected.
    // We must call .start() ourselves to open our own listener connection.
    const win = window as any; // SAFETY: browser-injected global (jQuery SignalR)
    if (win.$ && win.$.hubConnection) {
      const connection = win.$.hubConnection();
      const hub = connection.createHubProxy('chatHub');

      hub.on('addMessage', (msg: unknown) => {
        (window as any).__onSignalRMessage(msg); // SAFETY: browser-injected global via exposeFunction
      });

      if (connection.state !== 1) {
        console.log(`[SignalR] Connection state ${connection.state}, starting...`);
        await new Promise<void>((resolve, reject) => {
          connection.start()
            .done(() => { console.log('[SignalR] Connected via', connection.transport?.name); resolve(); })
            .fail((err: unknown) => { console.error('[SignalR] Connection failed:', err); reject(err); });
        });
      }

      console.log('[SignalR] Hook injected on chatHub.addMessage');
    } else {
      console.warn('[SignalR] jQuery SignalR not found on page');
    }
  });

  console.log('[SignalR] Listener injected');
}
