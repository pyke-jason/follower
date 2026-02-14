import { load } from 'cheerio';

export function extractSymbols(html: string): string[] {
  const $ = load(html);
  const symbols: string[] = [];

  $('[data-symbol]').each((_, el) => {
    const sym = $(el).attr('data-symbol');
    if (sym && !symbols.includes(sym)) {
      symbols.push(sym.toUpperCase());
    }
  });

  return symbols;
}
