import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApiMutation } from '@/hooks/use-api-mutation';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { TraderCombobox } from '@/components/trader-combobox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isoToDateKey } from '@/lib/format';
import { Link } from 'react-router-dom';
import type { BacktestRunConfig } from '@src/db/schema';
import { BACKTEST_RISK_DEFAULTS, DEFAULT_COMMISSION_SCHEDULE } from '@src/config/risk-defaults';
import { DEFAULT_TRADE_MODEL, TRADE_MODELS_BY_PROVIDER } from '@src/agent/model-defaults';

const MODELS_BY_PROVIDER: Record<string, readonly string[]> = TRADE_MODELS_BY_PROVIDER;

export function BacktestForm({
  traderOptions,
  defaultTraders,
  defaultConfig,
}: {
  traderOptions: string[];
  defaultTraders: string[];
  defaultConfig?: BacktestRunConfig;
}) {
  const navigate = useNavigate();
  const defaultProvider = defaultConfig?.agentProvider ?? DEFAULT_TRADE_MODEL.provider;
  const [provider, setProvider] = useState(defaultProvider);
  const [model, setModel] = useState(
    defaultConfig?.agentModel ?? MODELS_BY_PROVIDER[defaultProvider]?.[0] ?? DEFAULT_TRADE_MODEL.model,
  );
  const [traders, setTraders] = useState(defaultConfig?.traders ?? defaultTraders);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const startMut = useApiMutation<Record<string, unknown>, { id: string }>('POST', '/backtests/start', {
    onSuccess: (data) => navigate(`/backtests/${data.id}`),
  });

  function handleProviderChange(value: string) {
    setProvider(value);
    setModel(MODELS_BY_PROVIDER[value][0]);
  }

  function validateField(name: string, value: string) {
    setErrors((prev) => {
      const next = { ...prev };
      if (name === 'startingEquity' && value !== '' && (isNaN(Number(value)) || Number(value) <= 0)) {
        next[name] = 'Must be a positive number';
      } else {
        delete next[name];
      }
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (traders.length === 0) {
      setErrors((prev) => ({ ...prev, traders: 'Select at least one trader' }));
      return;
    }

    const fd = new FormData(e.currentTarget);

    const body: Record<string, unknown> = {
      startDate: fd.get('startDate') as string,
      endDate: fd.get('endDate') as string,
      traders,
      agentProvider: provider,
      agentModel: model,
      disableRiskLimits: fd.get('disableRiskLimits') === 'on',
    };

    const startingEquity = fd.get('startingEquity');
    if (startingEquity) body.startingEquity = Number(startingEquity);
    const maxOnSymbol = fd.get('maxOnSymbol');
    if (maxOnSymbol) body.maxOnSymbol = Number(maxOnSymbol);
    const maxTotalPositions = fd.get('maxTotalPositions');
    if (maxTotalPositions) body.maxTotalPositions = Number(maxTotalPositions);
    const maxDrawdownPct = fd.get('maxDrawdownPct');
    if (maxDrawdownPct) body.maxDrawdownPct = Number(maxDrawdownPct);
    const maxAgentCalls = fd.get('maxAgentCalls');
    if (maxAgentCalls) body.maxAgentCalls = Number(maxAgentCalls);

    const commOptionPerContract = fd.get('commissionOptionPerContract');
    const commStockPerShare = fd.get('commissionStockPerShare');
    body.commissionSchedule = {
      option: { perContract: commOptionPerContract ? Number(commOptionPerContract) : DEFAULT_COMMISSION_SCHEDULE.option.perContract },
      stock: { perShare: commStockPerShare ? Number(commStockPerShare) : DEFAULT_COMMISSION_SCHEDULE.stock.perShare },
    };

    startMut.mutate(body);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Date range */}
      <fieldset>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label className="text-xs text-muted-foreground mb-1">Start Date <span className="text-destructive">*</span></Label>
            <Input
              name="startDate"
              type="date"
              required
              defaultValue={defaultConfig?.startDate ? isoToDateKey(defaultConfig.startDate) : '2025-09-01'}
              className="h-9"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">End Date <span className="text-destructive">*</span></Label>
            <Input
              name="endDate"
              type="date"
              required
              defaultValue={defaultConfig?.endDate ? isoToDateKey(defaultConfig.endDate) : '2025-09-30'}
              className="h-9"
            />
          </div>
        </div>

        <div className="mt-4">
          <Label className="text-xs text-muted-foreground mb-1">Traders <span className="text-destructive">*</span></Label>
          <TraderCombobox
            options={traderOptions}
            value={traders}
            onChange={(nextTraders) => {
              setTraders(nextTraders);
              setErrors((prev) => {
                const next = { ...prev };
                delete next.traders;
                return next;
              });
            }}
            placeholder="Select traders..."
          />
          {errors.traders && <p className="mt-1 text-xs text-destructive">{errors.traders}</p>}
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

      {/* Risk parameters */}
      <fieldset>
        <div className="flex items-center gap-6 mb-4">
          <div className="flex items-center gap-3">
            <Switch name="disableRiskLimits" id="disableRiskLimits" defaultChecked={defaultConfig?.disableRiskLimits ?? false} />
            <Label htmlFor="disableRiskLimits" className="text-sm">Disable risk limits</Label>
          </div>
        </div>

        <div className="grid grid-cols-5 gap-4">
          <div>
            <Label className="text-xs text-muted-foreground mb-1">Starting equity</Label>
            <Input
              name="startingEquity"
              type="number"
              placeholder="100,000"
              defaultValue={defaultConfig?.startingEquity ?? ''}
              className={errors.startingEquity ? 'h-9 border-destructive' : 'h-9'}
              onBlur={(e) => validateField('startingEquity', e.target.value)}
              onChange={() => setErrors((prev) => { const next = { ...prev }; delete next.startingEquity; return next; })}
            />
            {errors.startingEquity && <p className="text-xs text-destructive mt-1">{errors.startingEquity}</p>}
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">Max on symbol</Label>
            <Input name="maxOnSymbol" type="number" placeholder={String(BACKTEST_RISK_DEFAULTS.maxOnSymbol)} defaultValue={defaultConfig?.maxOnSymbol ?? ''} className="h-9" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">Max positions</Label>
            <Input name="maxTotalPositions" type="number" placeholder={String(BACKTEST_RISK_DEFAULTS.maxTotalPositions)} defaultValue={defaultConfig?.maxTotalPositions ?? ''} className="h-9" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">Max DD %</Label>
            <Input name="maxDrawdownPct" type="number" step="0.1" placeholder={String(BACKTEST_RISK_DEFAULTS.maxDrawdownPct)} defaultValue={defaultConfig?.maxDrawdownPct ?? ''} className="h-9" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">Max agent calls</Label>
            <Input name="maxAgentCalls" type="number" placeholder="∞" defaultValue={defaultConfig?.maxAgentCalls ?? ''} className="h-9" />
          </div>
        </div>
      </fieldset>

      <Separator />

      {/* Commissions */}
      <fieldset>
        <div className="grid grid-cols-5 gap-4">
          <div>
            <Label className="text-xs text-muted-foreground mb-1">Option comm ($/ct)</Label>
            <Input name="commissionOptionPerContract" type="number" step="0.01" placeholder={String(DEFAULT_COMMISSION_SCHEDULE.option.perContract)} defaultValue={defaultConfig?.commissionSchedule?.option?.perContract ?? DEFAULT_COMMISSION_SCHEDULE.option.perContract} className="h-9" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground mb-1">Stock comm ($/sh)</Label>
            <Input name="commissionStockPerShare" type="number" step="0.001" placeholder={String(DEFAULT_COMMISSION_SCHEDULE.stock.perShare)} defaultValue={defaultConfig?.commissionSchedule?.stock?.perShare ?? DEFAULT_COMMISSION_SCHEDULE.stock.perShare} className="h-9" />
          </div>
        </div>
      </fieldset>

      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={startMut.isPending}>
          {startMut.isPending ? 'Starting...' : 'Start Backtest'}
        </Button>
        <Button type="button" variant="ghost" asChild>
          <Link to="/backtests">Cancel</Link>
        </Button>
      </div>
      {startMut.isError && (
        <p className="text-sm text-loss">{startMut.error.message}</p>
      )}
    </form>
  );
}
