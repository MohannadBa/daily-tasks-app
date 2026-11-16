/**
 * Contract between the API (which builds an already-authorized dataset) and the worker (which only
 * renders it to PDF). Everything in here is safe to show to the requester: rating fields are present
 * only when `includesRatings` was decided true by the API (admins / managers of the project).
 */
export interface ReportPerson {
  name: string;
  email?: string;
}

export interface ReportCycle {
  cycleNo: number;
  startedAt: string;
  originalDeadline: string;
  approvedDeadline: string;
  budgetMs: number;
  accountableMs: number;
  lateMs: number;
  completedAt: string | null;
  completedLate: boolean | null;
  reopenReason: string | null;
  perEmployee: Array<{ name: string; chargedMs: number; lateMs: number }>;
}

export interface ReportTask {
  id: string;
  title: string;
  description?: string | null;
  project: string;
  department: string | null;
  priority: string;
  status: string;
  assignee: ReportPerson;
  approver: ReportPerson;
  createdBy: ReportPerson;
  createdAt: string;
  originalDeadline: string;
  deadline: string;
  completedAt: string | null;
  completedLate: boolean | null;
  budgetMs: number;
  accountableMs: number;
  overdueMs: number;
  cycles: ReportCycle[];
  submissions: Array<{ createdAt: string; by: string; stage: string; status: string; reviewer: string; decidedBy: string | null; decidedAt: string | null; reason: string | null; comment: string }>;
  transfers: Array<{ requestedAt: string; from: string; to: string; reason: string; status: string; respondedAt: string | null; note: string | null }>;
  extensions: Array<{ createdAt: string; by: string; reason: string; requestedMinutes: number; status: string; grantedMinutes: number | null; previousDeadline: string; newDeadline: string | null; decidedBy: string | null; note: string | null }>;
  /** Detailed (single task) reports only. */
  history?: Array<{ at: string; action: string; actor: string | null }>;
  comments?: Array<{ at: string; author: string; body: string; attachments: string[] }>;
  attachments?: Array<{ fileName: string; sizeBytes: number; uploadedBy: string }>;
  /** Only when includesRatings. */
  rating?: { stars: number; feedback: string | null } | null;
}

export interface ReportDataset {
  version: 1;
  type: 'TASK' | 'EMPLOYEE' | 'PROJECTS';
  locale: 'ar' | 'en';
  generatedAt: string;
  generatedBy: ReportPerson;
  companyName: string;
  includesRatings: boolean;
  /** Human-readable filters (already localized keys/values). */
  filters: Array<{ key: string; value: string }>;
  subject: { name: string; email?: string; detail?: string } | null;
  summary: {
    total: number;
    completed: number;
    completedOnTime: number;
    completedLate: number;
    open: number;
    overdueOpen: number;
    pendingReview: number;
    transfers: number;
    extensions: number;
    accountableMs: number;
    averageRating?: number | null;
  };
  tasks: ReportTask[];
  truncated: boolean;
}
