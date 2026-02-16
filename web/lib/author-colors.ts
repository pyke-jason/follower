/**
 * Deterministic author colors using oklch with hashed hue.
 * Adapts lightness for both light and dark themes.
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
  return `oklch(0.50 0.14 ${hue})`;
}

/**
 * Text color for author name.
 * Returns a CSS color that uses light-dark() to adapt:
 * - Light mode: darker (0.42 lightness) for contrast on sand bg
 * - Dark mode: brighter (0.78 lightness) for contrast on charcoal bg
 */
export function getAuthorTextColor(name: string): string {
  const hue = hashString(name) % 360;
  return `light-dark(oklch(0.42 0.12 ${hue}), oklch(0.78 0.12 ${hue}))`;
}

/** Get 1-2 character initials from author name */
export function getAuthorInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}
