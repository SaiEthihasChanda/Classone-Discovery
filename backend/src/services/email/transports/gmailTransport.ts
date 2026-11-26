/**
 * Real send via the Gmail API (not raw SMTP) — composed with nodemailer's
 * MailComposer so the MIME message (headers, threading, HTML+text parts) is
 * built the same well-tested way as the Ethereal transport, then handed to
 * Gmail as a base64url `raw` message per Google's API.
 *
 * Needs OAuth: GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN. The refresh token comes
 * from running `npm run gmail:auth` once — see `scripts/gmailAuth.ts`.
 */
import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import MailComposer from 'nodemailer/lib/mail-composer';
import { env } from '../../../config/env.js';
import type { EmailMessage, EmailSendResult, EmailTransport } from './types.js';

export function oauthClient() {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    throw new Error(
      'Gmail is not configured — set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN. ' +
        'Run `npm run gmail:auth` once the client id/secret are set to obtain the refresh token.',
    );
  }
  const client = new google.auth.OAuth2(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET);
  client.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });
  return client;
}

async function buildRawMessage(message: EmailMessage, messageId: string): Promise<string> {
  const mail = new MailComposer({
    messageId,
    from: `"${env.EMAIL_FROM_NAME}" <${env.EMAIL_FROM_ADDRESS}>`,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    inReplyTo: message.inReplyToMessageId,
    attachments: message.attachments,
    headers: { 'X-ClassOne-App': '1', ...(message.listUnsubscribe ? { 'List-Unsubscribe': message.listUnsubscribe } : {}), ...(message.internal ? { 'X-ClassOne-Notice': 'internal' } : {}) },
    references: message.references?.join(' '),
  });
  const built = (await mail.compile().build()) as Buffer;
  return built.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class GmailTransport implements EmailTransport {
  readonly name = 'gmail' as const;

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const auth = oauthClient();
    const gmail = google.gmail({ version: 'v1', auth });
    // Our own Message-ID, so the next message's In-Reply-To can point at it even if reading it back fails.
    const domain = env.EMAIL_FROM_ADDRESS.split('@')[1] ?? 'classone.local';
    const ourMessageId = `<${randomUUID()}@${domain}>`;
    const raw = await buildRawMessage(message, ourMessageId);
    const response = await gmail.users.messages.send({ userId: 'me', requestBody: { raw, ...(message.threadId ? { threadId: message.threadId } : {}) } });
    const id = response.data.id ?? '';
    // Gmail may rewrite Message-ID; read back the one it actually sent (needs the read scope — best effort).
    let rfcMessageId = ourMessageId;
    try {
      const sent = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Message-ID'] });
      rfcMessageId = sent.data.payload?.headers?.find((h) => h.name?.toLowerCase() === 'message-id')?.value ?? ourMessageId;
    } catch {
      // Send-only token: keep ours.
    }
    return { providerMessageId: id, threadId: response.data.threadId ?? undefined, rfcMessageId };
  }
}
