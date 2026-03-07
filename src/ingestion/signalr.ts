import type { Page } from 'playwright';

export type RawReaction = {
  Type: string;
  Users?: string[];
  Count: number;
  ByRoles?: Record<string, number>;
};

export type SignalRMessage = {
  Id: string;
  MessageText: string;
  User: { Name: string };
  PostTime: string;
  Tag: string;
  Votes: number;
  Reactions: RawReaction[];
};

/** Strip user IDs — we only need Type + Count for display. */
export function compactReactions(raw: RawReaction[]): { Type: string; Count: number }[] {
  return raw
    .filter(r => r.Type && r.Count > 0)
    .map(r => ({ Type: r.Type, Count: r.Count }));
}

type MessageHandler = (msg: SignalRMessage) => void | Promise<void>;

let debugCount = 0;

export async function injectSignalRListener(page: Page, handler: MessageHandler): Promise<void> {
  // Use Playwright's native serialization (single object arg).
  // This is the approach that was successfully receiving messages previously.
  await page.exposeFunction('__onSignalRMessage', (raw: unknown) => {
    // Debug: log the raw shape of the first few messages
    if (debugCount < 5) {
      debugCount++;
      try {
        console.log(`[SignalR DEBUG #${debugCount}] raw type=${typeof raw}, value=${JSON.stringify(raw).substring(0, 800)}`);
      } catch {
        console.log(`[SignalR DEBUG #${debugCount}] raw type=${typeof raw}, keys=${typeof raw === 'object' && raw ? Object.keys(raw as Record<string, unknown>).join(',') : 'N/A'}`);
      }
    }

    const msg = normalizeMessage(raw);
    if (!msg) return;

    return handler(msg);
  });

  page.on('console', (consoleMsg) => {
    const text = consoleMsg.text();
    if (text.includes('[SignalR]') || text.includes('[Hook]')) {
      console.log(`[Browser] ${text}`);
    }
  });

  await page.evaluate(async () => {
    // OneOption uses jQuery SignalR 2.x (not @microsoft/signalr).
    // $.hubConnection() creates a new connection.  We create our own,
    // register a hub proxy, and start it.  This approach was previously
    // confirmed to receive addMessage events.
    const win = window as any; // SAFETY: browser-injected global (jQuery SignalR)
    if (win.$ && win.$.hubConnection) {
      const connection = win.$.hubConnection();
      const hub = connection.createHubProxy('chatHub');

      hub.on('addMessage', (msg: unknown) => {
        (window as any).__onSignalRMessage(msg); // SAFETY: browser-injected global via exposeFunction
      });

      if (connection.state !== 1) {
        console.log('[SignalR] Connection state ' + connection.state + ', starting...');
        await new Promise<void>((resolve, reject) => {
          connection.start()
            .done(() => { console.log('[SignalR] Connected via ' + (connection.transport?.name || 'unknown')); resolve(); })
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

/**
 * Normalize whatever the hub sends into our SignalRMessage shape.
 * The hub may use different field names than our type expects.
 */
function normalizeMessage(raw: unknown): SignalRMessage | null {
  if (typeof raw !== 'object' || raw === null) {
    console.log('[SignalR] Non-object message:', typeof raw, String(raw).substring(0, 200));
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // Try multiple field name variants
  const messageText = obj.MessageText ?? obj.Message ?? obj.message ?? obj.Text ?? obj.text;
  if (typeof messageText !== 'string' || !messageText) {
    // Log ALL keys and values so we can understand the shape
    const keys = Object.keys(obj);
    console.log('[SignalR] No text field found. Keys:', keys.join(', '));
    for (const key of keys.slice(0, 10)) {
      const val = obj[key];
      const preview = typeof val === 'object' ? JSON.stringify(val)?.substring(0, 100) : String(val).substring(0, 100);
      console.log(`[SignalR]   ${key} (${typeof val}): ${preview}`);
    }
    return null;
  }

  return {
    Id: String(obj.Id ?? obj.id ?? crypto.randomUUID()),
    MessageText: messageText,
    User: typeof obj.User === 'object' && obj.User !== null
      ? { Name: String((obj.User as Record<string, unknown>).Name ?? '') }
      : { Name: String(obj.Author ?? obj.author ?? obj.UserName ?? obj.userName ?? 'unknown') },
    PostTime: String(obj.PostTime ?? obj.TimeUtc ?? obj.postTime ?? obj.timestamp ?? new Date().toISOString()),
    Tag: String(obj.Tag ?? obj.tag ?? ''),
    Votes: Number(obj.Votes ?? obj.votes ?? 0),
    Reactions: Array.isArray(obj.Reactions ?? obj.reactions) ? (obj.Reactions ?? obj.reactions) as RawReaction[] : [],
  };
}
