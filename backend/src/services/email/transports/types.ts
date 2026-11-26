/** What every email transport needs to send one message, regardless of provider. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Threads a reply under the same provider conversation, when the provider supports it. */
  inReplyToMessageId?: string;
  references?: string[];
  /** Gmail only: keep the message in this Gmail conversation (a reply to the lead's mail). */
  threadId?: string;
  /** Files to attach; give a `cid` to show an image inline in the HTML (<img src="cid:...">). */
  attachments?: Array<{ filename: string; content: Buffer; contentType: string; cid?: string }>;
  /** A List-Unsubscribe header value, e.g. "<mailto:sales@x.com?subject=unsubscribe>" (campaigns). */
  listUnsubscribe?: string;
  /** A note to the team (digest, run finished, test send): tagged so the inbox sync never files it as a conversation. */
  internal?: boolean;
}

export interface EmailSendResult {
  providerMessageId: string;
  /** Ethereal only — the inbox preview link, since nothing is actually delivered. */
  previewUrl?: string;
  /** Gmail only: the conversation it landed in — a reply from the lead arrives in the same one. */
  threadId?: string;
  /** The RFC Message-ID header, for the next message's In-Reply-To. */
  rfcMessageId?: string;
}

export interface EmailTransport {
  readonly name: 'ethereal' | 'gmail';
  send(message: EmailMessage): Promise<EmailSendResult>;
}
