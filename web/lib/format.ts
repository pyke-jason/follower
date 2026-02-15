export function formatCurrency(value: number | string | null | undefined): string {
  if (value == null) return '--';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) return '--';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(num);
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

export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return '--';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
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

export function pnlColor(value: number | string | null | undefined): string {
  if (value == null) return 'text-zinc-400';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num) || num === 0) return 'text-zinc-400';
  return num > 0 ? 'text-emerald-400' : 'text-red-400';
}
