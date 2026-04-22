import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { TestButton } from './test-button';
import { SettingToggle } from './alert-toggle';
import { SecretsTable } from './secrets-table';
import { RiskLimits, type RiskSettings } from './risk-limits';
import { QueryBoundary, TableSkeleton } from '@/components/query-boundary';

type SecretEntry = { key: string; isSet: boolean };
type ToggleStates = { discord: boolean; pushover: boolean; ingestion: boolean };

export default function SettingsPage() {
  const secretsQuery = useQuery({
    queryKey: ['settings-secrets'],
    queryFn: () => api<SecretEntry[]>('/settings/secrets'),
  });

  const togglesQuery = useQuery({
    queryKey: ['settings-toggles'],
    queryFn: () => api<ToggleStates>('/settings/toggles'),
  });

  const riskQuery = useQuery({
    queryKey: ['settings-risk'],
    queryFn: () => api<RiskSettings>('/settings/risk'),
  });

  const combinedQuery = {
    data: secretsQuery.data && togglesQuery.data && riskQuery.data
      ? { secrets: secretsQuery.data, toggles: togglesQuery.data, risk: riskQuery.data }
      : undefined,
    isLoading: secretsQuery.isLoading || togglesQuery.isLoading || riskQuery.isLoading,
    isError: secretsQuery.isError || togglesQuery.isError || riskQuery.isError,
    error: secretsQuery.error || togglesQuery.error || riskQuery.error,
    refetch: () => { secretsQuery.refetch(); togglesQuery.refetch(); riskQuery.refetch(); },
  };

  return (
    <QueryBoundary query={combinedQuery} skeleton={<TableSkeleton />}>
      {(data) => <SettingsContent secrets={data.secrets} toggles={data.toggles} risk={data.risk} />}
    </QueryBoundary>
  );
}

function SettingsContent({
  secrets,
  toggles,
  risk,
}: {
  secrets: SecretEntry[];
  toggles: ToggleStates;
  risk: RiskSettings;
}) {

  const discordConfigured = secrets.find((s) => s.key === 'DISCORD_WEBHOOK_URL')?.isSet ?? false;
  const pushoverConfigured =
    (secrets.find((s) => s.key === 'PUSHOVER_APP_TOKEN')?.isSet ?? false) &&
    (secrets.find((s) => s.key === 'PUSHOVER_USER_KEY')?.isSet ?? false);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-foreground">Settings</h2>

      <Card>
        <CardHeader>
          <CardTitle>Secrets</CardTitle>
          <CardDescription>API keys and credentials stored in macOS Keychain</CardDescription>
        </CardHeader>
        <CardContent className="max-h-[60vh] overflow-auto">
          <SecretsTable entries={secrets} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Live Ingestion</CardTitle>
            <SettingToggle id="ingestion" enabled={toggles.ingestion} />
          </div>
          <CardDescription>
            Browser-based chat monitoring via Playwright. Requires restart to take effect.
          </CardDescription>
          <CardDescription className="text-xs">Changes save automatically.</CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Live Risk Limits</CardTitle>
          <CardDescription>
            Caps enforced by the live runner. Changes take effect on restart.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RiskLimits settings={risk} />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Discord</CardTitle>
              <SettingToggle id="discord" enabled={toggles.discord} />
            </div>
            <CardDescription>Webhook alerts for trade events and system notifications</CardDescription>
            <CardDescription className="text-xs">Changes save automatically.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-sm">
              <span className="font-mono text-xs text-muted-foreground">
                DISCORD_WEBHOOK_URL:{' '}
                <span className={discordConfigured ? 'text-profit' : 'text-destructive'}>
                  {discordConfigured ? 'set' : 'not set'}
                </span>
              </span>
            </div>
            <TestButton service="discord" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Pushover</CardTitle>
              <SettingToggle id="pushover" enabled={toggles.pushover} />
            </div>
            <CardDescription>Push notifications for critical alerts</CardDescription>
            <CardDescription className="text-xs">Changes save automatically.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-sm flex gap-4">
              <span className="font-mono text-xs text-muted-foreground">
                PUSHOVER_APP_TOKEN:{' '}
                <span className={pushoverConfigured ? 'text-profit' : 'text-destructive'}>
                  {pushoverConfigured ? 'set' : 'not set'}
                </span>
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                PUSHOVER_USER_KEY:{' '}
                <span className={pushoverConfigured ? 'text-profit' : 'text-destructive'}>
                  {pushoverConfigured ? 'set' : 'not set'}
                </span>
              </span>
            </div>
            <TestButton service="pushover" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
