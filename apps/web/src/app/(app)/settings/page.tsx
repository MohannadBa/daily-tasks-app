'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { InstallCard } from '@/components/install-app';
import { useMe } from '@/components/providers';
import { Button, Card, ErrorBox, Field, Input, LinkButton, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

function Profile() {
  const me = useMe();
  const qc = useQueryClient();
  const { t, setLocale: applyUiLocale } = useT();
  const [name, setName] = useState(me.name);
  const [locale, setLocale] = useState(me.locale);
  const save = useMutation({
    mutationFn: () => api.auth.updateProfile({ name, locale }),
    onSuccess: () => {
      applyUiLocale(locale);
      return qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <Card title={t('Profile')}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <ErrorBox error={save.error} />
        <Field label={t('Name')}><Input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('Email')}><Input value={me.email} disabled /></Field>
        <Field label={t('Language')} hint={t('Used for the interface, push notifications and in-app messages')}>
          <Select value={locale} onChange={(e) => setLocale(e.target.value as 'en' | 'ar')}>
            <option value="en">English</option>
            <option value="ar">العربية</option>
          </Select>
        </Field>
        <Button type="submit" loading={save.isPending} className="w-full sm:w-auto">{t(save.isSuccess ? 'Saved' : 'Save')}</Button>
      </form>
    </Card>
  );
}

const PRESETS = [
  { label: '1 week', minutes: 10080 },
  { label: '3 days', minutes: 4320 },
  { label: '24 hours', minutes: 1440 },
  { label: '4 hours', minutes: 240 },
  { label: '1 hour', minutes: 60 },
  { label: '15 minutes', minutes: 15 },
];

function CompanySettings({ editable }: { editable: boolean }) {
  const qc = useQueryClient();
  const { t } = useT();
  const settings = useQuery({ queryKey: ['company'], queryFn: () => api.company.settings() });
  const [name, setName] = useState('');
  const [offsets, setOffsets] = useState<number[]>([]);
  useEffect(() => {
    if (settings.data) {
      setName(settings.data.name);
      setOffsets(settings.data.reminderOffsetsMinutes);
    }
  }, [settings.data]);
  const save = useMutation({ mutationFn: () => api.company.updateSettings({ name, reminderOffsetsMinutes: offsets }), onSuccess: () => qc.invalidateQueries({ queryKey: ['company'] }) });
  const toggle = (m: number) => setOffsets((o) => (o.includes(m) ? o.filter((x) => x !== m) : [...o, m].sort((a, b) => b - a)));

  return (
    <Card title={t('Company')}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <ErrorBox error={save.error ?? settings.error} />
        <Field label={t('Company name')}><Input value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} /></Field>
        <fieldset>
          <legend className="text-sm font-medium text-slate-700">{t('Deadline reminders')}</legend>
          <p className="mb-2 text-xs text-slate-500">{t('Employees get a push reminder at these times before a deadline. An overdue alert is always sent to the employee and managers. Up to 5.')}</p>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <label key={p.minutes} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm lg:min-h-0">
                <input type="checkbox" disabled={!editable || (!offsets.includes(p.minutes) && offsets.length >= 5)} checked={offsets.includes(p.minutes)} onChange={() => toggle(p.minutes)} />
                {t('{label} before', { label: t(p.label) })}
              </label>
            ))}
          </div>
        </fieldset>
        {editable && <Button type="submit" loading={save.isPending}>{t(save.isSuccess ? 'Saved' : 'Save company settings')}</Button>}
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  const me = useMe();
  const isManager = me.role !== 'EMPLOYEE';
  const { t } = useT();
  return (
    <>
      <PageHeader title={t('Profile & settings')} />
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <Profile />
        <div id="install" className="scroll-mt-20 space-y-4 sm:space-y-6">
          <Card title={t('Push notifications')}>
            <p className="mb-3 text-sm text-slate-600">{t('Get task alerts on your phone even when Al-Rasiyat is closed.')}</p>
            <LinkButton href="/settings/notifications">{t('Notification settings')}</LinkButton>
          </Card>
          <InstallCard />
        </div>
        {isManager && <CompanySettings editable={me.role === 'COMPANY_ADMIN'} />}
      </div>
    </>
  );
}
