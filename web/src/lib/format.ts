export function formatCurrency(value: number | string | null | undefined, decimals = 2): string {
  if (value == null) return '--';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '--';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num);
}

/** "$1.2K", "$3.4M" — compact currency for chart axes */
export function formatCurrencyAxis(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    notation: 'compact',
  }).format(value);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '--';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "2:30 PM" — time only */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "Tuesday, January 14, 2025" — full day header for date separators */
export function formatDayHeader(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** "Tue, Jan 15" — short date with weekday for chart tooltips */
export function formatDateTooltip(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** "Jan 15" — compact date-only for timelines and chips */
export function formatDateShort(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

/** "1.2 KB", "3.4 MB" — human-readable byte sizes */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Extract YYYY-MM-DD from an ISO timestamp, or pass through if already a date key */
export function isoToDateKey(iso: string): string {
  return iso.split('T')[0];
}

/** "now", "3m", "2h", "5d" — compact relative time from an ISO timestamp */
export function relativeTime(iso: string | null): string {
  if (!iso) return '--';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function formatRMultiple(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}R`;
}

export function pnlColor(value: number | string | null | undefined): string {
  if (value == null) return 'text-zinc-400';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num) || num === 0) return 'text-muted-foreground';
  return num > 0 ? 'text-profit' : 'text-loss';
}
