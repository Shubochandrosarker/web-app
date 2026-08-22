/**
 * Image loader: Cloudflare Image Transformations when the deployment is
 * behind Cloudflare, the original URL otherwise.
 *
 * Media originals live in R2 under content-addressed immutable keys. What a
 * page actually needs is a width-appropriate AVIF/WebP variant — and the
 * right place to derive that is Cloudflare's edge (`/cdn-cgi/image/…`), which
 * resizes and format-negotiates per request without putting image processing
 * on the application server.
 *
 * `NEXT_PUBLIC_IMAGE_TRANSFORMS=cloudflare` turns the rewriting on; it is off
 * by default because `/cdn-cgi/image/` only exists when Cloudflare proxies
 * the site (production), and a dev or preview deployment would otherwise
 * serve 404s for every image. With it off, `next/image` still contributes
 * exact dimensions, lazy loading and priority hints — the CLS and LCP parts —
 * while the bytes come straight from the CDN cache.
 */
export default function imageLoader({
  src,
  width,
  quality,
}: {
  src: string;
  width: number;
  quality?: number;
}): string {
  if (process.env.NEXT_PUBLIC_IMAGE_TRANSFORMS !== 'cloudflare') return src;

  const options = `format=auto,width=${width},quality=${quality ?? 75},fit=scale-down`;
  // Same-zone absolute URLs work as-is; the transformation endpoint fetches
  // the inner URL, so external media origins are supported too.
  return `/cdn-cgi/image/${options}/${src}`;
}
