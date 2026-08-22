import { and, eq, inArray } from 'drizzle-orm';
import { schema, withWorkspace, type Database } from '@bos/database';

/**
 * In-app notification fan-out.
 *
 * A notification is written per recipient at emit time: the emitter decides
 * which roles should notice (a rejected document concerns the people who can
 * act on documents; a failed automation concerns whoever can fix it), and
 * every active member holding one of those roles gets a row. Titles are
 * summaries with a link — never document contents, message bodies or
 * anything a notification list should not leak.
 */

export interface NotificationInput {
  readonly kind: string;
  readonly severity?: 'info' | 'warning' | 'critical';
  readonly title: string;
  readonly body?: string | null;
  readonly href?: string | null;
  /** Which roles should see it. */
  readonly roles: readonly ('owner' | 'admin' | 'manager' | 'staff' | 'viewer')[];
}

export async function fanOutNotification(
  db: Database,
  workspaceId: string,
  input: NotificationInput,
): Promise<number> {
  return withWorkspace(db, workspaceId, async (tx) => {
    const recipients = await tx
      .select({ userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.workspaceMembers.userId))
      .where(
        and(
          inArray(schema.workspaceMembers.role, [...input.roles]),
          eq(schema.users.status, 'active'),
        ),
      );
    if (recipients.length === 0) return 0;

    await tx.insert(schema.notifications).values(
      recipients.map((recipient) => ({
        workspaceId,
        userId: recipient.userId,
        kind: input.kind,
        severity: input.severity ?? 'info',
        title: input.title,
        body: input.body ?? null,
        href: input.href ?? null,
      })),
    );
    return recipients.length;
  });
}

/**
 * The events worth a person's attention, mapped to a notification. Called by
 * the outbox handler for every dispatched event; unknown events are silent.
 */
export async function notifyFromEvent(
  db: Database,
  event: { workspaceId: string; name: string; payload: Record<string, unknown> },
): Promise<void> {
  const managers = ['owner', 'admin', 'manager'] as const;

  switch (event.name) {
    case 'document.rejected':
      await fanOutNotification(db, event.workspaceId, {
        kind: event.name,
        severity: 'warning',
        title: 'A document failed verification',
        body: 'It needs a person: re-request the file or contact the customer.',
        href: '/documents',
        roles: managers,
      });
      return;
    case 'review.received':
      await fanOutNotification(db, event.workspaceId, {
        kind: event.name,
        title: 'A new review is waiting for moderation',
        href: '/reviews',
        roles: managers,
      });
      return;
    case 'order.created': {
      const orderNumber =
        typeof event.payload.orderNumber === 'string' ? event.payload.orderNumber : 'An order';
      await fanOutNotification(db, event.workspaceId, {
        kind: event.name,
        title: `${orderNumber} was created`,
        href: '/orders',
        roles: managers,
      });
      return;
    }
    case 'appointment.created':
      await fanOutNotification(db, event.workspaceId, {
        kind: event.name,
        title: 'An appointment was booked',
        href: '/appointments',
        roles: managers,
      });
      return;
    default:
      return;
  }
}
