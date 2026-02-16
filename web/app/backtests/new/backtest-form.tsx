'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { startBacktest } from '../actions';
import Link from 'next/link';
import type { BacktestRunConfig } from '../../../../src/db/schema';

const MODELS_BY_PROVIDER: Record<string, string[]> = {
  anthropic: [
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-6',
  ],
  xai: [
    'grok-4-1-fast-reasoning',
    'grok-4-1-fast-non-reasoning',
  ],
};

export function BacktestForm({
  defaultTraders,
  defaultConfig,
}: {
  defaultTraders: string;
  defaultConfig?: BacktestRunConfig;
}) {
  const [provider, setProvider] = useState(defaultConfig?.agentProvider ?? 'anthropic');
  const [model, setModel] = useState(
    defaultConfig?.agentModel ?? MODELS_BY_PROVIDER[defaultConfig?.agentProvider ?? 'anthropic']?.[0] ?? MODELS_BY_PROVIDER.anthropic[0],
  );

  function handleProviderChange(value: string) {
    setProvider(value);
    setModel(MODELS_BY_PROVIDER[value][0]);
  }

  return (
    <form action={startBacktest} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs text-muted-foreground mb-1">Start Date</Label>
          <Input
            name="startDate"
            type="date"
            required
            defaultValue={defaultConfig?.startDate?.split('T')[0] ?? '2025-09-01'}
            className="h-9"
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground mb-1">End Date</Label>
          <Input
            name="endDate"
            type="date"
            required
            defaultValue={defaultConfig?.endDate?.split('T')[0] ?? '2025-12-27'}
            className="h-9"
          />
        </div>
      </div>

      <div>
        <Label className="text-xs text-muted-foreground mb-1">Traders (comma-separated)</Label>
        <Input
          name="traders"
          required
          placeholder="Dave W, Hariseldon, Pete"
          defaultValue={defaultConfig?.traders?.join(', ') ?? defaultTraders}
          className="h-9"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs text-muted-foreground mb-1">Agent Provider</Label>
          <input type="hidden" name="agentProvider" value={provider} />
          <Select value={provider} onValueChange={handleProviderChange}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">Anthropic</SelectItem>
              <SelectItem value="xai">xAI (Grok)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground mb-1">Agent Model</Label>
          <input type="hidden" name="agentModel" value={model} />
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODELS_BY_PROVIDER[provider].map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Switch name="useQuoteTape" id="useQuoteTape" defaultChecked={defaultConfig?.useQuoteTape ?? true} />
        <Label htmlFor="useQuoteTape" className="text-sm">Use quote tape (Databento)</Label>
      </div>

      <div className="flex gap-2 pt-2">
        <Button type="submit">Start Backtest</Button>
        <Button type="button" variant="ghost" asChild>
          <Link href="/backtests">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
