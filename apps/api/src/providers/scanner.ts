import { Socket } from 'node:net';
import type { ProviderLogger } from './notifications.ts';

/**
 * Malware scanning for private documents.
 *
 * The contract every implementation honours: a document is downloadable by
 * staff only after a scanner has said `clean`. What varies by deployment is
 * which scanner that is:
 *
 *  - **clamav** — a ClamAV daemon over TCP (`INSTREAM`). The documented
 *    choice for the VPS deployment, where `clamav-daemon` runs beside the
 *    API.
 *  - **stub**  — deterministic, for tests and local development: flags the
 *    EICAR test string and passes everything else. Never production.
 *  - **none**  — no scanner. Verification (size, signature, checksum) still
 *    runs, and the absence of a scan is recorded on the document rather than
 *    silently equated with a clean one. Warned about at boot; a production
 *    deployment should not run this way once documents matter.
 *
 * A scanner *error* is not a verdict. The document stays in `scanning` and is
 * retried by the scheduled sweep — fail closed, not fail open.
 */

export type ScanVerdict =
  | { readonly outcome: 'clean'; readonly scanner: string }
  | { readonly outcome: 'infected'; readonly scanner: string; readonly signature: string }
  | { readonly outcome: 'not_scanned'; readonly scanner: 'none' }
  | { readonly outcome: 'error'; readonly scanner: string; readonly reason: string };

export interface DocumentScanner {
  readonly kind: 'clamav' | 'stub' | 'none';
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}

export interface ScannerConfig {
  readonly DOCUMENT_SCANNER: 'clamav' | 'stub' | 'none';
  readonly CLAMAV_HOST: string;
  readonly CLAMAV_PORT: number;
  readonly CLAMAV_TIMEOUT_MS: number;
}

/** The EICAR test string — the industry's agreed harmless "virus". */
const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

class StubScanner implements DocumentScanner {
  readonly kind = 'stub' as const;

  async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    // Only the head is inspected, mirroring how cheaply a test fixture is
    // built; the real scanner reads everything.
    const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
    if (head.includes(EICAR_SIGNATURE)) {
      return { outcome: 'infected', scanner: 'stub', signature: 'Eicar-Test-Signature' };
    }
    return { outcome: 'clean', scanner: 'stub' };
  }
}

class NoneScanner implements DocumentScanner {
  readonly kind = 'none' as const;

  async scan(): Promise<ScanVerdict> {
    return { outcome: 'not_scanned', scanner: 'none' };
  }
}

/**
 * ClamAV over its TCP protocol.
 *
 * `zINSTREAM\0` followed by length-prefixed chunks and a zero-length
 * terminator; the daemon answers `stream: OK` or `stream: <name> FOUND`.
 * No third-party client library — the protocol is four lines of framing, and
 * a dependency here would be a supply-chain surface on the most sensitive
 * path in the platform.
 */
class ClamAvScanner implements DocumentScanner {
  readonly kind = 'clamav' as const;
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(host: string, port: number, timeoutMs: number) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  scan(bytes: Uint8Array): Promise<ScanVerdict> {
    return new Promise((resolve) => {
      const socket = new Socket();
      let response = '';
      let settled = false;

      const settle = (verdict: ScanVerdict): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(verdict);
      };

      socket.setTimeout(this.timeoutMs, () =>
        settle({ outcome: 'error', scanner: 'clamav', reason: 'timeout' }),
      );
      socket.on('error', (error) =>
        settle({ outcome: 'error', scanner: 'clamav', reason: error.message }),
      );

      socket.connect(this.port, this.host, () => {
        socket.write('zINSTREAM\0');

        const CHUNK = 64 * 1024;
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          const chunk = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
          const frame = Buffer.alloc(4);
          frame.writeUInt32BE(chunk.length, 0);
          socket.write(frame);
          socket.write(chunk);
        }

        const terminator = Buffer.alloc(4);
        terminator.writeUInt32BE(0, 0);
        socket.write(terminator);
      });

      socket.on('data', (data: Buffer) => {
        response += data.toString('utf8');
        if (!response.includes('\0') && !response.includes('\n')) return;

        const line = response.replace(/\0/g, '').trim();
        if (line.endsWith('OK')) {
          settle({ outcome: 'clean', scanner: 'clamav' });
        } else if (line.endsWith('FOUND')) {
          const signature = line.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '');
          settle({ outcome: 'infected', scanner: 'clamav', signature });
        } else {
          settle({ outcome: 'error', scanner: 'clamav', reason: line.slice(0, 200) });
        }
      });

      socket.on('close', () => {
        settle({ outcome: 'error', scanner: 'clamav', reason: 'connection closed early' });
      });
    });
  }
}

export function createScanner(config: ScannerConfig, logger: ProviderLogger): DocumentScanner {
  switch (config.DOCUMENT_SCANNER) {
    case 'clamav':
      return new ClamAvScanner(config.CLAMAV_HOST, config.CLAMAV_PORT, config.CLAMAV_TIMEOUT_MS);
    case 'stub':
      return new StubScanner();
    default:
      logger.warn({}, 'DOCUMENT_SCANNER=none — uploads are verified but not scanned for malware.');
      return new NoneScanner();
  }
}
