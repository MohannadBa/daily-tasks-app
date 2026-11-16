'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Building2, ChevronDown, Pencil, Users } from 'lucide-react';
import { useState } from 'react';
import type { DepartmentDto } from '@dailytasks/shared-types';
import { DepartmentEditor } from '@/components/department-editor';
import { errorText, useFeedback } from '@/components/feedback';
import { useMe } from '@/components/providers';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, SkeletonList } from '@/components/ui';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

function DeptForm({ initial, onSubmit, saving, submitLabel, withCode }: { initial: { code: string; nameAr: string; nameEn: string }; onSubmit: (v: { code: string; nameAr: string; nameEn: string }) => void; saving: boolean; submitLabel: string; withCode: boolean }) {
  const { t } = useT();
  const [v, setV] = useState(initial);
  return (
    <form
      className="grid gap-3 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v);
      }}
    >
      {withCode && (
        <Field label={t('Code')} hint={t('Letters and underscores, e.g. QUALITY')}>
          <Input required pattern="[A-Za-z][A-Za-z_]{1,39}" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} dir="ltr" />
        </Field>
      )}
      <Field label={t('Arabic name')}>
        <Input required maxLength={120} value={v.nameAr} onChange={(e) => setV({ ...v, nameAr: e.target.value })} dir="rtl" lang="ar" />
      </Field>
      <Field label={t('English name')}>
        <Input required maxLength={120} value={v.nameEn} onChange={(e) => setV({ ...v, nameEn: e.target.value })} dir="ltr" lang="en" />
      </Field>
      <Button type="submit" loading={saving}>
        {t(submitLabel)}
      </Button>
    </form>
  );
}

function DeptRow({ d }: { d: DepartmentDto }) {
  const { t, locale } = useT();
  const qc = useQueryClient();
  const { toast, confirm } = useFeedback();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const members = useQuery({ queryKey: ['department-members', d.id], queryFn: () => api.departments.members(d.id), enabled: open });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['departments'] }), qc.invalidateQueries({ queryKey: ['department-members'] })]);
  const update = useMutation({
    mutationFn: (body: { nameAr?: string; nameEn?: string; isActive?: boolean }) => api.departments.update(d.id, body),
    onSuccess: () => {
      setEditing(false);
      toast(t('Saved'));
      return refresh();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-start lg:min-h-0">
          <ChevronDown className={clsx('h-4 w-4 shrink-0 text-slate-400 transition-transform', !open && 'ltr:-rotate-90 rtl:rotate-90')} aria-hidden />
          <span className="min-w-0">
            <span className="block truncate font-medium text-slate-900">{locale === 'ar' ? d.nameAr : d.nameEn}</span>
            <span className="block truncate text-xs text-slate-500">
              {locale === 'ar' ? d.nameEn : d.nameAr} · <span dir="ltr">{d.code}</span>
            </span>
          </span>
        </button>
        <span className="inline-flex items-center gap-1 text-sm text-slate-500">
          <Users className="h-4 w-4" aria-hidden /> {d.memberCount}
        </span>
        {!d.isActive && <Badge tone="red">{t('Inactive')}</Badge>}
        <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)} aria-label={t('Edit {name}', { name: locale === 'ar' ? d.nameAr : d.nameEn })}>
          <Pencil className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={update.isPending}
          onClick={async () => {
            if (d.isActive && !(await confirm({ title: t('Deactivate {name}?', { name: locale === 'ar' ? d.nameAr : d.nameEn }), message: t('No new tasks can be assigned to it. Existing tasks and history are kept.'), confirmLabel: t('Deactivate'), danger: true }))) return;
            update.mutate({ isActive: !d.isActive });
          }}
        >
          {t(d.isActive ? 'Deactivate' : 'Activate')}
        </Button>
      </div>
      {editing && (
        <div className="dt-fade-in mt-3">
          <DeptForm initial={{ code: d.code, nameAr: d.nameAr, nameEn: d.nameEn }} withCode={false} submitLabel="Save" saving={update.isPending} onSubmit={(v) => update.mutate({ nameAr: v.nameAr.trim(), nameEn: v.nameEn.trim() })} />
        </div>
      )}
      {open && (
        <div className="dt-fade-in mt-3 ps-7">
          {members.isLoading ? (
            <SkeletonList rows={2} />
          ) : !members.data?.length ? (
            <p className="text-sm text-slate-500">{t('No employees in this department')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {members.data.map((m) => (
                <li key={m.id} className="px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-900">
                        {m.name} {!m.isActive && <Badge tone="red">{t('Inactive')}</Badge>}
                      </span>
                      <span className="block truncate text-xs text-slate-500">{m.email}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      {m.isPrimary && <Badge tone="blue">{t('Primary')}</Badge>}
                      <Button size="sm" variant="ghost" onClick={() => setMoving(moving === m.id ? null : m.id)}>
                        {t('Change departments')}
                      </Button>
                    </span>
                  </div>
                  {moving === m.id && (
                    <DepartmentEditor
                      userId={m.id}
                      name={m.name}
                      onDone={() => {
                        setMoving(null);
                        void refresh();
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export default function DepartmentsPage() {
  const { t } = useT();
  const me = useMe();
  const qc = useQueryClient();
  const { toast } = useFeedback();
  const list = useQuery({ queryKey: ['departments', 'all'], queryFn: () => api.departments.list({ includeInactive: true }), enabled: me.role === 'ADMIN' });
  const [creating, setCreating] = useState(false);
  const create = useMutation({
    mutationFn: (v: { code: string; nameAr: string; nameEn: string }) => api.departments.create({ code: v.code.trim(), nameAr: v.nameAr.trim(), nameEn: v.nameEn.trim() }),
    onSuccess: () => {
      setCreating(false);
      toast(t('Department created'));
      return qc.invalidateQueries({ queryKey: ['departments'] });
    },
  });
  if (me.role !== 'ADMIN') return <Empty title={t('Only company administrators can manage departments')} icon={Building2} />;
  return (
    <>
      <PageHeader title={t('Departments')} subtitle={t('Organise employees by department. Tasks are assigned within a department.')} actions={!creating && <Button onClick={() => setCreating(true)}>{t('New department')}</Button>} />
      {creating && (
        <Card className="dt-fade-in mb-4" title={t('New department')}>
          <ErrorBox error={create.error} />
          <DeptForm initial={{ code: '', nameAr: '', nameEn: '' }} withCode submitLabel="Create" saving={create.isPending} onSubmit={(v) => create.mutate(v)} />
          <Button variant="ghost" className="mt-2" onClick={() => setCreating(false)}>
            {t('Cancel')}
          </Button>
        </Card>
      )}
      <Card>
        <ErrorBox error={list.error} />
        {list.isLoading ? (
          <SkeletonList rows={5} />
        ) : !list.data?.length ? (
          <Empty title={t('No departments yet')} icon={Building2} />
        ) : (
          <ul className="-mx-4 divide-y divide-slate-100 sm:-mx-5">
            {list.data.map((d) => (
              <DeptRow key={d.id} d={d} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
