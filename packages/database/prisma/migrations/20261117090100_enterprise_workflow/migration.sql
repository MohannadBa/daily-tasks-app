
-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "approverId" UUID,
ADD COLUMN     "budgetMs" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "chargedMs" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "clockRunningSince" TIMESTAMPTZ(3),
ADD COLUMN     "currentCycle" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "departmentId" UUID,
ADD COLUMN     "effectiveDueAt" TIMESTAMPTZ(3),
ADD COLUMN     "originalDeadline" TIMESTAMPTZ(3),
ADD COLUMN     "pendingExtensionId" UUID,
ADD COLUMN     "pendingSubmissionId" UUID,
ADD COLUMN     "pendingTransferId" UUID,
ADD COLUMN     "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM';

-- Backfill (non-destructive): the assigning manager is the approver; the original deadline is the
-- deadline recorded at creation (history), else the current one.
UPDATE "Task" SET "approverId" = "createdById" WHERE "approverId" IS NULL;
UPDATE "Task" t SET "originalDeadline" = COALESCE(
  (SELECT (h."metadata"->>'deadline')::timestamptz FROM "TaskHistory" h
    WHERE h."taskId" = t."id" AND h."action" = 'CREATED' ORDER BY h."createdAt" LIMIT 1),
  t."deadline")
WHERE t."originalDeadline" IS NULL;
ALTER TABLE "Task" ALTER COLUMN "approverId" SET NOT NULL;
ALTER TABLE "Task" ALTER COLUMN "originalDeadline" SET NOT NULL;

-- AlterTable
ALTER TABLE "TaskAttachment" ADD COLUMN     "kind" "AttachmentKind" NOT NULL DEFAULT 'COMMENT';

-- Backfill attachment kinds (replaces the "uploadedById != assigneeId" heuristic).
UPDATE "TaskAttachment" SET "kind" = 'INSTRUCTION' WHERE "commentId" IS NULL;
UPDATE "TaskAttachment" a SET "kind" = 'SUBMISSION'
  FROM "TaskComment" c WHERE a."commentId" = c."id" AND c."isCompletionNote";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "createdById" UUID,
ADD COLUMN     "deactivatedAt" TIMESTAMPTZ(3),
ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordChangedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "Department" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentMembership" (
    "id" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "removedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DepartmentMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskCycle" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "cycleNo" INTEGER NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "originalDeadline" TIMESTAMPTZ(3) NOT NULL,
    "approvedDeadline" TIMESTAMPTZ(3) NOT NULL,
    "reopenReason" TEXT,
    "reopenedById" UUID,
    "completedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "accountableMs" BIGINT,
    "budgetMs" BIGINT,
    "lateMs" BIGINT,
    "completedLate" BOOLEAN,
    "source" TEXT NOT NULL DEFAULT 'LIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTimeSegment" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "kind" "SegmentKind" NOT NULL,
    "responsibleUserId" UUID,
    "chargedToUserId" UUID,
    "charged" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "submissionId" UUID,
    "transferId" UUID,
    "closeReason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'LIVE',

    CONSTRAINT "TaskTimeSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskSubmission" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "submittedById" UUID NOT NULL,
    "commentId" UUID NOT NULL,
    "stage" "ReviewStage" NOT NULL,
    "reviewerId" UUID NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "forwardedFromId" UUID,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionReason" TEXT,
    "decidedAsAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTransfer" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "fromUserId" UUID NOT NULL,
    "toUserId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "depth" INTEGER NOT NULL,
    "parentTransferId" UUID,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMPTZ(3),
    "responseNote" TEXT,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "TaskTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadlineExtensionRequest" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedMinutes" INTEGER NOT NULL,
    "status" "ExtensionStatus" NOT NULL DEFAULT 'PENDING',
    "grantedMinutes" INTEGER,
    "previousDeadline" TIMESTAMPTZ(3) NOT NULL,
    "newDeadline" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeadlineExtensionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentCategory" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectDocument" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "source" "DocumentSource" NOT NULL,
    "visibility" "DocumentVisibility" NOT NULL,
    "attachmentId" UUID,
    "storageKey" TEXT,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" "AttachmentStatus" NOT NULL DEFAULT 'UPLOADED',
    "taskId" UUID,
    "submissionId" UUID,
    "departmentId" UUID,
    "uploadedById" UUID NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "archivedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProjectDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalTask" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "titleEnc" TEXT NOT NULL,
    "notesEnc" TEXT,
    "dueAt" TIMESTAMPTZ(3),
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "PersonalTaskStatus" NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PersonalTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportJob" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "type" "ReportType" NOT NULL,
    "params" JSONB NOT NULL,
    "includesRatings" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'ar',
    "dataset" JSONB,
    "status" "ReportStatus" NOT NULL DEFAULT 'QUEUED',
    "storageKey" TEXT,
    "sizeBytes" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ReportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Department_companyId_isActive_sortOrder_idx" ON "Department"("companyId", "isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Department_companyId_code_key" ON "Department"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Department_companyId_nameAr_key" ON "Department"("companyId", "nameAr");

-- CreateIndex
CREATE INDEX "DepartmentMembership_userId_removedAt_idx" ON "DepartmentMembership"("userId", "removedAt");

-- CreateIndex
CREATE INDEX "DepartmentMembership_departmentId_removedAt_idx" ON "DepartmentMembership"("departmentId", "removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentMembership_departmentId_userId_key" ON "DepartmentMembership"("departmentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskCycle_taskId_cycleNo_key" ON "TaskCycle"("taskId", "cycleNo");

-- CreateIndex
CREATE INDEX "TaskTimeSegment_cycleId_startedAt_idx" ON "TaskTimeSegment"("cycleId", "startedAt");

-- CreateIndex
CREATE INDEX "TaskTimeSegment_chargedToUserId_startedAt_idx" ON "TaskTimeSegment"("chargedToUserId", "startedAt");

-- CreateIndex
CREATE INDEX "TaskTimeSegment_taskId_startedAt_idx" ON "TaskTimeSegment"("taskId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskSubmission_commentId_key" ON "TaskSubmission"("commentId");

-- CreateIndex
CREATE INDEX "TaskSubmission_taskId_createdAt_idx" ON "TaskSubmission"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskSubmission_reviewerId_status_idx" ON "TaskSubmission"("reviewerId", "status");

-- CreateIndex
CREATE INDEX "TaskTransfer_taskId_requestedAt_idx" ON "TaskTransfer"("taskId", "requestedAt");

-- CreateIndex
CREATE INDEX "TaskTransfer_toUserId_status_idx" ON "TaskTransfer"("toUserId", "status");

-- CreateIndex
CREATE INDEX "DeadlineExtensionRequest_taskId_createdAt_idx" ON "DeadlineExtensionRequest"("taskId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentCategory_companyId_code_key" ON "DocumentCategory"("companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDocument_attachmentId_key" ON "ProjectDocument"("attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDocument_storageKey_key" ON "ProjectDocument"("storageKey");

-- CreateIndex
CREATE INDEX "ProjectDocument_projectId_archivedAt_createdAt_idx" ON "ProjectDocument"("projectId", "archivedAt", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectDocument_projectId_categoryId_idx" ON "ProjectDocument"("projectId", "categoryId");

-- CreateIndex
CREATE INDEX "PersonalTask_ownerId_status_dueAt_idx" ON "PersonalTask"("ownerId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "ReportJob_requestedById_createdAt_idx" ON "ReportJob"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "ReportJob_status_createdAt_idx" ON "ReportJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_createdAt_idx" ON "AuditLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_departmentId_status_idx" ON "Task"("departmentId", "status");

-- CreateIndex
CREATE INDEX "Task_approverId_status_idx" ON "Task"("approverId", "status");

-- CreateIndex
CREATE INDEX "Task_status_effectiveDueAt_idx" ON "Task"("status", "effectiveDueAt");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMembership" ADD CONSTRAINT "DepartmentMembership_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMembership" ADD CONSTRAINT "DepartmentMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCycle" ADD CONSTRAINT "TaskCycle_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTimeSegment" ADD CONSTRAINT "TaskTimeSegment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTimeSegment" ADD CONSTRAINT "TaskTimeSegment_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "TaskCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSubmission" ADD CONSTRAINT "TaskSubmission_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSubmission" ADD CONSTRAINT "TaskSubmission_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "TaskCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSubmission" ADD CONSTRAINT "TaskSubmission_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSubmission" ADD CONSTRAINT "TaskSubmission_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "TaskComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSubmission" ADD CONSTRAINT "TaskSubmission_forwardedFromId_fkey" FOREIGN KEY ("forwardedFromId") REFERENCES "TaskSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTransfer" ADD CONSTRAINT "TaskTransfer_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTransfer" ADD CONSTRAINT "TaskTransfer_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "TaskCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTransfer" ADD CONSTRAINT "TaskTransfer_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTransfer" ADD CONSTRAINT "TaskTransfer_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadlineExtensionRequest" ADD CONSTRAINT "DeadlineExtensionRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadlineExtensionRequest" ADD CONSTRAINT "DeadlineExtensionRequest_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "TaskCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadlineExtensionRequest" ADD CONSTRAINT "DeadlineExtensionRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentCategory" ADD CONSTRAINT "DocumentCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "DocumentCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "TaskAttachment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "TaskSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDocument" ADD CONSTRAINT "ProjectDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalTask" ADD CONSTRAINT "PersonalTask_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportJob" ADD CONSTRAINT "ReportJob_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ===================================================================================
-- Hand-written constraints, seed data and integrity triggers (Prisma cannot express these)
-- ===================================================================================

-- Initial departments for every company (idempotent).
INSERT INTO "Department" ("id", "companyId", "code", "nameAr", "nameEn", "sortOrder", "updatedAt")
SELECT gen_random_uuid(), c."id", d.code, d.ar, d.en, d.ord, CURRENT_TIMESTAMP
FROM "Company" c
CROSS JOIN (VALUES
  ('PROJECT_MANAGEMENT', 'إدارة المشاريع', 'Project Management', 1),
  ('MARKETING', 'التسويق', 'Marketing', 2),
  ('FINANCE', 'المالية', 'Finance', 3),
  ('ENGINEERING_OFFICES', 'المكاتب الهندسية', 'Engineering Offices', 4),
  ('HUMAN_RESOURCES', 'الموارد البشرية', 'Human Resources', 5),
  ('CONTRACTS', 'العقود', 'Contracts', 6),
  ('LEGAL_AFFAIRS', 'الشؤون القانونية', 'Legal Affairs', 7)
) AS d(code, ar, en, ord)
ON CONFLICT ("companyId", "code") DO NOTHING;

INSERT INTO "DocumentCategory" ("id", "companyId", "code", "nameAr", "nameEn", "sortOrder")
SELECT gen_random_uuid(), c."id", d.code, d.ar, d.en, d.ord
FROM "Company" c
CROSS JOIN (VALUES
  ('CONTRACTS', 'العقود', 'Contracts', 1),
  ('DRAWINGS', 'المخططات', 'Drawings', 2),
  ('REPORTS', 'التقارير', 'Reports', 3),
  ('INVOICES', 'الفواتير', 'Invoices', 4),
  ('PHOTOS', 'الصور', 'Photos', 5),
  ('CORRESPONDENCE', 'المراسلات', 'Correspondence', 6),
  ('COMPLETION', 'مخرجات المهام', 'Task deliverables', 7),
  ('OTHER', 'أخرى', 'Other', 8)
) AS d(code, ar, en, ord)
ON CONFLICT ("companyId", "code") DO NOTHING;

-- Departments: one primary membership per user.
CREATE UNIQUE INDEX "DepartmentMembership_one_primary" ON "DepartmentMembership" ("userId") WHERE "isPrimary" AND "removedAt" IS NULL;

-- Tasks created from now on must have a department (legacy rows keep NULL = "unassigned").
CREATE FUNCTION dt_task_department_required() RETURNS trigger AS $$
BEGIN
  IF NEW."departmentId" IS NULL THEN
    RAISE EXCEPTION 'Task.departmentId is required' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "Task_department_required" BEFORE INSERT ON "Task" FOR EACH ROW EXECUTE FUNCTION dt_task_department_required();

ALTER TABLE "Task"
  ADD CONSTRAINT "Task_time_nonnegative" CHECK ("budgetMs" >= 0 AND "chargedMs" >= 0 AND "currentCycle" >= 1),
  ADD CONSTRAINT "Task_pending_review_consistency" CHECK (("status" = 'PENDING_REVIEW') = ("pendingSubmissionId" IS NOT NULL)),
  ADD CONSTRAINT "Task_running_clock_consistency" CHECK (("clockRunningSince" IS NULL) = ("effectiveDueAt" IS NULL));

-- Cycles: completion snapshot is all-or-nothing.
ALTER TABLE "TaskCycle"
  ADD CONSTRAINT "TaskCycle_snapshot_all_or_nothing" CHECK (
    ("completedAt" IS NULL AND "accountableMs" IS NULL AND "budgetMs" IS NULL AND "lateMs" IS NULL AND "completedLate" IS NULL)
    OR ("completedAt" IS NOT NULL AND "accountableMs" IS NOT NULL AND "budgetMs" IS NOT NULL AND "lateMs" IS NOT NULL AND "completedLate" IS NOT NULL)),
  ADD CONSTRAINT "TaskCycle_cycleNo_positive" CHECK ("cycleNo" >= 1);

-- Ledger: exactly one open segment per task, well-formed charging.
CREATE UNIQUE INDEX "TaskTimeSegment_one_open" ON "TaskTimeSegment" ("taskId") WHERE "endedAt" IS NULL;
ALTER TABLE "TaskTimeSegment"
  ADD CONSTRAINT "TaskTimeSegment_order" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt"),
  ADD CONSTRAINT "TaskTimeSegment_charge" CHECK (
    ("endedAt" IS NULL AND NOT "charged" AND "chargedToUserId" IS NULL)
    OR ("endedAt" IS NOT NULL AND "charged" AND "chargedToUserId" IS NOT NULL)
    OR ("endedAt" IS NOT NULL AND NOT "charged" AND "chargedToUserId" IS NULL)),
  ADD CONSTRAINT "TaskTimeSegment_kind_states" CHECK (
    ("kind" = 'PENDING_REVIEW' AND "endedAt" IS NULL)
    OR ("kind" IN ('APPROVED_REVIEW', 'REJECTED_REVIEW') AND "endedAt" IS NOT NULL)
    OR "kind" IN ('ACTIVE_WORK', 'TRANSFER_PENDING', 'DELEGATOR_REVIEW')),
  ADD CONSTRAINT "TaskTimeSegment_approved_excluded" CHECK ("kind" <> 'APPROVED_REVIEW' OR NOT "charged");

-- Closed ledger rows are immutable; ledger rows are never deleted.
CREATE FUNCTION dt_segment_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TaskTimeSegment rows are append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."endedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Closed TaskTimeSegment rows are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "TaskTimeSegment_immutable" BEFORE UPDATE OR DELETE ON "TaskTimeSegment" FOR EACH ROW EXECUTE FUNCTION dt_segment_immutable();

-- Submissions: one pending per task; decisions well-formed; reasons mandatory.
CREATE UNIQUE INDEX "TaskSubmission_one_pending" ON "TaskSubmission" ("taskId") WHERE "status" = 'PENDING';
ALTER TABLE "TaskSubmission"
  ADD CONSTRAINT "TaskSubmission_decision" CHECK (("status" = 'PENDING') = ("decidedAt" IS NULL)),
  ADD CONSTRAINT "TaskSubmission_reason_required" CHECK ("status" NOT IN ('REJECTED', 'RETURNED') OR length(btrim(coalesce("decisionReason", ''))) > 0);

-- Decided submissions are immutable.
CREATE FUNCTION dt_submission_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'Decided TaskSubmission rows are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "TaskSubmission_immutable" BEFORE UPDATE OR DELETE ON "TaskSubmission" FOR EACH ROW EXECUTE FUNCTION dt_submission_immutable();

-- Transfers: one pending per task, sane chain, reason mandatory.
CREATE UNIQUE INDEX "TaskTransfer_one_pending" ON "TaskTransfer" ("taskId") WHERE "status" = 'PENDING';
ALTER TABLE "TaskTransfer"
  ADD CONSTRAINT "TaskTransfer_not_self" CHECK ("fromUserId" <> "toUserId"),
  ADD CONSTRAINT "TaskTransfer_depth" CHECK ("depth" BETWEEN 1 AND 3),
  ADD CONSTRAINT "TaskTransfer_reason" CHECK (length(btrim("reason")) > 0);

-- Extensions: one pending per task; granted within requested.
CREATE UNIQUE INDEX "DeadlineExtensionRequest_one_pending" ON "DeadlineExtensionRequest" ("taskId") WHERE "status" = 'PENDING';
ALTER TABLE "DeadlineExtensionRequest"
  ADD CONSTRAINT "DeadlineExtensionRequest_minutes" CHECK ("requestedMinutes" > 0 AND ("grantedMinutes" IS NULL OR ("grantedMinutes" > 0 AND "grantedMinutes" <= "requestedMinutes"))),
  ADD CONSTRAINT "DeadlineExtensionRequest_reason" CHECK (length(btrim("reason")) > 0),
  ADD CONSTRAINT "DeadlineExtensionRequest_decision" CHECK (("status" IN ('PENDING', 'CANCELLED')) = ("decidedAt" IS NULL) OR "status" = 'CANCELLED');

-- Documents: exactly one file source.
ALTER TABLE "ProjectDocument"
  ADD CONSTRAINT "ProjectDocument_source" CHECK (
    ("source" = 'TASK_SUBMISSION' AND "attachmentId" IS NOT NULL AND "storageKey" IS NULL)
    OR ("source" = 'MANUAL' AND "attachmentId" IS NULL AND "storageKey" IS NOT NULL)),
  ADD CONSTRAINT "ProjectDocument_size" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 26214400);
