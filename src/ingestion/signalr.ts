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

export type ReactionUpdate = {
  messageId: string;
  reactions: { Type: string; Count: number }[];
};

type MessageHandler = (msg: SignalRMessage) => void | Promise<void>;
type ReactionHandler = (update: ReactionUpdate) => void | Promise<void>;

export type SignalRInjectionStatus = {
  signalRAvailable: boolean;
  addMessageConnected: boolean;
  reactionProxyAttached: boolean;
  transportName: string | null;
  connectionState: number | null;
  existingConnectionState: number | null;
  details: string;
};

export function isSignalRSubscriptionReady(status: SignalRInjectionStatus): boolean {
  // Reaction proxy is a nice-to-have: it carries `updateMessageReactions`
  // events for emoji reactions on existing messages. Production trade
  // parsing/classification code does not consume reactions (only test
  // fixtures do), and the page only attaches a chatHub proxy after the
  // user has joined a specific chat room.
  //
  // Treating its absence as "subscription degraded" caused a 30s→10m
  // exponential-backoff browser-restart loop and a CRITICAL alert per
  // cycle, all chasing a capability we never use. Real-time message
  // ingestion works through the secondary SignalR connection's
  // addMessage handler, which only requires `addMessageConnected`.
  return status.signalRAvailable && status.addMessageConnected;
}

export async function injectSignalRListener(
  page: Page,
  handler: MessageHandler,
  onReaction?: ReactionHandler,
  opts: { skipBridgeExpose?: boolean } = {},
): Promise<SignalRInjectionStatus> {
  if (!opts.skipBridgeExpose) {
    await page.exposeFunction('__onSignalRMessage', (raw: unknown) => {
      const msg = normalizeMessage(raw);
      if (!msg) return;

      return handler(msg);
    });

    await page.exposeFunction('__onReactionUpdate', (id: unknown, reactions: unknown) => {
      if (!onReaction) return;
      const compacted = Array.isArray(reactions) ? compactReactions(reactions as RawReaction[]) : [];
      return onReaction({ messageId: String(id), reactions: compacted });
    });

    page.on('console', (consoleMsg) => {
      const text = consoleMsg.text();
      if (text.includes('[SignalR]') || text.includes('[Hook]')) {
        console.log(`[Browser] ${text}`);
      }
    });
  }

  try {
    await page.waitForFunction(
      () => Boolean((window as unknown as { $?: { hubConnection?: unknown } }).$?.hubConnection),
      undefined,
      { timeout: 30_000 },
    );
  } catch {
    console.warn('[SignalR] Timed out waiting for jQuery SignalR on page');
  }

  // Wait for the page's own app code to create $.connection.chatHub. The proxy
  // is created lazily the first time the app accesses it; until then reactions
  // can't be attached. domcontentloaded resolves before app JS runs, so this
  // gap is normal — give it 20s before declaring the subscription degraded.
  try {
    await page.waitForFunction(
      () => {
        const conn = (window as unknown as { $?: { connection?: { chatHub?: { on?: unknown } } } }).$?.connection;
        return Boolean(conn?.chatHub && typeof conn.chatHub.on === 'function');
      },
      undefined,
      { timeout: 20_000 },
    );
  } catch {
    console.warn('[SignalR] Timed out waiting for page chatHub proxy');
  }

  const status = await page.evaluate(async (): Promise<SignalRInjectionStatus> => {
    // OneOption uses jQuery SignalR 2.x (not @microsoft/signalr).
    // $.hubConnection() creates a NEW connection each call. Our 2nd connection
    // receives addMessage (broadcast to Clients.All) but NOT updateMessageReactions
    // (broadcast to a room group the 2nd connection never joined).
    //
    // Strategy: 2nd connection for addMessage, app's existing proxy for reactions.
    const win = window as any; // SAFETY: browser-injected global (jQuery SignalR)
    if (!win.$ || !win.$.hubConnection) {
      console.warn('[SignalR] jQuery SignalR not found on page');
      return {
        signalRAvailable: false,
        addMessageConnected: false,
        reactionProxyAttached: false,
        transportName: null,
        connectionState: null,
        existingConnectionState: null,
        details: 'jQuery SignalR not found on page',
      };
    }

    // ── addMessage: new connection (works, broadcast to all clients) ──
    const connection = win.$.hubConnection();
    const hub = connection.createHubProxy('chatHub');

    hub.on('addMessage', (msg: unknown) => {
      (window as any).__onSignalRMessage(msg); // SAFETY: browser-injected global via exposeFunction
    });

    if (connection.state !== 1) {
      console.log('[SignalR] Connection state ' + connection.state + ', starting...');
      const connected = await new Promise<boolean>((resolve) => {
        connection.start()
          .done(() => {
            console.log('[SignalR] Connected via ' + (connection.transport?.name || 'unknown'));
            resolve(true);
          })
          .fail((err: unknown) => {
            console.error('[SignalR] Connection failed:', err);
            resolve(false);
          });
      });

      if (!connected) {
        return {
          signalRAvailable: true,
          addMessageConnected: false,
          reactionProxyAttached: false,
          transportName: null,
          connectionState: typeof connection.state === 'number' ? connection.state : null,
          existingConnectionState: typeof win.$.connection?.hub?.state === 'number' ? win.$.connection.hub.state : null,
          details: 'SignalR addMessage connection failed to start',
        };
      }
    }

    // ── updateMessageReactions: app's existing proxy (joined to room group) ──
    const existingProxy = win.$.connection?.chatHub;
    const reactionProxyAttached = Boolean(existingProxy && typeof existingProxy.on === 'function');
    if (reactionProxyAttached) {
      existingProxy.on('updateMessageReactions', (id: unknown, reactions: unknown) => {
        (window as any).__onReactionUpdate(id, reactions); // SAFETY: browser-injected global via exposeFunction
      });
      console.log('[SignalR] Hook injected: addMessage (new conn) + updateMessageReactions (existing proxy)');
    } else {
      console.warn('[SignalR] No existing chatHub proxy found — page may not be joined to the chat room');
      console.log('[SignalR] $.connection keys:', Object.keys(win.$.connection || {}).join(', '));
      console.log('[SignalR] Hook injected: addMessage only (new conn)');
    }

    return {
      signalRAvailable: true,
      addMessageConnected: true,
      reactionProxyAttached,
      transportName: typeof connection.transport?.name === 'string' ? connection.transport.name : null,
      connectionState: typeof connection.state === 'number' ? connection.state : null,
      existingConnectionState: typeof win.$.connection?.hub?.state === 'number' ? win.$.connection.hub.state : null,
      details: reactionProxyAttached
        ? 'SignalR listener and chat-room proxy attached'
        : 'SignalR listener attached, but page chat-room proxy is missing',
    };
  });

  console.log('[SignalR] Listener injected');
  return status;
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
