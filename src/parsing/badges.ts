import { load } from 'cheerio';
import type { ActionHint, Direction } from '../lib/enums.js';

export type BadgeInfo = {
  badges: string[];          // ['Long'], ['Short'], ['Exit', 'Long'], etc.
  actionHint: ActionHint | null;
  directionHint: Direction | null;
};

const BADGE_MAP: Record<string, { direction?: Direction; action?: ActionHint }> = {
  'Long':  { direction: 'LONG', action: 'OPEN' },
  'Short': { direction: 'SHORT', action: 'OPEN' },
  'Exit':  { action: 'CLOSE' },
};

export function extractBadges(html: string): BadgeInfo {
  const $ = load(html);
  const badges: string[] = [];

  $('span.badge').each((_, el) => {
    const text = $(el).text().trim();
    if (text) badges.push(text);
  });

  let actionHint: ActionHint | null = null;
  let directionHint: Direction | null = null;

  for (const badge of badges) {
    const info = BADGE_MAP[badge];
    if (!info) continue;
    if (info.action === 'CLOSE') actionHint = 'CLOSE';
    if (info.direction) directionHint = info.direction;
  }

  // If we have Exit + direction but no standalone open, it's a close
  if (badges.includes('Exit') && !actionHint) {
    actionHint = 'CLOSE';
  }

  // If we only have Long or Short (no Exit), it's an open
  if (!actionHint && directionHint) {
    actionHint = 'OPEN';
  }

  return { badges, actionHint, directionHint };
}
