import { env } from '../../../config/env.js';
import { EtherealTransport } from './etherealTransport.js';
import { GmailTransport } from './gmailTransport.js';
import type { EmailTransport } from './types.js';

export type { EmailMessage, EmailSendResult, EmailTransport } from './types.js';

let cached: EmailTransport | null = null;

/** Returns the transport `EMAIL_PROVIDER` selects. Cached — each provider manages its own connection/auth state. */
export function getEmailTransport(): EmailTransport {
  if (cached) return cached;
  cached = env.EMAIL_PROVIDER === 'gmail' ? new GmailTransport() : new EtherealTransport();
  return cached;
}

/** Test seam. */
export function setEmailTransport(transport: EmailTransport | null): void {
  cached = transport;
}
