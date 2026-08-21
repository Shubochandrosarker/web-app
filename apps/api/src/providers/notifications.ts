import nodemailer, { type Transporter } from 'nodemailer';
import type { ApiConfig } from '../lib/env.ts';

/**
 * Outbound message providers.
 *
 * Adapters rather than a direct integration, for a reason that is about
 * business risk rather than tidiness: NuESheba's WhatsApp acknowledgement is
 * the single most operationally important message the platform sends, and the
 * provider landscape for WhatsApp Business changes pricing and policy
 * regularly. A core that imports one vendor's SDK is a core that has to be
 * rewritten when that vendor becomes unusable.
 *
 * Neither adapter retries. Retrying is the outbox's job, and a provider that
 * also retries turns one transient failure into a message sent four times.
 */

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly replyTo?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ providerMessageId: string | null }>;
}

export interface WhatsappMessage {
  /** E.164, no leading `+` stripped — the adapter normalises for its provider. */
  readonly to: string;
  /**
   * Template name and variables, not free text.
   *
   * A business-initiated WhatsApp message outside the 24-hour service window
   * must use an approved template; sending free text would be silently dropped
   * by Meta, which is the worst possible failure mode for an acknowledgement.
   */
  readonly template: string;
  readonly languageCode: string;
  readonly variables: readonly string[];
}

export interface WhatsappProvider {
  readonly name: string;
  send(message: WhatsappMessage): Promise<{ providerMessageId: string | null }>;
}

export interface ProviderLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

/* ------------------------------------------------------------------ email */

class LogEmailProvider implements EmailProvider {
  readonly name = 'log';
  private readonly logger: ProviderLogger;

  constructor(logger: ProviderLogger) {
    this.logger = logger;
  }

  async send(message: EmailMessage): Promise<{ providerMessageId: string | null }> {
    // The body is deliberately not logged: a password-reset email contains a
    // credential, and a lead confirmation contains someone's phone number.
    this.logger.info(
      { to: message.to, subject: message.subject },
      'Email not sent — EMAIL_PROVIDER=log',
    );
    return { providerMessageId: null };
  }
}

class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: ApiConfig) {
    this.from = `${config.EMAIL_FROM_NAME} <${config.EMAIL_FROM_ADDRESS}>`;
    this.transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT ?? 587,
      // Implicit TLS on 465, STARTTLS everywhere else. Getting this wrong is
      // how credentials end up on the wire in the clear.
      secure: (config.SMTP_PORT ?? 587) === 465,
      requireTLS: (config.SMTP_PORT ?? 587) !== 465,
      ...(config.SMTP_USER
        ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD ?? '' } }
        : {}),
    });
  }

  async send(message: EmailMessage): Promise<{ providerMessageId: string | null }> {
    const result = await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    });
    return { providerMessageId: result.messageId ?? null };
  }
}

class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly apiKey: string;
  private readonly from: string;

  constructor(config: ApiConfig) {
    this.apiKey = config.RESEND_API_KEY ?? '';
    this.from = `${config.EMAIL_FROM_NAME} <${config.EMAIL_FROM_ADDRESS}>`;
  }

  async send(message: EmailMessage): Promise<{ providerMessageId: string | null }> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      // The body is included because a provider's rejection reason is the
      // whole diagnostic value of the failure, and it lands in the outbox
      // row's `last_error` rather than in a log nobody reads.
      throw new Error(`Resend rejected the message: ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as { id?: string };
    return { providerMessageId: body.id ?? null };
  }
}

export function createEmailProvider(config: ApiConfig, logger: ProviderLogger): EmailProvider {
  switch (config.EMAIL_PROVIDER) {
    case 'smtp':
      return new SmtpEmailProvider(config);
    case 'resend':
      return new ResendEmailProvider(config);
    case 'ses':
      // Not implemented rather than half-implemented. The environment schema
      // accepts `ses` so the contract is stable; picking it fails loudly here
      // instead of silently sending nothing.
      throw new Error('EMAIL_PROVIDER=ses is not implemented yet. Use smtp or resend.');
    case 'log':
    default:
      return new LogEmailProvider(logger);
  }
}

/* --------------------------------------------------------------- WhatsApp */

class LogWhatsappProvider implements WhatsappProvider {
  readonly name = 'log';
  private readonly logger: ProviderLogger;

  constructor(logger: ProviderLogger) {
    this.logger = logger;
  }

  async send(message: WhatsappMessage): Promise<{ providerMessageId: string | null }> {
    this.logger.info(
      { template: message.template, to: `${message.to.slice(0, 5)}…` },
      'WhatsApp message not sent — WHATSAPP_PROVIDER=log',
    );
    return { providerMessageId: null };
  }
}

class MetaCloudWhatsappProvider implements WhatsappProvider {
  readonly name = 'meta_cloud';
  private readonly phoneNumberId: string;
  private readonly accessToken: string;

  constructor(config: ApiConfig) {
    this.phoneNumberId = config.WHATSAPP_PHONE_NUMBER_ID ?? '';
    this.accessToken = config.WHATSAPP_ACCESS_TOKEN ?? '';
  }

  async send(message: WhatsappMessage): Promise<{ providerMessageId: string | null }> {
    const response = await fetch(
      `https://graph.facebook.com/v21.0/${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          // Meta wants the number without a leading `+`.
          to: message.to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: message.template,
            language: { code: message.languageCode },
            components:
              message.variables.length === 0
                ? []
                : [
                    {
                      type: 'body',
                      parameters: message.variables.map((text) => ({ type: 'text', text })),
                    },
                  ],
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      throw new Error(
        `WhatsApp Cloud API rejected the message: ${response.status} ${await response.text()}`,
      );
    }

    const body = (await response.json()) as { messages?: { id?: string }[] };
    return { providerMessageId: body.messages?.[0]?.id ?? null };
  }
}

export function createWhatsappProvider(
  config: ApiConfig,
  logger: ProviderLogger,
): WhatsappProvider {
  switch (config.WHATSAPP_PROVIDER) {
    case 'meta_cloud':
      return new MetaCloudWhatsappProvider(config);
    case 'log':
    default:
      return new LogWhatsappProvider(logger);
  }
}
