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

const MODELS_BY_PROVIDER: Record<string, string[]> = {
  anthropic: [
    'claude-sonnet-4-5-20250929',
    'claude-haiku-4-5-20251001',
  ],
  xai: [
    'grok-3',
    'grok-3-mini',
  ],
};

export function BacktestForm({ defaultTraders }: { defaultTraders: string }) {
  const [useAgent, setUseAgent] = useState(false);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState(MODELS_BY_PROVIDER.anthropic[0]);

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
            defaultValue="2025-09-01"
            className="h-9"
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground mb-1">End Date</Label>
          <Input
            name="endDate"
            type="date"
            required
            defaultValue="2025-12-27"
            className="h-9"
          />
        </div>
      </div>

      <div>
        <Label className="text-xs text-muted-foreground mb-1">Traders (comma-separated)</Label>
        <Input
          name="traders"
          required
          placeholder="Arethra, Pete"
          defaultValue={defaultTraders}
          className="h-9"
        />
      </div>

      <div className="flex items-center gap-3">
        <Switch
          name="useAgent"
          id="useAgent"
          checked={useAgent}
          onCheckedChange={setUseAgent}
        />
        <Label htmlFor="useAgent" className="text-sm">Use agent for low-confidence messages</Label>
      </div>

      {useAgent && (
        <>
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
        </>
      )}

      <div className="flex items-center gap-3">
        <Switch name="useQuoteTape" id="useQuoteTape" defaultChecked />
        <Label htmlFor="useQuoteTape" className="text-sm">Use quote tape (Databento)</Label>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs text-muted-foreground mb-1">Max Agent Calls</Label>
          <Input
            name="maxAgentCalls"
            type="number"
            defaultValue="100"
            min="0"
            className="h-9"
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground mb-1">Slippage %</Label>
          <Input
            name="slippagePct"
            type="number"
            step="0.001"
            defaultValue="0.01"
            min="0"
            className="h-9"
          />
        </div>
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
