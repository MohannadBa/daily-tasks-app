'use client';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { REALTIME_PATH, type RealtimeEvent } from '@dailytasks/shared-types';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { RealtimeClient, resolveRealtimeUrl, type RealtimeStatus } from '@/lib/realtime';
import { useFeedback } from './feedback';

const StatusContext = createContext<RealtimeStatus>('closed');
export const useRealtimeStatus = () => useContext(StatusContext);

const toastText: Partial<Record<RealtimeEvent['type'], string>> = {
  TASK_ASSIGNED: 'A new task was assigned to you',
  TASK_REASSIGNED: 'A task assignment changed',
  TASK_COMMENT_ADDED: 'New reply on a task',
  TASK_COMPLETED: 'A task was completed',
  TASK_REOPENED: 'A task was reopened',
  TASK_OVERDUE: 'A task is overdue',
  TASK_DEADLINE_APPROACHING: 'A deadline is approaching',
  TASK_SUBMITTED: 'Work was submitted for your review',
  TASK_SUBMISSION_FORWARDED: 'Work was forwarded for your approval',
  TASK_APPROVED: 'Your work was approved',
  TASK_REJECTED: 'Your submission was rejected',
  TASK_RETURNED: 'Work was returned to you',
  TASK_TRANSFER_REQUESTED: 'A colleague wants to transfer a task to you',
  TASK_TRANSFER_ACCEPTED: 'Your transfer was accepted',
  TASK_TRANSFER_DECLINED: 'Your transfer was declined',
  TASK_EXTENSION_REQUESTED: 'An extension was requested',
  TASK_EXTENSION_DECIDED: 'Your extension request was decided',
  REPORT_READY: 'Your report is ready',
};

/**
 * Keeps the open app in sync: on every event, refetch what it affects (notification count,
 * dashboard, task lists, the task itself). Web Push covers users who are away.
 */
export function RealtimeConnector({ url, children }: { url?: string; children: ReactNode }) {
  const qc = useQueryClient();
  const { toast } = useFeedback();
  const { t } = useT();
  const [status, setStatus] = useState<RealtimeStatus>('closed');

  useEffect(() => {
    if (typeof WebSocket === 'undefined') return;
    const client = new RealtimeClient({
      url: resolveRealtimeUrl(url, window.location, REALTIME_PATH),
      onStatus: setStatus,
      refreshSession: async () => {
        try {
          await api.auth.me(); // the BFF refreshes the session cookie when needed
          return true;
        } catch {
          return false;
        }
      },
      onEvent: (e) => {
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        void qc.invalidateQueries({ queryKey: ['dashboard'] });
        void qc.invalidateQueries({ queryKey: ['tasks'] });
        // Workflow surfaces (review inbox, transfers, documents, reports) refetch on any event.
        for (const k of ['reviews', 'transfers', 'documents', 'reports', 'submissions', 'extensions', 'task-time']) void qc.invalidateQueries({ queryKey: [k] });
        if (e.taskId) for (const k of ['task', 'comments', 'history']) void qc.invalidateQueries({ queryKey: [k, e.taskId] });
        if (e.projectId) void qc.invalidateQueries({ queryKey: ['project', e.projectId] });
        const text = toastText[e.type];
        if (text && document.visibilityState === 'visible') toast(t(text), 'info');
      },
    });
    client.start();
    const nudge = () => document.visibilityState === 'visible' && client.nudge();
    window.addEventListener('online', nudge);
    document.addEventListener('visibilitychange', nudge);
    return () => {
      window.removeEventListener('online', nudge);
      document.removeEventListener('visibilitychange', nudge);
      client.stop();
    };
  }, [url, qc, toast, t]);

  return <StatusContext.Provider value={status}>{children}</StatusContext.Provider>;
}
