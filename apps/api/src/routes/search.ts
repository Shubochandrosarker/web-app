import { and, desc, ilike, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { schema, withWorkspace, type Database } from '@bos/database';
import { requirePermission } from '../lib/permissions.ts';
import { hasPermission, requireWorkspace } from '../lib/context.ts';
import type { AppContext } from '../app.ts';

/**
 * Global search, V1: Postgres ILIKE across the entities a person actually
 * hunts for — contacts, enquiries, pages, services, orders, automations.
 * Each group is gated by the caller's permission for that entity, so search
 * can never show a viewer something the list screens would not.
 *
 * Deliberately not full-text-indexed yet: at hundreds-to-thousands of rows
 * per tenant, ILIKE with a trigram-friendly pattern is instant, and the
 * upgrade path (pg_trgm indexes, tsvector) changes nothing about this API.
 */

export interface SearchHit {
  readonly type: string;
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly href: string;
}

const searchQuery = z.object({
  q: z.string().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export function registerSearchRoutes(app: FastifyInstance, context: AppContext): void {
  const { db } = context;

  app.get(
    '/v1/search',
    { config: { bosAccess: requirePermission('settings.read') } },
    async (request) => {
      const workspace = requireWorkspace(request);
      const { q, limit } = searchQuery.parse(request.query);
      const pattern = `%${q}%`;

      const groups = await withWorkspace(db, workspace.workspaceId, async (tx: Database) => {
        const results: SearchHit[] = [];

        if (hasPermission(request, 'contacts.read')) {
          const contacts = await tx
            .select({
              id: schema.contacts.id,
              fullName: schema.contacts.fullName,
              email: schema.contacts.email,
              phone: schema.contacts.phone,
            })
            .from(schema.contacts)
            .where(
              and(
                isNull(schema.contacts.deletedAt),
                or(
                  ilike(schema.contacts.fullName, pattern),
                  ilike(schema.contacts.email, pattern),
                  ilike(schema.contacts.phone, pattern),
                ),
              ),
            )
            .limit(limit);
          results.push(
            ...contacts.map((row) => ({
              type: 'contact',
              id: row.id,
              title: row.fullName ?? row.email ?? 'Contact',
              subtitle: row.email ?? row.phone,
              href: `/contacts/${row.id}`,
            })),
          );
        }

        if (hasPermission(request, 'leads.read')) {
          const leads = await tx
            .select({ id: schema.leads.id, title: schema.leads.title, status: schema.leads.status })
            .from(schema.leads)
            .where(and(isNull(schema.leads.deletedAt), ilike(schema.leads.title, pattern)))
            .orderBy(desc(schema.leads.createdAt))
            .limit(limit);
          results.push(
            ...leads.map((row) => ({
              type: 'lead',
              id: row.id,
              title: row.title ?? 'Enquiry',
              subtitle: String(row.status),
              href: `/leads/${row.id}`,
            })),
          );
        }

        if (hasPermission(request, 'content.read')) {
          const pages = await tx
            .select({
              id: schema.contentEntries.id,
              title: schema.contentEntries.title,
              path: schema.contentEntries.path,
              status: schema.contentEntries.status,
            })
            .from(schema.contentEntries)
            .where(
              and(
                isNull(schema.contentEntries.deletedAt),
                or(
                  ilike(schema.contentEntries.title, pattern),
                  ilike(schema.contentEntries.path, pattern),
                ),
              ),
            )
            .limit(limit);
          results.push(
            ...pages.map((row) => ({
              type: 'page',
              id: row.id,
              title: row.title,
              subtitle: `${row.path} · ${row.status}`,
              href: `/content/${row.id}`,
            })),
          );
        }

        if (hasPermission(request, 'services.read')) {
          const services = await tx
            .select({
              id: schema.services.id,
              name: schema.services.name,
              slug: schema.services.slug,
            })
            .from(schema.services)
            .where(and(isNull(schema.services.deletedAt), ilike(schema.services.name, pattern)))
            .limit(limit);
          results.push(
            ...services.map((row) => ({
              type: 'service',
              id: row.id,
              title: row.name,
              subtitle: row.slug,
              href: `/services/${row.id}`,
            })),
          );
        }

        if (hasPermission(request, 'orders.read')) {
          const orders = await tx
            .select({
              id: schema.orders.id,
              orderNumber: schema.orders.orderNumber,
              status: schema.orders.status,
            })
            .from(schema.orders)
            .where(and(isNull(schema.orders.deletedAt), ilike(schema.orders.orderNumber, pattern)))
            .limit(limit);
          results.push(
            ...orders.map((row) => ({
              type: 'order',
              id: row.id,
              title: row.orderNumber,
              subtitle: row.status,
              href: `/orders/${row.id}`,
            })),
          );
        }

        if (hasPermission(request, 'automations.read')) {
          const automations = await tx
            .select({
              id: schema.automations.id,
              name: schema.automations.name,
              enabled: schema.automations.enabled,
            })
            .from(schema.automations)
            .where(
              and(isNull(schema.automations.deletedAt), ilike(schema.automations.name, pattern)),
            )
            .limit(limit);
          results.push(
            ...automations.map((row) => ({
              type: 'automation',
              id: row.id,
              title: row.name,
              subtitle: row.enabled ? 'on' : 'off',
              href: `/automations/${row.id}`,
            })),
          );
        }

        return results;
      });

      return { query: q, items: groups };
    },
  );
}
