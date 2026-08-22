import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Enumerations that are part of the platform's contract rather than tenant
 * configuration.
 *
 * The distinction matters: a lead's *stage* is tenant-configurable and lives
 * in `pipeline_stages` as rows, while a lead's *status* is platform behaviour
 * and is an enum. Anything a client might reasonably want to rename is a
 * table, not an enum — altering an enum in production is a migration, and no
 * client should need one to add a stage called "Documents received".
 */

export const userStatus = pgEnum('user_status', ['active', 'invited', 'suspended', 'deleted']);

export const workspaceRole = pgEnum('workspace_role', [
  'owner',
  'admin',
  'manager',
  'staff',
  'viewer',
]);

export const workspaceStatus = pgEnum('workspace_status', ['active', 'suspended', 'archived']);

export const businessTypeEnum = pgEnum('business_type', [
  'education_service',
  'restaurant',
  'tour_operator',
  'healthcare',
  'agency',
  'local_service',
  'professional_service',
  'ecommerce',
  'membership',
  'training',
  'real_estate',
]);

export const contentType = pgEnum('content_type', [
  'page',
  'post',
  'service',
  'location',
  'faq',
  'guide',
  'person',
  'testimonial',
  'case_study',
  'offer',
  'landing_page',
]);

export const publishStatus = pgEnum('publish_status', [
  'draft',
  'scheduled',
  'published',
  'archived',
]);

export const mediaVisibility = pgEnum('media_visibility', ['public', 'private']);

export const leadStatus = pgEnum('lead_status', ['open', 'won', 'lost', 'archived']);

export const taskStatus = pgEnum('task_status', ['open', 'in_progress', 'done', 'cancelled']);

export const appointmentStatus = pgEnum('appointment_status', [
  'pending',
  'confirmed',
  'completed',
  'cancelled',
  'no_show',
]);

export const messageChannel = pgEnum('message_channel', ['email', 'sms', 'whatsapp', 'in_app']);

export const messageStatus = pgEnum('message_status', [
  'queued',
  'sent',
  'delivered',
  /** WhatsApp reports reads; email opens stay in message_events. */
  'read',
  'bounced',
  'failed',
  /** Inbound messages arrive received; they were never queued here. */
  'received',
]);

export const messageDirection = pgEnum('message_direction', ['outbound', 'inbound']);

export const automationRunStatus = pgEnum('automation_run_status', [
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);

export const automationStepStatus = pgEnum('automation_step_status', [
  'pending',
  'running',
  'completed',
  'skipped',
  'failed',
]);

export const outboxStatus = pgEnum('outbox_status', ['pending', 'dispatched', 'failed', 'dead']);

export const indexingProvider = pgEnum('indexing_provider', ['indexnow', 'google_search_console']);

export const indexingStatus = pgEnum('indexing_status', ['submitted', 'rejected', 'error']);

export const documentStatus = pgEnum('document_status', [
  /** An upload URL was issued; no object confirmed yet. Short retention. */
  'pending_upload',
  /** The object arrived and awaits verification — legacy rows land here too. */
  'uploaded',
  /** Verified (size, signature, checksum) but the malware scan is still owed. */
  'scanning',
  /** Verified and scanned. The only status a download URL is minted for. */
  'clean',
  'rejected',
  'expired',
  'deleted',
]);

export const reviewSource = pgEnum('review_source', ['internal', 'google', 'facebook', 'other']);

export const orderStatus = pgEnum('order_status', [
  /** Being assembled by staff; totals and items still editable. */
  'draft',
  /** Sent to / agreed with the customer; awaiting confirmation or payment. */
  'pending',
  'confirmed',
  /** Work underway (document collection, processing, delivery prep). */
  'in_progress',
  'completed',
  'cancelled',
  /** Terminal: money went back after completion. */
  'refunded',
]);

/**
 * Payment *status* is platform behaviour and an enum; payment *method*
 * (cash, bKash, Nagad, bank transfer…) is country- and tenant-varying
 * vocabulary, so it is a varchar validated at the API boundary instead.
 */
export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'verified',
  'failed',
  'refunded',
]);
