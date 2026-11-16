'use client';
import { Paperclip, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import type { TaskDto } from '@dailytasks/shared-types';
import { formatDateTime, formatRelative, taskStatusDisplay } from '@/lib/format';
import { Stars } from './stars';
import { Badge, Empty } from './ui';
import { useT } from '@/lib/i18n';

export function StatusBadge({ task }: { task: Pick<TaskDto, 'status' | 'isOverdue' | 'completedLate'> }) {
  const { t } = useT();
  const s = taskStatusDisplay(task);
  return <Badge tone={s.tone}>{t(s.label)}</Badge>;
}

export function TaskTable({ tasks, showProject = true, emptyText = 'No tasks found' }: { tasks: TaskDto[]; showProject?: boolean; emptyText?: string }) {
  const { t: tr } = useT();
  if (tasks.length === 0) return <Empty title={tr(emptyText)} />;
  const showRating = tasks.some((t) => t.rating !== undefined);
  return (
    <div className="-mx-5 overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-start text-xs uppercase tracking-wide text-slate-500">
            <th className="px-5 py-2 font-medium">{tr('Task')}</th>
            {showProject && <th className="px-3 py-2 font-medium">{tr('Project')}</th>}
            <th className="px-3 py-2 font-medium">{tr('Assignee')}</th>
            <th className="px-3 py-2 font-medium">{tr('Deadline')}</th>
            <th className="px-3 py-2 font-medium">{tr('Status')}</th>
            {showRating && <th className="px-5 py-2 font-medium">{tr('Rating')}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {tasks.map((t) => (
            <tr key={t.id} className="hover:bg-slate-50">
              <td className="px-5 py-3">
                <Link href={`/tasks/${t.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                  {t.title}
                </Link>
                <div className="mt-0.5 flex gap-3 text-xs text-slate-400">
                  {t.commentCount > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" aria-hidden /> {t.commentCount}
                    </span>
                  )}
                  {t.attachmentCount > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <Paperclip className="h-3 w-3" aria-hidden /> {t.attachmentCount}
                    </span>
                  )}
                </div>
              </td>
              {showProject && <td className="px-3 py-3 text-slate-600">{t.projectName}</td>}
              <td className="px-3 py-3 text-slate-600">{t.assignee.name}</td>
              <td className="px-3 py-3 text-slate-600">
                <div>{formatDateTime(t.deadline)}</div>
                {t.status !== 'COMPLETED' && <div className={t.isOverdue ? 'text-xs text-red-600' : 'text-xs text-slate-400'}>{formatRelative(t.deadline)}</div>}
              </td>
              <td className="px-3 py-3">
                <StatusBadge task={t} />
              </td>
              {showRating && (
                <td className="px-5 py-3">
                  {t.status === 'COMPLETED' ? (
                    t.rating ? (
                      <Stars value={t.rating.stars} size={14} />
                    ) : (
                      <Badge tone="amber">{tr('Awaiting rating')}</Badge>
                    )
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
