import { z } from 'zod';
import {
  ALLOWED_ATTACHMENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_REQUEST,
  MAX_REMINDER_OFFSET_MINUTES,
  MAX_REMINDER_OFFSETS,
} from '@dailytasks/config';

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const uuid = z.string().uuid();
const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((v) => new Date(v));

/* ---------------------------- Auth ---------------------------- */

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.input<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(10).max(8192) });

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[0-9]/, 'Password must contain a number');

export const newPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  session: z.string().min(1),
  newPassword: passwordSchema,
});

export const forgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().email() });

export const resetPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().trim().regex(/^\d{4,10}$/, 'Enter the code from the e-mail'),
  newPassword: passwordSchema,
});

/** Admin-initiated reset. In local auth mode the admin sets a temporary password. */
export const adminResetPasswordSchema = z.object({
  /** Legacy local-mode: admin-chosen temporary password. */
  temporaryPassword: passwordSchema.optional(),
  passwordDelivery: z.enum(['EMAIL', 'SHOW_ONCE']).optional(),
});

export const updateProfileSchema = z
  .object({
    name: trimmed(1, 120).optional(),
    locale: z.enum(['en', 'ar']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/* ---------------------------- Users ---------------------------- */

export const roleSchema = z.enum(['ADMIN', 'PROJECT_MANAGER', 'EMPLOYEE']);

/** EMAIL: Cognito generates and e-mails the temporary password. SHOW_ONCE: returned once in the response. */
export const passwordDeliverySchema = z.enum(['EMAIL', 'SHOW_ONCE']);

const departmentAssignment = z
  .array(z.object({ departmentId: uuid, isPrimary: z.boolean().default(false) }))
  .max(10)
  .refine((d) => new Set(d.map((x) => x.departmentId)).size === d.length, 'Duplicate department')
  .refine((d) => d.length === 0 || d.filter((x) => x.isPrimary).length === 1, 'Exactly one primary department is required');

export const inviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: trimmed(1, 120),
  role: roleSchema,
  locale: z.enum(['en', 'ar']).default('ar'),
  /** Legacy (local auth mode): admin-chosen temporary password. Never returned or logged. */
  temporaryPassword: passwordSchema.optional(),
  passwordDelivery: passwordDeliverySchema.optional(),
  departments: departmentAssignment.default([]),
  projects: z.array(z.object({ projectId: uuid, role: z.enum(['MANAGER', 'EMPLOYEE']) })).max(50).default([]),
});

export const userDepartmentsSchema = z.object({ departments: departmentAssignment.refine((d) => d.length > 0, 'At least one department') });

export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema });

/* -------------------------- Departments ------------------------- */

export const createDepartmentSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z_]{1,39}$/, 'Code: 2-40 letters/underscores'),
  nameAr: trimmed(1, 120),
  nameEn: trimmed(1, 120),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});
export const updateDepartmentSchema = z
  .object({ nameAr: trimmed(1, 120).optional(), nameEn: trimmed(1, 120).optional(), isActive: z.boolean().optional(), sortOrder: z.number().int().min(0).max(10000).optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const assignableQuerySchema = z.object({ projectId: uuid });
export type InviteUserInput = z.input<typeof inviteUserSchema>;

export const updateUserSchema = z
  .object({
    name: trimmed(1, 120).optional(),
    role: roleSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/* --------------------------- Projects -------------------------- */

export const createProjectSchema = z.object({
  name: trimmed(1, 160),
  description: z.string().trim().max(4000).optional().nullable(),
});
export type CreateProjectInput = z.input<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: trimmed(1, 160).optional(),
    description: z.string().trim().max(4000).optional().nullable(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const addMemberSchema = z.object({
  userId: uuid,
  role: z.enum(['MANAGER', 'EMPLOYEE']),
});

/* ----------------------------- Tasks ---------------------------- */

export const prioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

export const createTaskSchema = z.object({
  departmentId: uuid,
  projectId: uuid,
  assigneeId: uuid,
  title: trimmed(1, 200),
  description: z.string().trim().max(10000).default(''),
  priority: prioritySchema.default('MEDIUM'),
  deadline: isoDate,
  /** ADMIN only: approver other than the creator (must be ADMIN or a manager of the project). */
  approverId: uuid.optional(),
});
export type CreateTaskInput = z.input<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: trimmed(1, 200).optional(),
    description: z.string().trim().max(10000).optional(),
    deadline: isoDate.optional(),
    priority: prioritySchema.optional(),
    departmentId: uuid.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const changeApproverSchema = z.object({ approverId: uuid });
export type UpdateTaskInput = z.input<typeof updateTaskSchema>;

export const reassignTaskSchema = z.object({ assigneeId: uuid });

export const reopenTaskSchema = z.object({
  reason: trimmed(1, 2000),
  deadline: isoDate.optional(),
});
export type ReopenTaskInput = z.input<typeof reopenTaskSchema>;

const attachmentIds = z.array(uuid).max(ATTACHMENT_MAX_PER_REQUEST).default([]);

export const createCommentSchema = z.object({
  body: trimmed(1, 5000),
  attachmentIds,
});
export type CreateCommentInput = z.input<typeof createCommentSchema>;

/** Completion requires a non-empty comment; attachments optional. */
export const completeTaskSchema = z.object({
  comment: z
    .string({ required_error: 'A completion comment is required' })
    .trim()
    .min(1, 'A completion comment is required')
    .max(5000),
  attachmentIds,
});
export type CompleteTaskInput = z.input<typeof completeTaskSchema>;

export const taskListQuerySchema = z.object({
  projectId: uuid.optional(),
  assigneeId: uuid.optional(),
  status: z.enum(['ASSIGNED', 'IN_PROGRESS', 'COMPLETED']).optional(),
  view: z.enum(['all', 'active', 'completed', 'overdue', 'awaiting_rating', 'pending_review', 'to_review', 'rejected']).default('all'),
  /** Sort order; default depends on the view (deadline ascending, or latest completion). */
  sort: z.enum(['deadline', '-deadline', '-created', '-updated', 'title']).optional(),
  departmentId: uuid.optional(),
  priority: prioritySchema.optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type TaskListQuery = z.input<typeof taskListQuerySchema>;

/* -------------------------- Attachments ------------------------- */

export function fileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx === -1 ? '' : fileName.slice(idx + 1).toLowerCase();
}

export const uploadRequestSchema = z
  .object({
    // No path separators or NUL bytes in file names.
    fileName: trimmed(1, 255).refine((n) => !n.includes('/') && !n.includes('\\') && !n.includes('\0'), 'Invalid file name'),
    contentType: z.string().trim().toLowerCase(),
    sizeBytes: z.number().int().positive().max(ATTACHMENT_MAX_BYTES, `Files must be at most ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`),
  })
  .superRefine((v, ctx) => {
    const allowedExt = ALLOWED_ATTACHMENT_TYPES[v.contentType];
    if (!allowedExt) {
      ctx.addIssue({ code: 'custom', path: ['contentType'], message: 'File type is not allowed' });
      return;
    }
    if (!allowedExt.includes(fileExtension(v.fileName))) {
      ctx.addIssue({ code: 'custom', path: ['fileName'], message: 'File extension does not match the file type' });
    }
  });
export type UploadRequestInput = z.input<typeof uploadRequestSchema>;

/* ---------------------------- Ratings --------------------------- */

export const ratingSchema = z.object({
  stars: z.number().int().min(1, 'Minimum rating is 1').max(5, 'Maximum rating is 5'),
  feedback: z.string().trim().max(4000).optional().nullable(),
});
export type RatingInput = z.input<typeof ratingSchema>;

export const performanceQuerySchema = z.object({ projectId: uuid.optional() });

/* ------------------------- Notifications ------------------------ */

const base64url = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Must be base64url')
    .min(min)
    .max(max);

/**
 * Browser PushSubscription.toJSON() (W3C Push API). p256dh is an uncompressed P-256 point
 * (65 bytes -> 87 base64url chars), auth a 16-byte secret (22 chars).
 * The endpoint's host is additionally checked against the push-service allow-list by the API.
 */
export const pushSubscribeSchema = z.object({
  endpoint: z.string().trim().url().max(2048).regex(/^https?:\/\//, 'Endpoint must be an http(s) URL'),
  expirationTime: z.number().int().positive().nullable().optional(),
  keys: z.object({
    p256dh: base64url(80, 100),
    auth: base64url(16, 32),
  }),
});
export type PushSubscribeInput = z.input<typeof pushSubscribeSchema>;

/** Remove this browser's subscription (endpoint) or one of the user's devices (id). */
export const pushUnsubscribeSchema = z
  .object({ endpoint: z.string().trim().max(2048).optional(), id: z.string().uuid().optional() })
  .refine((v) => !!v.endpoint !== !!v.id, 'Provide exactly one of endpoint or id');

export const notificationListQuerySchema = z.object({
  unreadOnly: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

/* ---------------------------- Company --------------------------- */

export const updateCompanySettingsSchema = z
  .object({
    name: trimmed(1, 160).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    reminderOffsetsMinutes: z
      .array(z.number().int().min(1).max(MAX_REMINDER_OFFSET_MINUTES))
      .max(MAX_REMINDER_OFFSETS)
      .transform((arr) => Array.from(new Set(arr)).sort((a, b) => b - a))
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export { z };


/* -------------------------- Workflow ---------------------------- */

const reason = z.string().trim().min(1, 'A reason is required').max(2000);

/** Completion submission: mandatory non-empty comment, optional attachments. */
export const submitTaskSchema = z.object({
  comment: z.string().trim().min(1, 'A completion comment is required').max(10000),
  attachmentIds: z.array(uuid).max(ATTACHMENT_MAX_PER_REQUEST).default([]),
});
export const forwardSubmissionSchema = z.object({
  note: z.string().trim().max(2000).optional(),
  attachmentIds: z.array(uuid).max(ATTACHMENT_MAX_PER_REQUEST).default([]),
});
export const decisionReasonSchema = z.object({ reason });
export const approveSubmissionSchema = z.object({
  note: z.string().trim().max(2000).optional(),
  /** Required when an ADMIN decides instead of the approver (break-glass). */
  adminReason: z.string().trim().max(2000).optional(),
});
export const rejectSubmissionSchema = z.object({ reason, adminReason: z.string().trim().max(2000).optional() });

export const transferRequestSchema = z.object({ toUserId: uuid, reason });
export const transferResponseSchema = z.object({ note: z.string().trim().max(2000).optional() });
export const transferDeclineSchema = z.object({ reason });

export const extensionRequestSchema = z
  .object({
    requestedMinutes: z.number().int().min(15).max(43200).optional(),
    requestedDeadline: isoDate.optional(),
    reason,
  })
  .refine((v) => (v.requestedMinutes === undefined) !== (v.requestedDeadline === undefined), 'Provide requestedMinutes or requestedDeadline');
export const extensionDecisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'PARTIAL', 'REJECT']),
    grantedMinutes: z.number().int().min(1).max(43200).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.decision !== 'PARTIAL' || v.grantedMinutes !== undefined, 'grantedMinutes is required for a partial approval')
  .refine((v) => v.decision !== 'REJECT' || (v.note?.length ?? 0) > 0, 'A reason (note) is required to reject');

/* -------------------------- Documents --------------------------- */

export const documentUploadSchema = z
  .object({
    title: trimmed(1, 200),
    description: z.string().trim().max(4000).optional().nullable(),
    categoryId: uuid,
    visibility: z.enum(['PROJECT_MEMBERS', 'MANAGERS_ONLY']).default('PROJECT_MEMBERS'),
    fileName: trimmed(1, 255).refine((n) => !n.includes('/') && !n.includes('\\') && !n.includes('\0'), 'Invalid file name'),
    contentType: z.string().trim().toLowerCase(),
    sizeBytes: z.number().int().positive().max(ATTACHMENT_MAX_BYTES, `Files must be at most ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`),
  })
  .superRefine((v, ctx) => {
    const allowedExt = ALLOWED_ATTACHMENT_TYPES[v.contentType];
    if (!allowedExt) return ctx.addIssue({ code: 'custom', path: ['contentType'], message: 'File type is not allowed' });
    if (!allowedExt.includes(fileExtension(v.fileName))) ctx.addIssue({ code: 'custom', path: ['fileName'], message: 'File extension does not match the file type' });
  });
export const documentUpdateSchema = z
  .object({
    title: trimmed(1, 200).optional(),
    description: z.string().trim().max(4000).optional().nullable(),
    categoryId: uuid.optional(),
    visibility: z.enum(['PROJECT_MEMBERS', 'MANAGERS_ONLY']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const documentListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  categoryId: uuid.optional(),
  source: z.enum(['TASK_SUBMISSION', 'MANUAL']).optional(),
  departmentId: uuid.optional(),
  taskId: uuid.optional(),
  uploadedById: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(['-created', 'created', 'title']).default('-created'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/* ------------------------ Personal tasks ------------------------ */

export const personalTaskCreateSchema = z.object({
  title: trimmed(1, 200),
  notes: z.string().trim().max(5000).optional().nullable(),
  dueAt: isoDate.optional().nullable(),
  priority: prioritySchema.default('MEDIUM'),
});
export const personalTaskUpdateSchema = z
  .object({
    title: trimmed(1, 200).optional(),
    notes: z.string().trim().max(5000).optional().nullable(),
    dueAt: isoDate.optional().nullable(),
    priority: prioritySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export const personalTaskListQuerySchema = z.object({
  status: z.enum(['OPEN', 'DONE']).optional(),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/* --------------------------- Reports ---------------------------- */

export const reportRequestSchema = z.union([
  z.object({ type: z.literal('TASK'), taskId: uuid, locale: z.enum(['ar', 'en']).default('ar') }),
  z
    .object({
      type: z.literal('EMPLOYEE'),
      userId: uuid,
      projectIds: z.array(uuid).max(50).optional(),
      departmentId: uuid.optional(),
      from: isoDate,
      to: isoDate,
      status: z.array(z.enum(['ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW', 'COMPLETED'])).max(4).optional(),
      priority: z.array(prioritySchema).max(4).optional(),
      timeliness: z.enum(['ALL', 'ON_TIME', 'LATE']).default('ALL'),
      locale: z.enum(['ar', 'en']).default('ar'),
    })
    .refine((v) => v.to.getTime() > v.from.getTime(), 'to must be after from')
    .refine((v) => v.to.getTime() - v.from.getTime() <= 366 * 24 * 3600_000, 'Range is limited to 366 days'),
  z
    .object({
      type: z.literal('PROJECTS'),
      projectIds: z.array(uuid).min(1).max(50),
      departmentId: uuid.optional(),
      from: isoDate,
      to: isoDate,
      status: z.array(z.enum(['ASSIGNED', 'IN_PROGRESS', 'PENDING_REVIEW', 'COMPLETED'])).max(4).optional(),
      priority: z.array(prioritySchema).max(4).optional(),
      timeliness: z.enum(['ALL', 'ON_TIME', 'LATE']).default('ALL'),
      locale: z.enum(['ar', 'en']).default('ar'),
    })
    .refine((v) => v.to.getTime() > v.from.getTime(), 'to must be after from')
    .refine((v) => v.to.getTime() - v.from.getTime() <= 366 * 24 * 3600_000, 'Range is limited to 366 days'),
]);
