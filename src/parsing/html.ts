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

  return text;
}
