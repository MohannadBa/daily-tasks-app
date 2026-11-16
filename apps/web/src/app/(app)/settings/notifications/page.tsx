'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, BellOff, BellRing, CheckCircle2, Circle, Send, Smartphone, Trash2, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { PushSubscriptionDto } from '@dailytasks/shared-types';
import { InstallSteps } from '@/components/install-app';
import { Badge, Button, Card, ErrorBox, PageHeader, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { disablePush, enablePush, endpointHash, getBrowserSubscription, getPermission, getPushSupport, PushSetupError, type PermissionState, type PushSupport } from '@/lib/push';

/** Browser-side state of this device (recomputed after every action). */
function useDeviceState() {
  const [state, setState] = useState<{ support: PushSupport; permission: PermissionState; hash: string | null } | null>(null);
  const refresh = useCallback(async () => {
    const support = getPushSupport();
    const sub = support.serviceWorker ? await getBrowserSubscription().catch(() => null) : null;
    setState({ support, permission: getPermission(), hash: sub ? await endpointHash(sub.endpoint) : null });
  }, []);
  useEffect(() => {
    void refresh();
    // Permission can change in system settings while the app is in the background.
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);
  return { state, refresh };
}

function Check({ ok, warn, label, value }: { ok: boolean; warn?: boolean; label: string; value: ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      {ok ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success-600" aria-hidden /> : warn ? <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning-600" aria-hidden /> : <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-slate-300" aria-hidden />}
      <span className="min-w-0 flex-1 text-sm text-slate-700">{label}</span>
      <span className="shrink-0 text-end text-sm font-medium text-slate-900">{value}</span>
    </li>
  );
}

function Notice({ tone, title, children }: { tone: 'amber' | 'red' | 'blue'; title: string; children: ReactNode }) {
  return (
    <div
      role={tone === 'red' ? 'alert' : 'status'}
      className={clsx(
        'rounded-xl border p-4 text-sm',
        tone === 'amber' && 'border-warning-200 bg-warning-50 text-warning-700',
        tone === 'red' && 'border-red-200 bg-red-50 text-red-900',
        tone === 'blue' && 'border-brand-100 bg-brand-50 text-slate-800',
      )}
    >
      <p className="mb-2 font-semibold">{title}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function DeniedHelp() {
  const { t } = useT();
  return (
    <Notice tone="red" title={t('Notifications are blocked for Al-Rasiyat')}>
      <p>{t('The browser will not ask again. Turn them back on in your device settings, then return here:')}</p>
      <ul className="list-disc space-y-1 ps-5">
        <li>
          <strong>{t('iPhone / iPad')}:</strong> {t('Settings → Notifications → Al-Rasiyat → Allow Notifications.')}
        </li>
        <li>
          <strong>{t('Android')}:</strong> {t('Long-press the Al-Rasiyat icon → App info → Notifications → Allow. In Chrome: ⋮ → Settings → Site settings → Notifications.')}
        </li>
        <li>
          <strong>{t('Computer')}:</strong> {t('Click the icon left of the address bar → Notifications → Allow, then reload the page.')}
        </li>
      </ul>
    </Notice>
  );
}

function permissionLabel(p: PermissionState, t: (k: string) => string) {
  return p === 'granted' ? t('Allowed') : p === 'denied' ? t('Blocked') : p === 'default' ? t('Not asked yet') : t('Not supported');
}

function DeviceRow({ s, current, onRemove, removing }: { s: PushSubscriptionDto; current: boolean; onRemove: () => void; removing: boolean }) {
  const { t } = useT();
  const d = s.lastDelivery;
  return (
    <li className="flex items-start gap-3 py-3">
      <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
          {s.device}
          {current && <Badge tone="blue">{t('This device')}</Badge>}
          {!s.isActive && <Badge tone="red">{t('Inactive')}</Badge>}
        </p>
        <p className="text-xs text-slate-500">
          {t('Added {when}', { when: formatRelative(s.createdAt) })}
          {s.lastUsedAt && <> · {t('last notification {when}', { when: formatRelative(s.lastUsedAt) })}</>}
        </p>
        {!s.isActive && s.deactivationReason && <p className="text-xs text-red-600">{t('Stopped: {reason}', { reason: s.deactivationReason })}</p>}
        {d && (
          <p className="text-xs text-slate-500">
            {t('Last delivery')}: {t(d.status === 'SENT' ? 'accepted by push service' : d.status === 'PENDING' ? 'retrying' : d.status === 'EXPIRED' ? 'subscription expired' : 'failed')}
            {d.statusCode ? ` (${d.statusCode})` : ''} · {formatRelative(d.at)}
          </p>
        )}
      </div>
      <button type="button" onClick={onRemove} disabled={removing} aria-label={t('Remove {name}', { name: s.device })} className="-m-2 flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:text-red-600 disabled:opacity-50">
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </li>
  );
}

export default function NotificationSettingsPage() {
  const { t } = useT();
  const qc = useQueryClient();
  const { state, refresh } = useDeviceState();
  const status = useQuery({ queryKey: ['push-status'], queryFn: () => api.push.status(), refetchInterval: (q) => (q.state.data?.subscriptions.some((s) => s.lastDelivery?.status === 'PENDING') ? 3000 : false) });
  const [error, setError] = useState<string | null>(null);
  const [testSentAt, setTestSentAt] = useState<number | null>(null);
  const reload = async () => {
    await refresh();
    await qc.invalidateQueries({ queryKey: ['push-status'] });
  };

  const enable = useMutation({
    // Called straight from the click handler: the permission prompt needs the user gesture.
    mutationFn: () => enablePush(),
    onMutate: () => setError(null),
    onError: (e) => {
      const code = e instanceof PushSetupError ? e.code : null;
      setError(
        code === 'denied'
          ? null // DeniedHelp is shown instead
          : code === 'dismissed'
            ? t('Permission was not granted. Tap Enable notifications again and choose Allow.')
            : code === 'server-disabled'
              ? t('Push notifications are not configured on the server yet.')
              : code === 'ios-install'
                ? t('Add Al-Rasiyat to your Home Screen first, then open it from there.')
                : code === 'unsupported'
                  ? t('This browser does not support push notifications.')
                  : t('Could not turn on notifications: {msg}', { msg: (e as Error).message }),
      );
    },
    onSettled: reload,
  });
  const disable = useMutation({ mutationFn: () => disablePush(), onSettled: reload });
  const test = useMutation({
    mutationFn: () => api.push.test(),
    onMutate: () => setError(null),
    onSuccess: () => {
      setTestSentAt(Date.now());
      // Poll a few times so the delivery result shows up.
      for (const ms of [2000, 5000, 10000]) setTimeout(() => void qc.invalidateQueries({ queryKey: ['push-status'] }), ms);
    },
    onError: (e) => setError((e as Error).message),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.push.unsubscribe({ id }), onSettled: reload });

  if (!state || status.isLoading) return <Spinner />;
  const { support, permission, hash } = state;
  const server = status.data;
  const mine = server?.subscriptions.find((s) => s.endpointHash === hash);
  const subscribedHere = !!hash && !!mine?.isActive;
  const ios = support.platform === 'ios-safari' || support.platform === 'ios-other';
  const canEnable = support.supported && !support.iosNeedsInstall && permission !== 'denied' && server?.enabled !== false;

  return (
    <>
      <PageHeader title={t('Notification settings')} subtitle={t('Get task alerts on this phone or computer, even when Al-Rasiyat is closed.')} />
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <Card title={t('This device')}>
          <div className="space-y-4">
            <ErrorBox error={error ?? status.error} />
            {server && !server.enabled && (
              <Notice tone="amber" title={t('Push is turned off on the server')}>
                <p>{t('An administrator needs to configure Web Push (VAPID keys). In-app notifications still work.')}</p>
              </Notice>
            )}
            {support.iosNeedsInstall && (
              <Notice tone="amber" title={t('Install the app to get notifications on iPhone')}>
                <p>{t('On iPhone and iPad, notifications only work in the Al-Rasiyat app on your Home Screen (iOS 16.4 or later), not in a Safari tab.')}</p>
                <InstallSteps platform={support.platform} />
                <p>{t('Then open Al-Rasiyat from the Home Screen and come back to this page.')}</p>
              </Notice>
            )}
            {!support.iosNeedsInstall && !support.supported && (
              <Notice tone="amber" title={t('This browser cannot receive push notifications')}>
                <p>{!support.secureContext ? t('Push requires a secure (https) connection.') : t('Use Chrome on Android, Safari on iPhone (installed app), or a current desktop browser.')}</p>
              </Notice>
            )}
            {permission === 'denied' && <DeniedHelp />}

            <ul className="divide-y divide-slate-100">
              <Check ok={support.standalone} warn={ios && !support.standalone} label={t('Opened as installed app')} value={t(support.standalone ? 'Yes' : 'No')} />
              <Check ok={support.serviceWorker && support.pushManager} label={t('Push supported by this browser')} value={t(support.serviceWorker && support.pushManager ? 'Yes' : 'No')} />
              <Check ok={permission === 'granted'} warn={permission === 'denied'} label={t('Notification permission')} value={permissionLabel(permission, t)} />
              <Check
                ok={subscribedHere}
                warn={!!hash && !subscribedHere}
                label={t('Subscription on this device')}
                value={subscribedHere ? t('Active') : hash ? t('Needs re-enabling') : t('Off')}
              />
            </ul>

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              {!subscribedHere && canEnable && (
                <Button onClick={() => enable.mutate()} loading={enable.isPending} className="w-full sm:w-auto">
                  <BellRing className="h-4 w-4" aria-hidden /> {t('Enable notifications')}
                </Button>
              )}
              {subscribedHere && (
                <>
                  <Button onClick={() => test.mutate()} loading={test.isPending} className="w-full sm:w-auto">
                    <Send className="h-4 w-4 rtl:-scale-x-100" aria-hidden /> {t('Send test notification')}
                  </Button>
                  <Button variant="secondary" onClick={() => disable.mutate()} loading={disable.isPending} className="w-full sm:w-auto">
                    <BellOff className="h-4 w-4" aria-hidden /> {t('Turn off on this device')}
                  </Button>
                </>
              )}
            </div>
            {testSentAt && (
              <Notice tone="blue" title={t('Test notification queued')}>
                <p>{t('It usually arrives within seconds, but Apple and Google decide the exact delivery time. "Accepted by push service" below means it left our server — not that your phone showed it.')}</p>
                <p>{t("Nothing appeared? Check Focus / Do Not Disturb, that notifications for Al-Rasiyat are allowed in system settings, and that the phone is online.")}</p>
              </Notice>
            )}
          </div>
        </Card>

        <Card title={t('Your devices ({n})', { n: server?.subscriptions.length ?? 0 })}>
          {server?.subscriptions.length ? (
            <ul className="-my-3 divide-y divide-slate-100">
              {server.subscriptions.map((s) => (
                <DeviceRow key={s.id} s={s} current={s.endpointHash === hash} onRemove={() => remove.mutate(s.id)} removing={remove.isPending && remove.variables === s.id} />
              ))}
            </ul>
          ) : (
            <p className="flex items-center gap-2 text-sm text-slate-500">
              <Circle className="h-4 w-4" aria-hidden /> {t('No devices receive notifications yet.')}
            </p>
          )}
          <p className="mt-4 text-xs text-slate-500">{t('Each phone, browser or installed app is a separate device. Signing out removes this device.')}</p>
        </Card>

        <Card title={t('How to set up')} className="lg:col-span-2">
          <div className="grid gap-6 md:grid-cols-3">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('iPhone & iPad (iOS 16.4+)')}</p>
              <InstallSteps platform="ios-safari" />
              <p className="mt-2 text-sm text-slate-600">{t('Open Al-Rasiyat from the Home Screen → Notification settings → Enable notifications → Allow.')}</p>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('Android (Chrome)')}</p>
              <InstallSteps platform="android" />
              <p className="mt-2 text-sm text-slate-600">{t('Open Al-Rasiyat → Notification settings → Enable notifications → Allow.')}</p>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('Enabling notifications')}</p>
              <ul className="list-disc space-y-1.5 ps-5 text-sm text-slate-600">
                <li>{t('We only ask for permission when you tap Enable notifications.')}</li>
                <li>{t('Enable it on every device you use; each one is listed above.')}</li>
                <li>{t('Use Send test notification to check this device.')}</li>
                <li>{t('Delivery depends on Apple/Google and the phone being online; timing is not guaranteed.')}</li>
              </ul>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
