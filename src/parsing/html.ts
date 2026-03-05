import { load } from 'cheerio';

export function htmlToCleanText(html: string): string {
  const $ = load(html);

  // Remove blockquotes (quoted replies)
  $('blockquote').remove();

  // Get text content
  let text = $('body').text() || $.text();

  // Normalize whitespace
  text = text
    .replace(/\u00a0/g, ' ')     // &nbsp;
    .replace(/\s+/g, ' ')
    .trim();

  // Strip trailing Discord artifacts: backslash, forward slash, and trailing
  // punctuation sequences (e.g. the trailing " \" in edited Discord messages)
  text = text.replace(/[\s\\\/;,!?.]+$/, '');

  return text;
}

/**
 * Convert Discord HTML to LLM-ready text with inline badge markers.
 *
 * Replaces badge spans with XML-style markers so the model sees
 * structured metadata rather than plain English words that look like
 * trade directions. E.g.:
 *
 *   <span class="badge bg-success">Long</span> BE sold Oct $59 put
 *   → <LONG BADGE /> BE sold Oct $59 put
 *
 * This prevents the LLM from treating "Long" as a trade-direction word
 * when it is actually a bullish stock-view badge (and the verb "sold"
 * indicates direction SHORT).
 */
export function htmlToLLMText(html: string): string {
  const $ = load(html);

  // Remove blockquotes (quoted replies)
  $('blockquote').remove();

  // Replace each badge span with a clearly-marked XML tag before extracting text
  $('span.badge').each((_, el) => {
    const badgeText = $(el).text().trim().toUpperCase();
    $(el).replaceWith(badgeText ? `<${badgeText} BADGE /> ` : '');
  });

  let text = $('body').text() || $.text();

  text = text
    .replace(/\u00a0/g, ' ')     // &nbsp;
    .replace(/\s+/g, ' ')
    .trim();

  return text;
}
