import { eq } from 'drizzle-orm';
import { schema, withoutTenantScope, type Database } from '@bos/database';
import { ApiError } from './errors.ts';

/**
 * Resolve a workspace slug to its id.
 *
 * This is the one lookup that legitimately runs before a tenant context
 * exists — it is what establishes the context. It goes through
 * `withoutTenantScope` explicitly, and returns only the id, so nothing else
 * about another tenant can be read through it.
 *
 * Cached because it is on the path of every request and slugs effectively
 * never change. TASK-104 moves this to Redis with an invalidation hook.
 */
const cache = new Map<string, string>();

export async function resolveWorkspaceId(db: Database, slug: string): Promise<string> {
  const cached = cache.get(slug);
  if (cached) return cached;

  const id = await withoutTenantScope(db, async (tx) => {
    const [row] = await tx
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.slug, slug))
      .limit(1);
    return row?.id;
  });

  if (!id) throw ApiError.notFound('Workspace');

  cache.set(slug, id);
  return id;
}

export function clearWorkspaceCache(): void {
  cache.clear();
}
