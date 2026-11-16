'use client';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { TaskDetailDto } from '@dailytasks/shared-types';
import { api } from '@/lib/api';
import { isoToLocalInput, localInputToIso } from '@/lib/format';
import { FilePicker } from './file-picker';
import { useMe } from './providers';
import { Button, ErrorBox, Field, Input, Select, Textarea } from './ui';
import { useT } from '@/lib/i18n';

export interface TaskFormValues {
  projectId: string;
  assigneeId: string;
  title: string;
  description: string;
  deadline: string; // ISO
  files: File[];
}

/** Create (no `task`) or edit (with `task`) form. Project/assignee are fixed when editing; use Reassign instead. */
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
  const { t } = useT();
  const [projectId, setProjectId] = useState(task?.projectId ?? defaultProjectId ?? '');
  const [assigneeId, setAssigneeId] = useState(task?.assignee.id ?? '');
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [deadline, setDeadline] = useState(task ? isoToLocalInput(task.deadline) : '');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects.list() });
  const manageable = (projects.data ?? []).filter((p) => p.status === 'ACTIVE' && (me.role === 'COMPANY_ADMIN' || p.myRole === 'MANAGER'));
  const members = useQuery({ queryKey: ['members', projectId], queryFn: () => api.projects.members(projectId), enabled: !!projectId && !task });
  const employees = (members.data ?? []).filter((m) => m.role === 'EMPLOYEE');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (new Date(deadline).getTime() <= Date.now()) {
      setError(new Error(t('Deadline must be in the future')));
      return;
    }
    setSaving(true);
    try {
      await onSubmit({ projectId, assigneeId, title: title.trim(), description: description.trim(), deadline: localInputToIso(deadline), files });
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
        <div className="grid gap-4 sm:grid-cols-2">
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
          <Field label={t('Assign to')} hint={projectId && employees.length === 0 && !members.isLoading ? t('This project has no employees yet') : undefined}>
            <Select required value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} disabled={!projectId}>
              <option value="">{t('Select an employee…')}</option>
              {employees.map((m) => (
                <option key={m.userId} value={m.userId}>
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
      <Field label={t('Deadline')} hint={t('Date and time in your local timezone')}>
        <Input type="datetime-local" required value={deadline} onChange={(e) => setDeadline(e.target.value)} className="max-w-xs" />
      </Field>
      <div>
        <FilePicker files={files} onChange={setFiles} onError={setFileError} />
        {fileError && <p className="mt-1 text-xs text-red-600">{fileError}</p>}
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          {t(submitLabel)}
        </Button>
      </div>
    </form>
  );
}
