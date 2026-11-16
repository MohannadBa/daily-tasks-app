'use client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, Circle, Lock, NotebookPen, Pencil, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { PersonalTaskDto, TaskPriority } from '@dailytasks/shared-types';
import { errorText, useFeedback } from '@/components/feedback';
import { PRIORITIES, priorityLabel } from '@/components/task-form';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, SkeletonList, Tabs, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatRelative, isoToLocalInput, localInputToIso } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { priorityTone } from '@/lib/labels';

type Draft = { title: string; notes: string; dueAt: string; priority: TaskPriority };
const empty: Draft = { title: '', notes: '', dueAt: '', priority: 'MEDIUM' };

function Editor({ initial, onSave, onCancel, saving }: { initial: Draft; onSave: (d: Draft) => void; onCancel?: () => void; saving: boolean }) {
  const { t } = useT();
  const [d, setD] = useState(initial);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (d.title.trim()) onSave(d);
      }}
    >
      <Field label={t('Title')}>
        <Input required maxLength={200} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
      </Field>
      <Field label={t('Notes')}>
        <Textarea rows={3} maxLength={5000} value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Due (optional)')}>
          <Input type="datetime-local" value={d.dueAt} onChange={(e) => setD({ ...d, dueAt: e.target.value })} />
        </Field>
        <Field label={t('Priority')}>
          <Select value={d.priority} onChange={(e) => setD({ ...d, priority: e.target.value as TaskPriority })}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(priorityLabel[p])}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" loading={saving} disabled={!d.title.trim()}>
          {t('Save')}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('Cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * Private personal workspace. Data comes only from /me/personal-tasks (owner-only on the server,
 * encrypted at rest); it never appears in company tasks, dashboards, reports or performance.
 */
export default function PersonalTasksPage() {
  const { t } = useT();
  const qc = useQueryClient();
  const { toast, confirm } = useFeedback();
  const [status, setStatus] = useState<'OPEN' | 'DONE' | 'ALL'>('OPEN');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ['personal', status, search, page],
    queryFn: () => api.personalTasks.list({ status: status === 'ALL' ? undefined : status, q: search || undefined, page, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['personal'] });
  const toBody = (d: Draft) => ({ title: d.title.trim(), notes: d.notes.trim() || null, dueAt: d.dueAt ? localInputToIso(d.dueAt) : null, priority: d.priority });
  const create = useMutation({
    mutationFn: (d: Draft) => api.personalTasks.create(toBody(d)),
    onSuccess: () => {
      setCreating(false);
      toast(t('Personal task added'));
      return refresh();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const update = useMutation({
    mutationFn: ({ id, d }: { id: string; d: Draft }) => api.personalTasks.update(id, toBody(d)),
    onSuccess: () => {
      setEditing(null);
      toast(t('Saved'));
      return refresh();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const toggle = useMutation({
    mutationFn: (p: PersonalTaskDto) => (p.status === 'OPEN' ? api.personalTasks.complete(p.id) : api.personalTasks.reopen(p.id)),
    onSuccess: refresh,
    onError: (e) => toast(errorText(e), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.personalTasks.remove(id),
    onSuccess: () => {
      toast(t('Deleted'));
      return refresh();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title={t('Personal tasks')}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5" aria-hidden /> {t('Only you can see these. They are not part of company tasks or performance.')}
          </span>
        }
        actions={!creating && <Button onClick={() => setCreating(true)}>{t('New personal task')}</Button>}
      />
      {creating && (
        <Card className="dt-fade-in mb-4" title={t('New personal task')}>
          <Editor initial={empty} onSave={(d) => create.mutate(d)} onCancel={() => setCreating(false)} saving={create.isPending} />
        </Card>
      )}
      <Tabs
        value={status}
        onChange={(v) => {
          setStatus(v);
          setPage(1);
        }}
        items={[
          { value: 'OPEN', label: t('Open') },
          { value: 'DONE', label: t('Done') },
          { value: 'ALL', label: t('All') },
        ]}
      />
      <Card>
        <form
          className="mb-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q.trim());
            setPage(1);
          }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search personal tasks…')} aria-label={t('Search')} />
          <Button type="submit" variant="secondary" aria-label={t('Search')}>
            <Search className="h-4 w-4" aria-hidden />
          </Button>
        </form>
        <ErrorBox error={list.error} />
        {list.isLoading ? (
          <SkeletonList rows={4} />
        ) : !list.data?.items.length ? (
          <Empty title={t(search ? 'No matching personal tasks' : 'No personal tasks yet')} icon={NotebookPen} />
        ) : (
          <ul className="-mx-4 divide-y divide-slate-100 sm:-mx-5">
            {list.data.items.map((p) => (
              <li key={p.id} className="px-4 py-3 sm:px-5">
                {editing === p.id ? (
                  <Editor
                    initial={{ title: p.title, notes: p.notes ?? '', dueAt: p.dueAt ? isoToLocalInput(p.dueAt) : '', priority: p.priority }}
                    onSave={(d) => update.mutate({ id: p.id, d })}
                    onCancel={() => setEditing(null)}
                    saving={update.isPending}
                  />
                ) : (
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => toggle.mutate(p)}
                      aria-label={t(p.status === 'OPEN' ? 'Mark as done' : 'Mark as open')}
                      className="-m-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400 hover:text-success-600"
                    >
                      {p.status === 'DONE' ? <CheckCircle2 className="h-5 w-5 text-success-600" aria-hidden /> : <Circle className="h-5 w-5" aria-hidden />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className={clsx('break-words font-medium', p.status === 'DONE' ? 'text-slate-400 line-through' : 'text-slate-900')}>{p.title}</p>
                      {p.notes && <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-600">{p.notes}</p>}
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <Badge tone={priorityTone[p.priority]}>{t(priorityLabel[p.priority])}</Badge>
                        {p.dueAt && (
                          <span className={p.status === 'OPEN' && new Date(p.dueAt) < new Date() ? 'text-danger-700' : ''} title={formatDateTime(p.dueAt)}>
                            {t('Due {when}', { when: formatRelative(p.dueAt) })}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button onClick={() => setEditing(p.id)} aria-label={t('Edit')} className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:text-brand-700">
                        <Pencil className="h-4 w-4" aria-hidden />
                      </button>
                      <button
                        onClick={async () => {
                          if (await confirm({ title: t('Delete this personal task?'), confirmLabel: t('Delete'), danger: true })) remove.mutate(p.id);
                        }}
                        aria-label={t('Delete')}
                        className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:text-danger-600"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {pages > 1 && (
          <div className="mt-4 flex items-center justify-between text-sm">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              {t('Previous')}
            </Button>
            <span className="text-slate-500">{t('Page {p} of {n}', { p: page, n: pages })}</span>
            <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              {t('Next')}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
