import { createHash } from 'node:crypto';

export function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, ' ')          // collapse all whitespace incl &nbsp;
    .replace(/[\s\\\\/|;,!?.:\-'"]+$/, '') // strip trailing punctuation/artifacts
    .trim();
}

export function computeContentHash(normalizedText: string): string {
  return createHash('sha256').update(normalizedText).digest('hex');
}
