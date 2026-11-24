/**
 * Real send via the Gmail API (not raw SMTP) — composed with nodemailer's
 * MailComposer so the MIME message (headers, threading, HTML+text parts) is
 * built the same well-tested way as the Ethereal transport, then handed to
 * Gmail as a base64url `raw` message per Google's API.
 *
 * Needs OAuth: GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN. The refresh token comes
 * from running `npm run gmail:auth` once — see `scripts/gmailAuth.ts`.
 */
import { google } from 'googleapis';
import MailComposer from 'nodemailer/lib/mail-composer';
import { env } from '../../../config/env.js';
import type { EmailMessage, EmailSendResult, EmailTransport } from './types.js';

function oauthClient() {
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

async function buildRawMessage(message: EmailMessage): Promise<string> {
  const mail = new MailComposer({
    from: `"${env.EMAIL_FROM_NAME}" <${env.EMAIL_FROM_ADDRESS}>`,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    inReplyTo: message.inReplyToMessageId,
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
    const raw = await buildRawMessage(message);
    const response = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return { providerMessageId: response.data.id ?? '' };
  }
}
