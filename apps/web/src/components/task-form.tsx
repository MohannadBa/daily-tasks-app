'use client';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { TaskDetailDto, TaskPriority } from '@dailytasks/shared-types';
import { api } from '@/lib/api';
import { isoToLocalInput, localInputToIso } from '@/lib/format';
import { FilePicker } from './file-picker';
import { useMe } from './providers';
import { Button, ErrorBox, Field, Input, Select, Textarea } from './ui';
import { useT } from '@/lib/i18n';

export interface TaskFormValues {
  projectId: string;
  departmentId: string;
  assigneeId: string;
  title: string;
  description: string;
  deadline: string; // ISO
  priority: TaskPriority;
  files: File[];
}

export const PRIORITIES: TaskPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export const priorityLabel: Record<TaskPriority, string> = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', URGENT: 'Urgent' };

/**
 * Create (no `task`) or edit (with `task`) form. Project/department/assignee are fixed when editing
 * (use Reassign). Assignees are limited server-side to employees of the project AND the department.
 */
export function TaskForm({
  task,
  defaultProjectId,
  onSubmit,
  submitLabel,
}: {
  task?: TaskDetailDto;
  defaultProjectId?: string;
  onSubmit: (v: TaskFormValues) => Promise<void>;
  submitLabel: string;
}) {
  const me = useMe();
  const { t, locale } = useT();
  const [projectId, setProjectId] = useState(task?.projectId ?? defaultProjectId ?? '');
  const [departmentId, setDepartmentId] = useState(task?.department?.id ?? '');
  const [assigneeId, setAssigneeId] = useState(task?.assignee.id ?? '');
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [deadline, setDeadline] = useState(task ? isoToLocalInput(task.deadline) : '');
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'MEDIUM');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects.list() });
  const manageable = (projects.data ?? []).filter((p) => p.status === 'ACTIVE' && (me.role === 'ADMIN' || p.myRole === 'MANAGER'));
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api.departments.list(), enabled: !task });
  const assignable = useQuery({
    queryKey: ['assignable', departmentId, projectId],
    queryFn: () => api.departments.assignableEmployees(departmentId, projectId),
    enabled: !!projectId && !!departmentId && !task,
  });
  const employees = assignable.data ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (new Date(deadline).getTime() <= Date.now()) {
      setError(new Error(t('Deadline must be in the future')));
      return;
    }
    setSaving(true);
    try {
      await onSubmit({ projectId, departmentId, assigneeId, title: title.trim(), description: description.trim(), deadline: localInputToIso(deadline), priority, files });
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <ErrorBox error={error} />
      {!task && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('Project')}>
            <Select
              required
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setAssigneeId('');
              }}
            >
              <option value="">{t('Select a project…')}</option>
              {manageable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('Department')}>
            <Select
              required
              value={departmentId}
              onChange={(e) => {
                setDepartmentId(e.target.value);
                setAssigneeId('');
              }}
            >
              <option value="">{t('Select a department…')}</option>
              {(departments.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {locale === 'ar' ? d.nameAr : d.nameEn}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={t('Assign to')}
            hint={projectId && departmentId && employees.length === 0 && !assignable.isLoading ? t('No employees of this project in this department') : undefined}
          >
            <Select required value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} disabled={!projectId || !departmentId}>
              <option value="">{t('Select an employee…')}</option>
              {employees.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      <Field label={t('Title')}>
        <Input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label={t('Description')}>
        <Textarea rows={6} maxLength={10000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('Deadline')} hint={t('Date and time in your local timezone')}>
          <Input type="datetime-local" required value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </Field>
        <Field label={t('Priority')}>
          <Select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(priorityLabel[p])}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div>
        <FilePicker files={files} onChange={setFiles} onError={setFileError} />
        {fileError && <p className="mt-1 text-xs text-danger-600">{fileError}</p>}
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={saving} className="w-full sm:w-auto">
          {t(submitLabel)}
        </Button>
      </div>
    </form>
  );
}
