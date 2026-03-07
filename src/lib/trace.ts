export type SpanCategory = 'sync' | 'db' | 'broker' | 'llm' | 'market_data';

export type Span = {
  name: string;
  category: SpanCategory;
  startMs: number;
  durationMs: number;
  children: Span[];
};

export type TraceContext = {
  startSpan(name: string, category: SpanCategory): { stop(): void };
  getSpans(): Span[];
};

export function createTrace(): TraceContext {
  const root: Span[] = [];
  const stack: Span[] = [];
  const origin = performance.now();

  return {
    startSpan(name: string, category: SpanCategory) {
      const span: Span = {
        name,
        category,
        startMs: performance.now() - origin,
        durationMs: 0,
        children: [],
      };

      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children.push(span);
      } else {
        root.push(span);
      }
      stack.push(span);

      return {
        stop() {
          span.durationMs = performance.now() - origin - span.startMs;
          const idx = stack.lastIndexOf(span);
          if (idx !== -1) stack.splice(idx, 1);
        },
      };
    },

    getSpans() {
      return root;
    },
  };
}

/** Compute the total duration (ms) covered by a span tree. */
export function maxEnd(spans: Span[]): number {
  return spans.reduce((max, s) => {
    const end = s.startMs + s.durationMs;
    const childMax = s.children.length > 0 ? maxEnd(s.children) : 0;
    return Math.max(max, end, childMax);
  }, 0);
}

/** Run `fn` inside a named span. No-op passthrough when trace is absent. */
export function traced<T>(
  trace: TraceContext | undefined,
  name: string,
  category: SpanCategory,
  fn: () => T,
): T {
  if (!trace) return fn();
  const s = trace.startSpan(name, category);
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        (v) => { s.stop(); return v; },
        (e) => { s.stop(); throw e; },
      ) as T;
    }
    s.stop();
    return result;
  } catch (e) {
    s.stop();
    throw e;
  }
}
