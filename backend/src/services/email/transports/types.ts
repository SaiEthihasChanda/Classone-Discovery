/** What every email transport needs to send one message, regardless of provider. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Threads a reply under the same provider conversation, when the provider supports it. */
  inReplyToMessageId?: string;
  references?: string[];
}

export interface EmailSendResult {
  providerMessageId: string;
  /** Ethereal only — the inbox preview link, since nothing is actually delivered. */
  previewUrl?: string;
}

export interface EmailTransport {
  readonly name: 'ethereal' | 'gmail';
  send(message: EmailMessage): Promise<EmailSendResult>;
}
