import type {
  AttachmentDto,
  AuditEntryDto,
  CompanySettingsDto,
  CreatedUserDto,
  DepartmentDto,
  DepartmentMemberDto,
  DocumentCategoryDto,
  ExtensionDto,
  PersonalTaskDto,
  ProjectDocumentDto,
  ReportJobDto,
  ReviewItemDto,
  SubmissionDto,
  TaskTimeLedgerDto,
  TransferDto,
  UserSummary,
  CurrentUser,
  DashboardDto,
  DownloadUrlResponse,
  EmployeePerformanceDetailDto,
  EmployeePerformanceSummaryDto,
  LoginResponse,
  NotificationDto,
  Paginated,
  ProjectDto,
  ProjectMemberDto,
  PushStatusDto,
  TaskCommentDto,
  TaskDetailDto,
  TaskDto,
  TaskHistoryDto,
  TaskRatingDto,
  UploadUrlResponse,
  UserDto,
  AuthTokens,
} from '@dailytasks/shared-types';

export * from '@dailytasks/shared-types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  /** e.g. /bff (web BFF proxy, used by the PWA) or http://localhost:3000/api/v1 (direct, e.g. scripts/tests). */
  baseUrl: string;
  /** Returns the current access token, if the client manages bearer tokens itself. */
  getAccessToken?: () => Promise<string | null> | string | null;
  /** Called once on 401; should refresh tokens and return true if a retry is worthwhile. */
  onUnauthorized?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  /** Accept-Language header value. */
  getLocale?: () => string | undefined;
}

type Query = Record<string, string | number | boolean | undefined | null>;

function qs(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request<T>(method: string, path: string, body?: unknown, query?: Query, retried = false): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = options.getAccessToken ? await options.getAccessToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
    const locale = options.getLocale?.();
    if (locale) headers['Accept-Language'] = locale;

    const res = await doFetch(`${options.baseUrl}${path}${qs(query)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
    });

    if (res.status === 401 && !retried && options.onUnauthorized) {
      const ok = await options.onUnauthorized();
      if (ok) return request<T>(method, path, body, query, true);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const msg = errorMessage(data) || res.statusText || 'Request failed';
      throw new ApiError(res.status, msg, data);
    }
    return data as T;
  }

  const get = <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query);
  const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
  const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);
  const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body);
  const del = <T>(path: string) => request<T>('DELETE', path);

  return {
    request,
    auth: {
      login: (email: string, password: string) => post<LoginResponse>('/auth/login', { email, password }),
      refresh: (refreshToken: string) => post<AuthTokens>('/auth/refresh', { refreshToken }),
      completeNewPassword: (email: string, session: string, newPassword: string) =>
        post<LoginResponse>('/auth/new-password', { email, session, newPassword }),
      me: () => get<CurrentUser>('/auth/me'),
      changePassword: (currentPassword: string, newPassword: string) => post<void>('/auth/change-password', { currentPassword, newPassword }),
      updateProfile: (body: { name?: string; locale?: 'en' | 'ar' }) => patch<CurrentUser>('/me', body),
    },
    users: {
      list: (query?: { role?: string; q?: string; departmentId?: string }) => get<UserDto[]>('/users', query),
      get: (id: string) => get<UserDto>(`/users/${id}`),
      /** temporaryPassword is present only once, when passwordDelivery = SHOW_ONCE. */
      invite: (body: {
        email: string;
        name: string;
        role: string;
        locale?: string;
        temporaryPassword?: string;
        passwordDelivery?: 'EMAIL' | 'SHOW_ONCE';
        departments?: Array<{ departmentId: string; isPrimary?: boolean }>;
        projects?: Array<{ projectId: string; role: 'MANAGER' | 'EMPLOYEE' }>;
      }) => post<CreatedUserDto>('/users', body),
      resetPassword: (id: string, body: { temporaryPassword?: string; passwordDelivery?: 'EMAIL' | 'SHOW_ONCE' }) =>
        post<{ mode: 'email' | 'temporary'; temporaryPassword?: string }>(`/users/${id}/reset-password`, body),
      update: (id: string, body: { name?: string; role?: string; isActive?: boolean }) => patch<UserDto>(`/users/${id}`, body),
      setDepartments: (id: string, departments: Array<{ departmentId: string; isPrimary?: boolean }>) => put<UserDto>(`/users/${id}/departments`, { departments }),
      audit: (id: string) => get<AuditEntryDto[]>(`/users/${id}/audit`),
    },
    departments: {
      list: (query?: { includeInactive?: boolean }) => get<DepartmentDto[]>('/departments', query),
      create: (body: { code: string; nameAr: string; nameEn: string; sortOrder?: number }) => post<DepartmentDto>('/departments', body),
      update: (id: string, body: { nameAr?: string; nameEn?: string; isActive?: boolean; sortOrder?: number }) => patch<DepartmentDto>(`/departments/${id}`, body),
      members: (id: string) => get<DepartmentMemberDto[]>(`/departments/${id}/members`),
      assignableEmployees: (id: string, projectId: string) => get<UserSummary[]>(`/departments/${id}/assignable-employees`, { projectId }),
    },
    projects: {
      list: () => get<ProjectDto[]>('/projects'),
      get: (id: string) => get<ProjectDto>(`/projects/${id}`),
      create: (body: { name: string; description?: string | null }) => post<ProjectDto>('/projects', body),
      update: (id: string, body: { name?: string; description?: string | null; status?: string }) => patch<ProjectDto>(`/projects/${id}`, body),
      members: (id: string) => get<ProjectMemberDto[]>(`/projects/${id}/members`),
      addMember: (id: string, body: { userId: string; role: 'MANAGER' | 'EMPLOYEE' }) => post<ProjectMemberDto>(`/projects/${id}/members`, body),
      removeMember: (id: string, userId: string) => del<void>(`/projects/${id}/members/${userId}`),
    },
    tasks: {
      list: (query?: { projectId?: string; assigneeId?: string; departmentId?: string; priority?: string; status?: string; view?: string; sort?: string; q?: string; page?: number; pageSize?: number }) =>
        get<Paginated<TaskDto>>('/tasks', query),
      get: (id: string) => get<TaskDetailDto>(`/tasks/${id}`),
      create: (body: { projectId: string; departmentId: string; assigneeId: string; title: string; description?: string; deadline: string; priority?: string; approverId?: string }) =>
        post<TaskDetailDto>('/tasks', body),
      update: (id: string, body: { title?: string; description?: string; deadline?: string; priority?: string; departmentId?: string }) => patch<TaskDetailDto>(`/tasks/${id}`, body),
      changeApprover: (id: string, approverId: string) => patch<TaskDetailDto>(`/tasks/${id}/approver`, { approverId }),
      submit: (id: string, body: { comment: string; attachmentIds?: string[] }) => post<SubmissionDto>(`/tasks/${id}/submissions`, body),
      submissions: (id: string) => get<SubmissionDto[]>(`/tasks/${id}/submissions`),
      requestTransfer: (id: string, body: { toUserId: string; reason: string }) => post<TransferDto>(`/tasks/${id}/transfers`, body),
      transfers: (id: string) => get<TransferDto[]>(`/tasks/${id}/transfers`),
      transferCandidates: (id: string) => get<UserSummary[]>(`/tasks/${id}/transfer-candidates`),
      requestExtension: (id: string, body: { requestedMinutes?: number; requestedDeadline?: string; reason: string }) => post<ExtensionDto>(`/tasks/${id}/extensions`, body),
      extensions: (id: string) => get<ExtensionDto[]>(`/tasks/${id}/extensions`),
      time: (id: string) => get<TaskTimeLedgerDto>(`/tasks/${id}/time`),
      reassign: (id: string, assigneeId: string) => post<TaskDetailDto>(`/tasks/${id}/reassign`, { assigneeId }),
      start: (id: string) => post<TaskDetailDto>(`/tasks/${id}/start`),
      complete: (id: string, body: { comment: string; attachmentIds?: string[] }) => post<TaskDetailDto>(`/tasks/${id}/complete`, body),
      reopen: (id: string, body: { reason: string; deadline?: string }) => post<TaskDetailDto>(`/tasks/${id}/reopen`, body),
      comments: (id: string) => get<TaskCommentDto[]>(`/tasks/${id}/comments`),
      addComment: (id: string, body: { body: string; attachmentIds?: string[] }) => post<TaskCommentDto>(`/tasks/${id}/comments`, body),
      history: (id: string) => get<TaskHistoryDto[]>(`/tasks/${id}/history`),
      attachments: (id: string) => get<AttachmentDto[]>(`/tasks/${id}/attachments`),
      requestUpload: (id: string, body: { fileName: string; contentType: string; sizeBytes: number }) =>
        post<UploadUrlResponse>(`/tasks/${id}/attachments/upload-url`, body),
      getRating: (id: string) => get<TaskRatingDto | null>(`/tasks/${id}/rating`),
      rate: (id: string, body: { stars: number; feedback?: string | null }) => put<TaskRatingDto>(`/tasks/${id}/rating`, body),
    },
    submissions: {
      forward: (id: string, body: { note?: string; attachmentIds?: string[] } = {}) => post<SubmissionDto>(`/submissions/${id}/forward`, body),
      returnToDelegate: (id: string, reason: string) => post<SubmissionDto>(`/submissions/${id}/return`, { reason }),
      approve: (id: string, body: { note?: string; adminReason?: string } = {}) => post<SubmissionDto>(`/submissions/${id}/approve`, body),
      reject: (id: string, body: { reason: string; adminReason?: string }) => post<SubmissionDto>(`/submissions/${id}/reject`, body),
      withdraw: (id: string) => post<SubmissionDto>(`/submissions/${id}/withdraw`),
    },
    reviews: {
      /** Pending submissions addressed to me (as delegator or approver). */
      inbox: () => get<ReviewItemDto[]>('/me/reviews'),
    },
    transfers: {
      incoming: () => get<TransferDto[]>('/me/transfers'),
      accept: (id: string, note?: string) => post<TransferDto>(`/transfers/${id}/accept`, { note }),
      decline: (id: string, reason: string) => post<TransferDto>(`/transfers/${id}/decline`, { reason }),
      cancel: (id: string, note?: string) => post<TransferDto>(`/transfers/${id}/cancel`, { note }),
    },
    extensions: {
      decide: (id: string, body: { decision: 'APPROVE' | 'PARTIAL' | 'REJECT'; grantedMinutes?: number; note?: string }) => post<ExtensionDto>(`/extensions/${id}/decide`, body),
      cancel: (id: string) => post<ExtensionDto>(`/extensions/${id}/cancel`),
    },
    documents: {
      categories: () => get<DocumentCategoryDto[]>('/document-categories'),
      list: (projectId: string, query?: { q?: string; categoryId?: string; source?: string; departmentId?: string; taskId?: string; sort?: string; page?: number; pageSize?: number }) =>
        get<Paginated<ProjectDocumentDto>>(`/projects/${projectId}/documents`, query),
      get: (id: string) => get<ProjectDocumentDto>(`/documents/${id}`),
      requestUpload: (projectId: string, body: { title: string; description?: string | null; categoryId: string; visibility?: string; fileName: string; contentType: string; sizeBytes: number }) =>
        post<{ documentId: string; uploadUrl: string; method: 'PUT'; headers: Record<string, string>; expiresIn: number }>(`/projects/${projectId}/documents/upload-url`, body),
      confirm: (id: string) => post<ProjectDocumentDto>(`/documents/${id}/confirm`),
      update: (id: string, body: { title?: string; description?: string | null; categoryId?: string; visibility?: string }) => patch<ProjectDocumentDto>(`/documents/${id}`, body),
      archive: (id: string) => post<void>(`/documents/${id}/archive`),
      downloadUrl: (id: string, preview = false) => get<DownloadUrlResponse & { inline?: boolean }>(`/documents/${id}/download-url`, preview ? { preview: 'true' } : undefined),
    },
    personalTasks: {
      list: (query?: { status?: 'OPEN' | 'DONE'; q?: string; page?: number; pageSize?: number }) => get<Paginated<PersonalTaskDto>>('/me/personal-tasks', query),
      create: (body: { title: string; notes?: string | null; dueAt?: string | null; priority?: string }) => post<PersonalTaskDto>('/me/personal-tasks', body),
      update: (id: string, body: { title?: string; notes?: string | null; dueAt?: string | null; priority?: string }) => patch<PersonalTaskDto>(`/me/personal-tasks/${id}`, body),
      complete: (id: string) => post<PersonalTaskDto>(`/me/personal-tasks/${id}/complete`),
      reopen: (id: string) => post<PersonalTaskDto>(`/me/personal-tasks/${id}/reopen`),
      remove: (id: string) => del<void>(`/me/personal-tasks/${id}`),
    },
    reports: {
      request: (body: Record<string, unknown> & { type: 'TASK' | 'EMPLOYEE' | 'PROJECTS' }) => post<ReportJobDto>('/reports', body),
      get: (id: string) => get<ReportJobDto>(`/reports/${id}`),
      mine: () => get<ReportJobDto[]>('/me/reports'),
      downloadUrl: (id: string) => get<DownloadUrlResponse>(`/reports/${id}/download-url`),
    },
    attachments: {
      confirm: (id: string) => post<AttachmentDto>(`/attachments/${id}/confirm`),
      /** preview=true: inline URL for images/PDF (in-app thumbnails and viewer). */
      downloadUrl: (id: string, preview = false) => get<DownloadUrlResponse & { inline?: boolean }>(`/attachments/${id}/download-url`, preview ? { preview: 'true' } : undefined),
    },
    performance: {
      employees: (projectId?: string) => get<EmployeePerformanceSummaryDto[]>('/performance/employees', { projectId }),
      employee: (userId: string, projectId?: string) => get<EmployeePerformanceDetailDto>(`/performance/employees/${userId}`, { projectId }),
    },
    notifications: {
      list: (query?: { unreadOnly?: boolean; page?: number; pageSize?: number }) => get<Paginated<NotificationDto>>('/notifications', query),
      unreadCount: () => get<{ count: number }>('/notifications/unread-count'),
      markRead: (id: string) => post<void>(`/notifications/${id}/read`),
      markAllRead: () => post<void>('/notifications/read-all'),
    },
    push: {
      vapidPublicKey: () => get<{ enabled: boolean; publicKey: string | null }>('/push/vapid-public-key'),
      status: () => get<PushStatusDto>('/push/status'),
      /** Body is PushSubscription.toJSON() from the browser. */
      subscribe: (body: { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }) =>
        post<{ id: string; endpointHash: string }>('/push/subscribe', body),
      unsubscribe: (body: { endpoint: string } | { id: string }) => request<void>('DELETE', '/push/unsubscribe', body),
      /** 202 = queued for delivery, not proof of delivery. */
      test: () => post<{ queued: boolean; subscriptions: number }>('/push/test'),
    },
    dashboard: {
      get: () => get<DashboardDto>('/dashboard'),
    },
    company: {
      settings: () => get<CompanySettingsDto>('/company/settings'),
      updateSettings: (body: { name?: string; timezone?: string; reminderOffsetsMinutes?: number[] }) =>
        patch<CompanySettingsDto>('/company/settings', body),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function errorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || !('message' in data)) return undefined;
  const m = (data as { message: unknown }).message;
  return Array.isArray(m) ? m.map(String).join(', ') : String(m);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/**
 * Uploads a file through the pre-signed-URL flow:
 *   1. ask the API for an upload URL (validates type/size, creates a PENDING attachment)
 *   2. PUT the bytes directly to S3
 *   3. confirm, so the API verifies the stored object and marks it UPLOADED
 */
export async function uploadAttachment(
  api: ApiClient,
  taskId: string,
  file: { name: string; type: string; size: number; body: Blob | ArrayBuffer | Uint8Array },
  fetchImpl: typeof fetch = fetch,
): Promise<AttachmentDto> {
  const { attachmentId, uploadUrl, headers } = await api.tasks.requestUpload(taskId, {
    fileName: file.name,
    contentType: file.type,
    sizeBytes: file.size,
  });
  const put = await fetchImpl(uploadUrl, { method: 'PUT', headers, body: file.body as BodyInit });
  if (!put.ok) throw new ApiError(put.status, 'File upload failed');
  return api.attachments.confirm(attachmentId);
}
