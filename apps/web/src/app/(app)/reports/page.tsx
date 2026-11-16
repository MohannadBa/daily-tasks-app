'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileBarChart2, Loader2 } from 'lucide-react';
import { Suspense, useState, type ReactNode } from 'react';
import type { ReportJobDto, TaskPriority, TaskStatus } from '@dailytasks/shared-types';
import { errorText, useFeedback } from '@/components/feedback';
import { useIsManager, useMe } from '@/components/providers';
import { PRIORITIES, priorityLabel } from '@/components/task-form';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, SkeletonList, Spinner, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { openReport } from '@/lib/files';
import { formatDateTime, localInputToIso } from '@/lib/format';
import { useT } from '@/lib/i18n';

type Kind = 'TASK' | 'EMPLOYEE' | 'PROJECTS';
const STATUSES: TaskStatus[] = ['ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW', 'COMPLETED'];
const statusLabel: Record<TaskStatus, string> = { ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress', PENDING_REVIEW: 'Pending approval', COMPLETED: 'Completed' };
const jobTone = { QUEUED: 'gray', RENDERING: 'blue', READY: 'green', FAILED: 'red' } as const;
const jobLabel = { QUEUED: 'Queued', RENDERING: 'Generating…', READY: 'Ready', FAILED: 'Failed' } as const;
const typeLabel: Record<Kind, string> = { TASK: 'Task report', EMPLOYEE: 'Employee report', PROJECTS: 'Projects report' };

const day = (offsetDays: number) => {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
};

function Checks<T extends string>({ legend, options, value, onChange, label }: { legend: string; options: readonly T[]; value: T[]; onChange: (v: T[]) => void; label: (v: T) => ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-slate-700">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <label key={o} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
            <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={value.includes(o)} onChange={(e) => onChange(e.target.checked ? [...value, o] : value.filter((x) => x !== o))} />
            {label(o)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ReportForm({ kind, onQueued }: { kind: Kind; onQueued: () => void }) {
  const { t, locale } = useT();
  const me = useMe();
  const isManager = useIsManager();
  const { toast } = useFeedback();
  const [taskQ, setTaskQ] = useState('');
  const [taskId, setTaskId] = useState('');
  const [userId, setUserId] = useState(isManager ? '' : me.id);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [departmentId, setDepartmentId] = useState('');
  const [from, setFrom] = useState(day(-30));
  const [to, setTo] = useState(day(0));
  const [status, setStatus] = useState<TaskStatus[]>([]);
  const [priority, setPriority] = useState<TaskPriority[]>([]);
  const [timeliness, setTimeliness] = useState<'ALL' | 'ON_TIME' | 'LATE'>('ALL');
  const [reportLocale, setReportLocale] = useState<'ar' | 'en'>(locale === 'en' ? 'en' : 'ar');
  const tasks = useQuery({ queryKey: ['tasks', 'report-pick', taskQ], queryFn: () => api.tasks.list({ q: taskQ || undefined, pageSize: 20, sort: '-updated' }), enabled: kind === 'TASK' });
  const employees = useQuery({ queryKey: ['users', 'EMPLOYEE'], queryFn: () => api.users.list({ role: 'EMPLOYEE' }), enabled: kind === 'EMPLOYEE' && isManager });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects.list(), enabled: kind !== 'TASK' });
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api.departments.list(), enabled: kind !== 'TASK' });
  const reportable = (projects.data ?? []).filter((p) => kind === 'EMPLOYEE' || me.role === 'ADMIN' || p.myRole === 'MANAGER');
  const submit = useMutation({
    mutationFn: () => {
      const range = { from: localInputToIso(`${from}T00:00`), to: localInputToIso(`${to}T23:59`), locale: reportLocale };
      const filters = { ...(departmentId ? { departmentId } : {}), ...(status.length ? { status } : {}), ...(priority.length ? { priority } : {}), timeliness };
      if (kind === 'TASK') return api.reports.request({ type: 'TASK', taskId, locale: reportLocale });
      if (kind === 'EMPLOYEE') return api.reports.request({ type: 'EMPLOYEE', userId, ...(projectIds.length ? { projectIds } : {}), ...range, ...filters });
      return api.reports.request({ type: 'PROJECTS', projectIds, ...range, ...filters });
    },
    onSuccess: () => {
      toast(t('Report requested. You will be notified when it is ready.'));
      onQueued();
    },
    onError: (e) => toast(errorText(e), 'error'),
  });
  const valid = kind === 'TASK' ? !!taskId : kind === 'EMPLOYEE' ? !!userId && from <= to : projectIds.length > 0 && from <= to;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) submit.mutate();
      }}
    >
      {kind === 'TASK' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Find a task')}>
            <Input value={taskQ} onChange={(e) => setTaskQ(e.target.value)} placeholder={t('Search by title…')} />
          </Field>
          <Field label={t('Task')}>
            <Select required value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">{t('Select a task…')}</option>
              {(tasks.data?.items ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title} · {x.projectName}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {kind === 'EMPLOYEE' && (
              <Field label={t('Employee')}>
                {isManager ? (
                  <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
                    <option value="">{t('Select an employee…')}</option>
                    {(employees.data ?? []).filter((u) => u.isActive).map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input value={me.name} disabled />
                )}
              </Field>
            )}
            <Field label={t('From')}>
              <Input type="date" required value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label={t('To')}>
              <Input type="date" required value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label={t('Department')}>
              <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">{t('All departments')}</option>
                {(departments.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {locale === 'ar' ? d.nameAr : d.nameEn}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Checks
            legend={t(kind === 'PROJECTS' ? 'Projects (at least one)' : 'Projects (optional)')}
            options={reportable.map((p) => p.id)}
            value={projectIds}
            onChange={setProjectIds}
            label={(id) => reportable.find((p) => p.id === id)?.name}
          />
          <Checks legend={t('Status')} options={STATUSES} value={status} onChange={setStatus} label={(s) => t(statusLabel[s])} />
          <Checks legend={t('Priority')} options={PRIORITIES} value={priority} onChange={setPriority} label={(p) => t(priorityLabel[p])} />
          <Field label={t('Timeliness')}>
            <Select value={timeliness} onChange={(e) => setTimeliness(e.target.value as typeof timeliness)} className="sm:max-w-xs">
              <option value="ALL">{t('All tasks')}</option>
              <option value="ON_TIME">{t('Completed on time')}</option>
              <option value="LATE">{t('Completed late')}</option>
            </Select>
          </Field>
        </>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('Report language')}>
          <Select value={reportLocale} onChange={(e) => setReportLocale(e.target.value as 'ar' | 'en')}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </Select>
        </Field>
        <Button type="submit" loading={submit.isPending} disabled={!valid}>
          <FileBarChart2 className="h-4 w-4" aria-hidden /> {t('Generate PDF')}
        </Button>
      </div>
    </form>
  );
}

function JobRow({ job }: { job: ReportJobDto }) {
  const { t } = useT();
  const { toast } = useFeedback();
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900">{t(typeLabel[job.type])}</p>
        <p className="text-xs text-slate-500">
          {formatDateTime(job.createdAt)} · {job.locale === 'ar' ? 'العربية' : 'English'}
          {job.includesRatings && <> · {t('includes private ratings')}</>}
        </p>
        {job.status === 'FAILED' && job.error && <p className="text-xs text-danger-700">{job.error}</p>}
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={jobTone[job.status]}>
          {(job.status === 'QUEUED' || job.status === 'RENDERING') && <Loader2 className="me-1 h-3 w-3 animate-spin" aria-hidden />}
          {t(jobLabel[job.status])}
        </Badge>
        {job.status === 'READY' && (
          <Button size="sm" variant="secondary" onClick={() => void openReport(job.id).catch((e) => toast(errorText(e), 'error'))}>
            <Download className="h-4 w-4" aria-hidden /> {t('Download')}
          </Button>
        )}
      </div>
    </li>
  );
}

function Reports() {
  const { t } = useT();
  const isManager = useIsManager();
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>('TASK');
  const jobs = useQuery({
    queryKey: ['reports'],
    queryFn: () => api.reports.mine(),
    // Poll only while something is being generated (the REPORT_READY notification also refreshes).
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === 'QUEUED' || j.status === 'RENDERING') ? 3000 : false),
  });
  return (
    <>
      <PageHeader title={t('Reports')} subtitle={t('Branded PDF reports generated on the server. Reports are private to you and kept for 7 days.')} />
      <Tabs
        value={kind}
        onChange={setKind}
        items={[
          { value: 'TASK', label: t('Task report') },
          { value: 'EMPLOYEE', label: t(isManager ? 'Employee report' : 'My report') },
          ...(isManager ? [{ value: 'PROJECTS' as const, label: t('Projects report') }] : []),
        ]}
      />
      <Card className="mb-4 sm:mb-6">
        <ReportForm key={kind} kind={kind} onQueued={() => void qc.invalidateQueries({ queryKey: ['reports'] })} />
      </Card>
      <Card title={t('My reports')}>
        <ErrorBox error={jobs.error} />
        {jobs.isLoading ? (
          <SkeletonList rows={3} />
        ) : !jobs.data?.length ? (
          <Empty title={t('No reports yet')} icon={FileBarChart2} />
        ) : (
          <ul className="-mx-4 divide-y divide-slate-100 sm:-mx-5">
            {jobs.data.map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Reports />
    </Suspense>
  );
}
