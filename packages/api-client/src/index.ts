import type {
  AttachmentDto,
  CompanySettingsDto,
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
      updateProfile: (body: { name?: string; locale?: 'en' | 'ar' }) => patch<CurrentUser>('/me', body),
    },
    users: {
      list: (query?: { role?: string; q?: string }) => get<UserDto[]>('/users', query),
      invite: (body: { email: string; name: string; role: string; locale?: string; temporaryPassword?: string }) => post<UserDto>('/users', body),
      update: (id: string, body: { name?: string; role?: string; isActive?: boolean }) => patch<UserDto>(`/users/${id}`, body),
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
      list: (query?: { projectId?: string; assigneeId?: string; status?: string; view?: string; q?: string; page?: number; pageSize?: number }) =>
        get<Paginated<TaskDto>>('/tasks', query),
      get: (id: string) => get<TaskDetailDto>(`/tasks/${id}`),
      create: (body: { projectId: string; assigneeId: string; title: string; description?: string; deadline: string }) => post<TaskDetailDto>('/tasks', body),
      update: (id: string, body: { title?: string; description?: string; deadline?: string }) => patch<TaskDetailDto>(`/tasks/${id}`, body),
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
    attachments: {
      confirm: (id: string) => post<AttachmentDto>(`/attachments/${id}/confirm`),
      downloadUrl: (id: string) => get<DownloadUrlResponse>(`/attachments/${id}/download-url`),
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
    devices: {
      register: (body: { expoPushToken: string; platform: 'IOS' | 'ANDROID' | 'WEB'; deviceName?: string | null; locale?: 'en' | 'ar' }) =>
        post<{ id: string }>('/devices', body),
      unregister: (expoPushToken: string) => request<void>('DELETE', '/devices', { expoPushToken }),
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
