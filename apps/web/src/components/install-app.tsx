'use client';
import { CheckCircle2, Download, MoreVertical, PlusSquare, Share, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { dismissInstallBanner, installBannerDismissed, promptInstall, useInstallState, type Platform } from '@/lib/pwa';
import { useT } from '@/lib/i18n';
import { Button, Card } from './ui';

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{n}</span>
      <span className="pt-0.5 text-sm text-slate-700">{children}</span>
    </li>
  );
}

const inlineIcon = 'mx-0.5 inline h-4 w-4 align-[-3px] text-brand-700';

/** Step-by-step instructions for the given platform. */
export function InstallSteps({ platform }: { platform: Platform }) {
  const { t } = useT();
  if (platform === 'ios-other') {
    return (
      <ol className="space-y-2.5">
        <Step n={1}>{t('Open this page in Safari (installing works from Safari on iPhone and iPad).')}</Step>
        <Step n={2}>{t('Then tap Share and choose Add to Home Screen.')}</Step>
      </ol>
    );
  }
  if (platform === 'ios-safari') {
    return (
      <ol className="space-y-2.5">
        <Step n={1}>
          {t('Tap the Share button')} <Share className={inlineIcon} aria-hidden /> {t('in the Safari toolbar.')}
        </Step>
        <Step n={2}>
          {t('Scroll down and tap Add to Home Screen')} <PlusSquare className={inlineIcon} aria-hidden />
        </Step>
        <Step n={3}>{t('Tap Add. Open Al-Rasiyat from your Home Screen.')}</Step>
      </ol>
    );
  }
  return (
    <ol className="space-y-2.5">
      <Step n={1}>
        {t('Open the browser menu')} <MoreVertical className={inlineIcon} aria-hidden />
      </Step>
      <Step n={2}>{t('Tap Install app (or Add to Home screen).')}</Step>
      <Step n={3}>{t('Confirm. Al-Rasiyat opens like a regular app.')}</Step>
    </ol>
  );
}

/** Compact banner at the top of the app until the user installs or dismisses it (re-shown after 14 days). */
export function InstallBanner() {
  const { t } = useT();
  const { standalone, platform, canPrompt } = useInstallState();
  const [hidden, setHidden] = useState(true);
  const [showSteps, setShowSteps] = useState(false);
  // localStorage is client-only: decide after mount to avoid hydration mismatches.
  useEffect(() => setHidden(installBannerDismissed()), []);

  const relevant = platform === 'ios-safari' || platform === 'ios-other' || canPrompt;
  if (standalone || hidden || !relevant) return null;
  const close = () => {
    dismissInstallBanner();
    setHidden(true);
  };

  return (
    <div className="mb-4 rounded-xl border border-brand-100 bg-white p-4 shadow-sm" role="region" aria-label={t('Install the app')}>
      <div className="flex items-start gap-3">
        <img src="/icons/icon-192.png" alt="" className="h-10 w-10 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">{t('Install Al-Rasiyat on this device')}</p>
          <p className="text-sm text-slate-500">{t('Open it from your Home Screen like an app and get task alerts.')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {canPrompt ? (
              <Button size="sm" onClick={() => void promptInstall()}>
                <Download className="h-4 w-4" aria-hidden /> {t('Install app')}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setShowSteps((s) => !s)} aria-expanded={showSteps}>
                {t(showSteps ? 'Hide steps' : 'Show me how')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={close}>
              {t('Not now')}
            </Button>
          </div>
          {showSteps && (
            <div className="mt-3">
              <InstallSteps platform={platform} />
            </div>
          )}
        </div>
        <button type="button" onClick={close} aria-label={t('Close')} className="-m-2 rounded-lg p-2 text-slate-400 hover:text-slate-700">
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** Always-available install card (Settings), with instructions for every platform. */
export function InstallCard() {
  const { t } = useT();
  const { standalone, platform, canPrompt } = useInstallState();
  return (
    <Card title={t('Install the app')}>
      {standalone ? (
        <p className="flex items-center gap-2 text-sm text-success-700">
          <CheckCircle2 className="h-5 w-5" aria-hidden /> {t('Al-Rasiyat is installed and running as an app on this device.')}
        </p>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-slate-600">{t('Add Al-Rasiyat to your Home Screen to open it full-screen, like a native app.')}</p>
          {canPrompt && (
            <Button onClick={() => void promptInstall()} className="w-full sm:w-auto">
              <Download className="h-4 w-4" aria-hidden /> {t('Install app')}
            </Button>
          )}
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('iPhone & iPad (Safari)')}</p>
              <InstallSteps platform={platform === 'ios-other' ? 'ios-other' : 'ios-safari'} />
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('Android (Chrome)')}</p>
              <InstallSteps platform="android" />
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
