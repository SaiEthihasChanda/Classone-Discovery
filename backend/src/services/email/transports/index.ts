import { env } from '../../../config/env.js';
import { EtherealTransport } from './etherealTransport.js';
import { GmailTransport } from './gmailTransport.js';
import type { EmailMessage, EmailSendResult, EmailTransport } from './types.js';

export type { EmailMessage, EmailSendResult, EmailTransport } from './types.js';

let cached: EmailTransport | null = null;

/**
 * Domains reserved for examples and testing (RFC 2606 / 6761): mail to them can never arrive, so it is
 * never sent — demo and test data use them, and a send would only bounce back into the sales inbox.
 */
const RESERVED = /@(?:[^@]+\.)?(?:example\.(?:com|org|net|edu)|[^@]+\.(?:test|example|invalid|localhost))$/i;
export const isReservedAddress = (to: string) => RESERVED.test(to.trim());

/** Wraps a transport so reserved addresses are dropped (logged) instead of sent. */
function guarded(t: EmailTransport): EmailTransport {
  return {
    name: t.name,
    async send(m: EmailMessage): Promise<EmailSendResult> {
      if (isReservedAddress(m.to)) {
        console.log(`[email] not sent to ${m.to} — a reserved example/test address`);
        return { providerMessageId: `skipped-${Date.now()}` };
      }
      return t.send(m);
    },
  };
}

/** Returns the transport `EMAIL_PROVIDER` selects. Cached — each provider manages its own connection/auth state. */
export function getEmailTransport(): EmailTransport {
  if (cached) return cached;
  cached = guarded(env.EMAIL_PROVIDER === 'gmail' ? new GmailTransport() : new EtherealTransport());
  return cached;
}

/** Test seam (tests see every message, reserved addresses included). */
export function setEmailTransport(transport: EmailTransport | null): void {
  cached = transport;
}
