/**
 * Shared domain types used by the API, worker and web app (PWA).
 * Enum values mirror the Prisma schema in packages/database/prisma/schema.prisma.
 */

export const UserRole = {
  COMPANY_ADMIN: 'COMPANY_ADMIN',
  PROJECT_MANAGER: 'PROJECT_MANAGER',
  EMPLOYEE: 'EMPLOYEE',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const ProjectRole = {
  MANAGER: 'MANAGER',
  EMPLOYEE: 'EMPLOYEE',
} as const;
export type ProjectRole = (typeof ProjectRole)[keyof typeof ProjectRole];

export const TaskStatus = {
  ASSIGNED: 'ASSIGNED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const ProjectStatus = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export const NotificationType = {
  TASK_ASSIGNED: 'TASK_ASSIGNED',
  TASK_UPDATED: 'TASK_UPDATED',
  TASK_REASSIGNED: 'TASK_REASSIGNED',
  TASK_COMMENT_ADDED: 'TASK_COMMENT_ADDED',
  TASK_COMPLETED: 'TASK_COMPLETED',
  TASK_OVERDUE: 'TASK_OVERDUE',
  TASK_DEADLINE_APPROACHING: 'TASK_DEADLINE_APPROACHING',
  TASK_REOPENED: 'TASK_REOPENED',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const TaskHistoryAction = {
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  DEADLINE_CHANGED: 'DEADLINE_CHANGED',
  REASSIGNED: 'REASSIGNED',
  STARTED: 'STARTED',
  COMMENTED: 'COMMENTED',
  ATTACHMENT_ADDED: 'ATTACHMENT_ADDED',
  COMPLETED: 'COMPLETED',
  REOPENED: 'REOPENED',
} as const;
export type TaskHistoryAction = (typeof TaskHistoryAction)[keyof typeof TaskHistoryAction];

export type DevicePlatform = 'IOS' | 'ANDROID' | 'WEB';
export type Locale = 'en' | 'ar';

/** Task "views" supported by GET /tasks?view=... */
export type TaskView = 'all' | 'active' | 'completed' | 'overdue' | 'awaiting_rating';

export interface UserSummary {
  id: string;
  name: string;
  email: string;
}

export interface CurrentUser extends UserSummary {
  role: UserRole;
  locale: Locale;
  companyId: string;
  companyName: string;
  /** Project ids where the user is an active MANAGER member. */
  managedProjectIds: string[];
  /** Project ids where the user is an active EMPLOYEE member. */
  employeeProjectIds: string[];
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type LoginResponse =
  | ({ status: 'OK'; user: CurrentUser } & AuthTokens)
  | { status: 'NEW_PASSWORD_REQUIRED'; session: string; email: string };

export interface UserDto extends UserSummary {
  role: UserRole;
  locale: Locale;
  isActive: boolean;
  createdAt: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  /** Role of the current user in this project (null for admins who are not members). */
  myRole: ProjectRole | null;
  memberCount: number;
  openTaskCount: number;
}

export interface ProjectMemberDto {
  userId: string;
  name: string;
  email: string;
  role: ProjectRole;
  joinedAt: string;
}

export interface AttachmentDto {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: UserSummary;
  commentId: string | null;
  createdAt: string;
}

export interface TaskCommentDto {
  id: string;
  body: string;
  isCompletionNote: boolean;
  author: UserSummary;
  attachments: AttachmentDto[];
  createdAt: string;
}

export interface TaskDto {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  description: string;
  deadline: string;
  status: TaskStatus;
  assignee: UserSummary;
  createdBy: UserSummary;
  startedAt: string | null;
  completedAt: string | null;
  /** True when completedAt > deadline. Preserved permanently once set. */
  completedLate: boolean | null;
  /** Derived: not completed and deadline has passed. */
  isOverdue: boolean;
  reopenCount: number;
  attachmentCount: number;
  commentCount: number;
  /** Only present for managers/admins. Never returned to employees. */
  rating?: { stars: number; ratedAt: string; needsReview: boolean } | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetailDto extends TaskDto {
  /** Manager-provided attachments (not linked to a comment). */
  attachments: AttachmentDto[];
  permissions: {
    canEdit: boolean;
    canComment: boolean;
    canComplete: boolean;
    canStart: boolean;
    canReopen: boolean;
    canRate: boolean;
  };
}

export interface TaskHistoryDto {
  id: string;
  action: TaskHistoryAction;
  actor: UserSummary | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TaskRatingDto {
  id: string;
  taskId: string;
  stars: number;
  feedback: string | null;
  employee: UserSummary;
  ratedBy: UserSummary;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRatingRevisionDto {
  id: string;
  taskId: string;
  taskTitle: string;
  changedBy: UserSummary;
  previousStars: number | null;
  newStars: number;
  previousFeedback: string | null;
  newFeedback: string | null;
  createdAt: string;
}

export interface EmployeePerformanceSummaryDto {
  employee: UserSummary;
  /** null when the employee has no rated completed tasks. */
  averageRating: number | null;
  ratedTaskCount: number;
  completedTaskCount: number;
  openTaskCount: number;
  overdueTaskCount: number;
}

export interface EmployeePerformanceDetailDto extends EmployeePerformanceSummaryDto {
  ratings: Array<{
    taskId: string;
    taskTitle: string;
    projectId: string;
    projectName: string;
    stars: number;
    feedback: string | null;
    ratedBy: UserSummary;
    completedAt: string | null;
    completedLate: boolean | null;
    ratedAt: string;
  }>;
  history: TaskRatingRevisionDto[];
}

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  taskId: string | null;
  projectId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface DashboardDto {
  role: UserRole;
  totals: {
    projects: number;
    activeTasks: number;
    completedTasks: number;
    overdueTasks: number;
    awaitingRating: number;
  };
  /** Present only for admins/managers. */
  performance?: EmployeePerformanceSummaryDto[];
  upcoming: TaskDto[];
}

export interface CompanySettingsDto {
  id: string;
  name: string;
  timezone: string;
  /** Minutes before the deadline at which reminders are sent (e.g. [1440, 60]). */
  reminderOffsetsMinutes: number[];
}

export interface UploadUrlResponse {
  attachmentId: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresIn: number;
}

export interface DownloadUrlResponse {
  url: string;
  expiresIn: number;
}

/** Payload placed in push notification `data` and used for deep links. */
export interface PushData {
  notificationId: string;
  type: NotificationType;
  taskId?: string;
  url: string;
}

export function taskDeepLink(taskId: string): string {
  return `dailytasks://tasks/${taskId}`;
}
