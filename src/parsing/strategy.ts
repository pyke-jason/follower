import type { DetectedStrategy } from '../db/schema.js';

// ─── CDS: "MSTR CDS $180/$190 for $2.56" or "215/220c cds for 2.14" ───
const CDS_PATTERN = /(?:CDS|call\s*debit\s*spread|call\s*spread)\s*\$?(\d+\.?\d*)\s*\/\s*\$?(\d+\.?\d*)/i;
const CDS_ALT_PATTERN = /(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)\s*c?\s*(?:CDS|cds)/i;

// ─── PDS: "SPOT 570/565 PDS for $2.05" or "257.5/252.5p pds for 1.66" ───
const PDS_PATTERN = /(?:PDS|put\s*debit\s*spread|put\s*spread)\s*\$?(\d+\.?\d*)\s*\/\s*\$?(\d+\.?\d*)/i;
const PDS_ALT_PATTERN = /(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)\s*p?\s*(?:PDS|pds)/i;

// ─── Single call: "625 call 8.65" or "$232.5 Calls" or "37c" ───
const CALL_PATTERN = /\$?(\d+\.?\d*)\s*(?:calls?|c\b)/i;

// ─── Single put: "410 put 7.52" or "$28 puts" ───
const PUT_PATTERN = /\$?(\d+\.?\d*)\s*(?:puts?|p\b)/i;

// ─── Price: "for $2.56" or "at 2.15" or trailing price "73.41" ───
const PRICE_PATTERN = /(?:for|at|@)\s*\$?(\d+\.?\d*)/i;

// ─── Quantity: "20 Contracts" or "1,000 Shares" ───
const QTY_CONTRACTS_PATTERN = /(\d+)\s*(?:contracts?|cts?)/i;
const QTY_SHARES_PATTERN = /([\d,]+)\s*shares?/i;

// ─── Expiry: "Dec 19" or "9/12" or "12/5" or "21Nov25" ───
const EXPIRY_MONTH_DAY = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{1,2})\b/i;
const EXPIRY_SLASH = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;

export function detectStrategies(cleanText: string, symbols: string[]): DetectedStrategy[] {
  const strategies: DetectedStrategy[] = [];
  const text = cleanText;

  // Try CDS
  const cdsMatch = text.match(CDS_PATTERN) || text.match(CDS_ALT_PATTERN);
  if (cdsMatch) {
    const strikes = [parseFloat(cdsMatch[1]), parseFloat(cdsMatch[2])].sort((a, b) => a - b);
    strategies.push({
      strategy: 'CDS',
      confidence: 0.9,
      strikes,
      price: extractPrice(text),
      quantity: extractQuantity(text),
      expiry: extractExpiry(text),
    });
    return strategies;
  }

  // Try PDS
  const pdsMatch = text.match(PDS_PATTERN) || text.match(PDS_ALT_PATTERN);
  if (pdsMatch) {
    const strikes = [parseFloat(pdsMatch[1]), parseFloat(pdsMatch[2])].sort((a, b) => b - a);
    strategies.push({
      strategy: 'PDS',
      confidence: 0.9,
      strikes,
      price: extractPrice(text),
      quantity: extractQuantity(text),
      expiry: extractExpiry(text),
    });
    return strategies;
  }

  // Try single call
  const callMatch = text.match(CALL_PATTERN);
  if (callMatch && !text.match(/call\s*(?:debit|spread|credit)/i)) {
    strategies.push({
      strategy: 'CALL',
      confidence: 0.85,
      strikes: [parseFloat(callMatch[1])],
      price: extractPrice(text),
      quantity: extractQuantity(text),
      expiry: extractExpiry(text),
    });
    return strategies;
  }

  // Try single put
  const putMatch = text.match(PUT_PATTERN);
  if (putMatch && !text.match(/put\s*(?:debit|spread|credit)/i)) {
    strategies.push({
      strategy: 'PUT',
      confidence: 0.85,
      strikes: [parseFloat(putMatch[1])],
      price: extractPrice(text),
      quantity: extractQuantity(text),
      expiry: extractExpiry(text),
    });
    return strategies;
  }

  // Stock trade: has symbol, has price, but no options keywords
  if (symbols.length > 0) {
    const priceMatch = text.match(/\$?([\d,]+\.?\d*)/);
    if (priceMatch) {
      const hasOptionsKeywords = /(?:call|put|cds|pds|spread|strike|expir|contract)/i.test(text);
      if (!hasOptionsKeywords) {
        strategies.push({
          strategy: 'STOCK',
          confidence: 0.8,
          price: parseFloat(priceMatch[1].replace(/,/g, '')),
          quantity: extractShareQuantity(text),
        });
        return strategies;
      }
    }
  }

  return strategies;
}

function extractPrice(text: string): number | undefined {
  const match = text.match(PRICE_PATTERN);
  return match ? parseFloat(match[1]) : undefined;
}

function extractQuantity(text: string): number | undefined {
  const match = text.match(QTY_CONTRACTS_PATTERN);
  return match ? parseInt(match[1]) : undefined;
}

function extractShareQuantity(text: string): number | undefined {
  const match = text.match(QTY_SHARES_PATTERN);
  return match ? parseInt(match[1].replace(/,/g, '')) : undefined;
}

function extractExpiry(text: string): string | undefined {
  const monthMatch = text.match(EXPIRY_MONTH_DAY);
  if (monthMatch) {
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const month = months[monthMatch[1].toLowerCase()];
    const day = monthMatch[2].padStart(2, '0');
    const year = new Date().getFullYear();
    return `${year}-${month}-${day}`;
  }

  // Don't try slash patterns - too ambiguous with strikes like 570/565
  return undefined;
}
