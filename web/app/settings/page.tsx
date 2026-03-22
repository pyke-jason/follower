import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { TestButton } from './test-button';
import { SettingToggle } from './alert-toggle';
import { SecretsTable } from './secrets-table';
import { Spinner } from '../components/spinner';

type SecretEntry = { key: string; isSet: boolean };
type ToggleStates = { discord: boolean; pushover: boolean; ingestion: boolean };

export default function SettingsPage() {
  const { data: secrets, isLoading: loadingSecrets } = useQuery({
    queryKey: ['settings-secrets'],
    queryFn: () => api<SecretEntry[]>('/settings/secrets'),
  });

  const { data: toggles, isLoading: loadingToggles } = useQuery({
    queryKey: ['settings-toggles'],
    queryFn: () => api<ToggleStates>('/settings/toggles'),
  });

  if (loadingSecrets || loadingToggles || !secrets || !toggles) return <Spinner />;

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
        <CardContent>
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
        </CardHeader>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Discord</CardTitle>
              <SettingToggle id="discord" enabled={toggles.discord} />
            </div>
            <CardDescription>Webhook alerts for trade events and system notifications</CardDescription>
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
