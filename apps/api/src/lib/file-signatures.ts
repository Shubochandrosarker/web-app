/**
 * File-signature (magic byte) verification.
 *
 * The browser's `Content-Type` is a claim, not a fact: a `.exe` renamed to
 * `.pdf` uploads with `application/pdf` and every layer that trusted the
 * header treats it as one. The bytes are the fact. A document whose bytes do
 * not match its declared type is rejected — not "corrected" to what it looks
 * like, because a mismatch is the signature of someone probing, and guessing
 * on their behalf helps only them.
 *
 * SVG is deliberately absent from this table and from the accepted types: an
 * SVG is a script container, and no version of "upload your transcript"
 * needs one.
 */

export interface SignatureCheck {
  readonly matches: boolean;
  /** What the bytes look like, when identifiable. For the rejection record. */
  readonly detected: string | null;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return Buffer.from(bytes.subarray(start, start + length)).toString('latin1');
}

/** Best-effort identification, used for the rejection record. */
export function detectType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic';
    }
    return `container/${brand.trim()}`;
  }
  if (startsWith(bytes, [0x4d, 0x5a])) return 'application/x-msdownload';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return 'application/x-elf';
  return null;
}

/** Does the object's leading bytes match the type the upload declared? */
export function matchesDeclaredType(bytes: Uint8Array, declaredMime: string): SignatureCheck {
  const detected = detectType(bytes);

  switch (declaredMime) {
    case 'application/pdf':
      return { matches: detected === 'application/pdf', detected };
    case 'image/jpeg':
      return { matches: detected === 'image/jpeg', detected };
    case 'image/png':
      return { matches: detected === 'image/png', detected };
    case 'image/webp':
      return { matches: detected === 'image/webp', detected };
    case 'image/heic':
      return { matches: detected === 'image/heic', detected };
    default:
      // A type not in the allow-list should have been refused before any
      // bytes moved; reaching here is itself a mismatch.
      return { matches: false, detected };
  }
}
