import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { TraderCombobox } from '@/components/trader-combobox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const MODELS_BY_PROVIDER: Record<string, string[]> = {
  anthropic: [
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-6',
  ],
  xai: [
    'grok-4-1-fast-reasoning',
    'grok-4-1-fast-non-reasoning',
  ],
};

export function ClassifyForm({
  traderOptions,
  defaultTraders,
}: {
  traderOptions: string[];
  defaultTraders: string[];
}) {
  const navigate = useNavigate();
  const [provider, setProvider] = useState('xai');
  const [model, setModel] = useState(MODELS_BY_PROVIDER.xai[1]);
  const [traders, setTraders] = useState(defaultTraders);
  const [traderError, setTraderError] = useState<string | null>(null);

  const startMut = useApiMutation<Record<string, unknown>, { id: string }>('POST', '/classify/start', {
    onSuccess: (data) => navigate(`/classify/${data.id}`),
  });

  function handleProviderChange(value: string) {
    setProvider(value);
    setModel(MODELS_BY_PROVIDER[value][0]);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (traders.length === 0) {
      setTraderError('Select at least one trader');
      return;
    }

    const fd = new FormData(e.currentTarget);

    const body: Record<string, unknown> = {
      startDate: fd.get('startDate') as string,
      endDate: fd.get('endDate') as string,
      traders,
      agentProvider: provider,
      agentModel: model,
    };

    const concurrency = fd.get('concurrency');
    if (concurrency) body.concurrency = Number(concurrency);
    const maxAgentCalls = fd.get('maxAgentCalls');
    if (maxAgentCalls) body.maxAgentCalls = Number(maxAgentCalls);
    const name = fd.get('name');
    if (name) body.name = String(name);
    const experimentTag = fd.get('experimentTag');
    if (experimentTag) body.experimentTag = String(experimentTag);

    startMut.mutate(body);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Date range */}
      <fieldset>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="text-xs text-muted-foreground mb-1">
              Start Date <span className="text-destructive">*</span>
            </Label>
            <Input
              name="startDate"
              type="date"
              required
              defaultValue="2025-09-01"
              className="h-9"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">
              End Date <span className="text-destructive">*</span>
            </Label>
            <Input
              name="endDate"
              type="date"
              required
              defaultValue="2025-09-30"
              className="h-9"
            />
          </div>
        </div>

        <div className="mt-4">
          <Label className="text-xs text-muted-foreground mb-1">
            Traders <span className="text-destructive">*</span>
          </Label>
          <TraderCombobox
            options={traderOptions}
            value={traders}
            onChange={(nextTraders) => {
              setTraders(nextTraders);
              setTraderError(null);
            }}
            placeholder="Select traders..."
          />
          {traderError && <p className="mt-1 text-xs text-destructive">{traderError}</p>}
        </div>
      </fieldset>

      <Separator />

      {/* Model config */}
      <fieldset>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="text-xs text-muted-foreground mb-1">Agent Provider</Label>
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
      </fieldset>

      <Separator />

      {/* Run parameters */}
      <fieldset>
        <div className="grid grid-cols-4 gap-4">
          <div>
            <Label className="text-xs text-muted-foreground mb-1">Concurrency</Label>
            <Input name="concurrency" type="number" placeholder="4" className="h-9" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">Max agent calls</Label>
            <Input name="maxAgentCalls" type="number" placeholder="inf" className="h-9" />
          </div>
          <div className="col-span-2">
            <Label className="text-xs text-muted-foreground mb-1">Name</Label>
            <Input name="name" placeholder="e.g. grok baseline sept" className="h-9" />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-4 gap-4">
          <div className="col-span-2">
            <Label className="text-xs text-muted-foreground mb-1">Experiment Tag</Label>
            <Input name="experimentTag" placeholder="e.g. model-comparison-sept" className="h-9" />
          </div>
        </div>
      </fieldset>

      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={startMut.isPending}>
          {startMut.isPending ? 'Starting...' : 'Start Classify Run'}
        </Button>
        <Button type="button" variant="ghost" asChild>
          <Link to="/classify">Cancel</Link>
        </Button>
      </div>
      {startMut.isError && (
        <p className="text-sm text-loss">{startMut.error.message}</p>
      )}
    </form>
  );
}
