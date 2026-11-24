/**
 * Ethereal (nodemailer's disposable SMTP sandbox) — the safe default. Nothing
 * is ever delivered to a real inbox; every send gets a preview link instead.
 * No signup, no credentials to manage, which is why this is `EMAIL_PROVIDER`'s
 * default and the one automated tests should use.
 */
import nodemailer from 'nodemailer';
import { env } from '../../../config/env.js';
import type { EmailMessage, EmailSendResult, EmailTransport } from './types.js';

let cachedTransporter: ReturnType<typeof nodemailer.createTransport> | null = null;

async function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const account = await nodemailer.createTestAccount();
  cachedTransporter = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.user, pass: account.pass },
  });
  return cachedTransporter;
}

export class EtherealTransport implements EmailTransport {
  readonly name = 'ethereal' as const;

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const transporter = await getTransporter();
    const info = await transporter.sendMail({
      from: `"${env.EMAIL_FROM_NAME}" <${env.EMAIL_FROM_ADDRESS}>`,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      inReplyTo: message.inReplyToMessageId,
      references: message.references,
    });
    return {
      providerMessageId: info.messageId,
      previewUrl: nodemailer.getTestMessageUrl(info) || undefined,
    };
  }
}
