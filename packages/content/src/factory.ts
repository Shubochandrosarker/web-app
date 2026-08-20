import type { ContentProvider } from './types.ts';
import { InternalContentProvider, type InternalProviderOptions } from './providers/internal.ts';
import { WordPressContentProvider, type WordPressProviderOptions } from './providers/wordpress.ts';
import { MarkdownContentProvider, type MarkdownProviderOptions } from './providers/markdown.ts';

export type ContentProviderConfig =
  | ({ provider: 'internal' } & InternalProviderOptions)
  | ({ provider: 'wordpress' } & WordPressProviderOptions)
  | ({ provider: 'markdown' } & MarkdownProviderOptions);

/**
 * Single construction point for content providers.
 *
 * Application code calls this and receives a `ContentProvider`. It never
 * imports a concrete provider class, which is the mechanism that keeps
 * "WordPress is optional" true rather than aspirational.
 */
export function createContentProvider(config: ContentProviderConfig): ContentProvider {
  switch (config.provider) {
    case 'internal':
      return new InternalContentProvider(config);
    case 'wordpress':
      return new WordPressContentProvider(config);
    case 'markdown':
      return new MarkdownContentProvider(config);
  }
}
