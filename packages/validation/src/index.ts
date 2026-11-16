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

export const updateProfileSchema = z
  .object({
    name: trimmed(1, 120).optional(),
    locale: z.enum(['en', 'ar']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/* ---------------------------- Users ---------------------------- */

export const roleSchema = z.enum(['COMPANY_ADMIN', 'PROJECT_MANAGER', 'EMPLOYEE']);

export const inviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: trimmed(1, 120),
  role: roleSchema,
  locale: z.enum(['en', 'ar']).default('en'),
  /** Local auth mode only. Cognito sends its own invitation e-mail. */
  temporaryPassword: passwordSchema.optional(),
});
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

export const createTaskSchema = z.object({
  projectId: uuid,
  assigneeId: uuid,
  title: trimmed(1, 200),
  description: z.string().trim().max(10000).default(''),
  deadline: isoDate,
});
export type CreateTaskInput = z.input<typeof createTaskSchema>;

export const updateTaskSchema = z
  .object({
    title: trimmed(1, 200).optional(),
    description: z.string().trim().max(10000).optional(),
    deadline: isoDate.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
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
  view: z.enum(['all', 'active', 'completed', 'overdue', 'awaiting_rating']).default('all'),
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

export const registerDeviceSchema = z.object({
  expoPushToken: z
    .string()
    .trim()
    .regex(/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/, 'Invalid Expo push token'),
  platform: z.enum(['IOS', 'ANDROID', 'WEB']),
  deviceName: z.string().trim().max(120).optional().nullable(),
  locale: z.enum(['en', 'ar']).optional(),
});

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
