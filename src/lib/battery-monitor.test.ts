import { describe, it, expect } from 'vitest';
import { parseBattery } from './battery-monitor.js';

describe('parseBattery', () => {
  it('parses discharging on battery power', () => {
    const out = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=20643939)\t12%; discharging; 0:42 remaining present: true`;
    expect(parseBattery(out)).toEqual({
      onBattery: true,
      charging: false,
      percent: 12,
      minutesRemaining: 42,
    });
  });

  it('parses charging on AC with hours+minutes remaining', () => {
    const out = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=20643939)\t2%; charging; 2:21 remaining present: true`;
    expect(parseBattery(out)).toEqual({
      onBattery: false,
      charging: true,
      percent: 2,
      minutesRemaining: 141,
    });
  });

  it('parses charged on AC (no time field)', () => {
    const out = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=20643939)\t100%; charged; 0:00 remaining present: true`;
    expect(parseBattery(out)).toEqual({
      onBattery: false,
      charging: true,
      percent: 100,
      minutesRemaining: 0,
    });
  });

  it('returns null on garbage input', () => {
    expect(parseBattery('')).toBeNull();
    expect(parseBattery('nothing here')).toBeNull();
  });
});
