/**
 * Deterministic author colors using HSL with hashed hue.
 * Fixed saturation/lightness tuned for dark theme readability.
 */

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0; // Convert to 32-bit int
  }
  return Math.abs(hash);
}

/** Background color for avatar circle */
export function getAuthorBgColor(name: string): string {
  const hue = hashString(name) % 360;
  return `hsl(${hue}, 65%, 45%)`;
}

/** Text color for author name (brighter for readability on dark bg) */
export function getAuthorTextColor(name: string): string {
  const hue = hashString(name) % 360;
  return `hsl(${hue}, 80%, 85%)`;
}

/** Get 1-2 character initials from author name */
export function getAuthorInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}
