import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { AlertTriangle, RotateCcw, Home, ChevronDown } from 'lucide-react';

type ErrorBoundaryProps = {
  children: ReactNode;
  /** Compact mode for widget/section boundaries (no home button, smaller) */
  compact?: boolean;
};

type ErrorBoundaryState = {
  error: Error | null;
  detailsOpen: boolean;
};

/**
 * React class-component error boundary.
 *
 * - Full mode: centered Card with icon, truncated message, collapsible stack
 *   trace (via Radix Collapsible), Try Again + Home buttons.
 * - Compact mode: inline banner with message + Retry button for
 *   widget-level boundaries.
 *
 * "Try Again" resets the boundary state so React re-attempts rendering
 * the children tree.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, detailsOpen: false };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null, detailsOpen: false });

  render() {
    const { error, detailsOpen } = this.state;
    if (!error) return this.props.children;

    /* ── Compact mode ─────────────────────────────────────────── */
    if (this.props.compact) {
      return (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/[0.03] px-4 py-3 text-sm animate-in-up">
          <AlertTriangle className="size-4 text-destructive/70 shrink-0" />
          <span className="text-muted-foreground truncate flex-1">
            {error.message}
          </span>
          <Button variant="ghost" size="xs" onClick={this.reset}>
            <RotateCcw className="size-3" /> Retry
          </Button>
        </div>
      );
    }

    /* ── Full mode ────────────────────────────────────────────── */
    const truncatedMessage =
      error.message.length > 200
        ? error.message.slice(0, 200) + '...'
        : error.message;

    return (
      <div className="flex items-center justify-center py-16 px-6 animate-in-up">
        <Card className="w-full max-w-lg shadow-warm">
          <CardContent className="flex flex-col items-center text-center pt-2">
            {/* Error icon */}
            <div className="flex items-center justify-center size-12 rounded-full bg-destructive/10 mb-4">
              <AlertTriangle className="size-6 text-destructive" />
            </div>

            {/* Heading */}
            <h3 className="text-base font-semibold text-foreground mb-1">
              Something went wrong
            </h3>

            {/* Truncated error message */}
            <p className="text-sm text-muted-foreground mb-6 max-w-md leading-relaxed">
              {truncatedMessage}
            </p>

            {/* Action buttons */}
            <div className="flex gap-2 mb-4">
              <Button variant="outline" size="sm" onClick={this.reset}>
                <RotateCcw className="size-3.5" /> Try Again
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  this.reset();
                  window.location.href = '/';
                }}
              >
                <Home className="size-3.5" /> Home
              </Button>
            </div>

            {/* Collapsible stack trace */}
            {error.stack && (
              <Collapsible
                open={detailsOpen}
                onOpenChange={(open) => this.setState({ detailsOpen: open })}
                className="w-full"
              >
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-[11px] text-muted-foreground/60 hover:text-muted-foreground mx-auto"
                  >
                    <ChevronDown
                      className={`size-3 transition-transform duration-200 ${
                        detailsOpen ? 'rotate-180' : ''
                      }`}
                    />
                    {detailsOpen ? 'Hide' : 'Show'} details
                  </Button>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  <pre className="mt-3 w-full text-[11px] leading-relaxed text-muted-foreground/70 bg-muted/50 rounded-md border p-3 overflow-auto max-h-56 scrollbar-thin text-left whitespace-pre-wrap break-all">
                    {error.stack}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }
}
