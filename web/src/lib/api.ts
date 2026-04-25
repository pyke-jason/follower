export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE ?? '/web').replace(/\/+$/, '');

export function toApiUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (normalizedPath === API_BASE || normalizedPath.startsWith(`${API_BASE}/`)) {
    return normalizedPath;
  }
  return `${API_BASE}${normalizedPath}`;
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const url = toApiUrl(path);
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'fetch',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, `${res.status}: ${text}`);
  }
  if (res.headers.get('content-type')?.includes('application/json')) {
    return res.json();
  }
  return res.text() as unknown as T;
}
