-- Data fix: orphan rows from earlier __LOCALID_* tests block the column drop
-- because the dropped FK was already being violated. Safe — these rows had
-- status='pending' and never had a confirm call.
DELETE FROM attachments WHERE thread_id LIKE '__LOCALID_%';--> statement-breakpoint
DROP INDEX "attachments_thread_created_idx";--> statement-breakpoint
ALTER TABLE "attachments" DROP COLUMN "thread_id";