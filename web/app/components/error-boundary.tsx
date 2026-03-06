import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { RotateCcw, Home, ChevronDown } from 'lucide-react';

type ErrorBoundaryProps = {
  children: ReactNode;
  /** Compact mode for widget/section boundaries (no home button, smaller) */
  compact?: boolean;
};

type ErrorBoundaryState = {
  error: Error | null;
  showStack: boolean;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, showStack: false };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null, showStack: false });

  render() {
    const { error, showStack } = this.state;
    if (!error) return this.props.children;

    if (this.props.compact) {
      return (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/[0.03] px-4 py-3 text-sm animate-in-up">
          <div className="size-1.5 rounded-full bg-destructive/60 shrink-0" />
          <span className="text-muted-foreground truncate flex-1">{error.message}</span>
          <Button variant="ghost" size="xs" onClick={this.reset}>
            <RotateCcw className="size-3" /> Retry
          </Button>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 animate-in-up">
        {/* Glyphs — a broken grid motif */}
        <div className="flex gap-1 mb-6 opacity-25" aria-hidden>
          <div className="size-2.5 rounded-sm bg-foreground" />
          <div className="size-2.5 rounded-sm bg-foreground/50" />
          <div className="size-2.5 rounded-sm bg-destructive/70" />
          <div className="size-2.5 rounded-sm bg-foreground/50" />
          <div className="size-2.5 rounded-sm bg-foreground" />
        </div>

        <h3 className="text-sm font-semibold text-foreground mb-1">Something broke</h3>
        <p className="text-xs text-muted-foreground mb-5 max-w-md text-center leading-relaxed">
          {error.message}
        </p>

        <div className="flex gap-2 mb-4">
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            <RotateCcw className="size-3" /> Reload
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { this.reset(); window.location.href = '/'; }}>
            <Home className="size-3" /> Home
          </Button>
        </div>

        {/* Expandable stack trace */}
        {error.stack && (
          <button
            onClick={() => this.setState((s) => ({ showStack: !s.showStack }))}
            className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
          >
            <ChevronDown className={`size-3 transition-transform ${showStack ? 'rotate-180' : ''}`} />
            {showStack ? 'Hide' : 'Show'} details
          </button>
        )}
        {showStack && error.stack && (
          <pre className="mt-3 max-w-2xl w-full text-[10px] leading-relaxed text-muted-foreground/60 bg-muted/50 rounded-md border p-3 overflow-auto max-h-48 scrollbar-thin">
            {error.stack}
          </pre>
        )}
      </div>
    );
  }
}
