/**
 * One-time Gmail OAuth flow — run once to obtain GMAIL_REFRESH_TOKEN.
 *
 * Prerequisite (done once, in Google Cloud Console — the same project as the
 * Gemini key is fine): enable the Gmail API; configure the OAuth consent
 * screen (External, Testing, add the sending account as a test user);
 * Credentials -> Create OAuth client ID -> type "Desktop app". Put that
 * client's id/secret in .env as GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET first.
 *
 * Run:  npm run gmail:auth
 */
import http from 'node:http';
import { env } from '../config/env.js';

const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;

async function main(): Promise<void> {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    console.error(
      'Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first ' +
        '(a Desktop-app OAuth client from Google Cloud Console).',
    );
    process.exit(1);
  }

  const { google } = await import('googleapis');
  const client = new google.auth.OAuth2(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET, REDIRECT_URI);
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // forces a refresh_token even if this account has authorized it before
    // send: outreach and replies. modify: the inbox poller reads mail (services/email/inboxPoller.ts) and marks it
    // read when it is opened in Conversations; it never deletes, archives or labels anything.
    scope: ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.modify'],
  });

  console.log('\nOpen this URL in a browser signed into the Gmail account to send from, and approve access:\n');
  console.log(authUrl + '\n');
  console.log(`Waiting for the redirect on ${REDIRECT_URI} ...\n`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '', REDIRECT_URI);
      // Browsers also ask for /favicon.ico (or prefetch): ignore anything but Google's redirect.
      if (url.pathname !== '/oauth2callback') {
        res.statusCode = 404;
        res.end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.end(
        error
          ? 'Authorization failed — you can close this tab and check the terminal.'
          : 'Authorized — you can close this tab and return to the terminal.',
      );
      server.close();
      if (error) reject(new Error(error));
      else if (code) resolve(code);
      else reject(new Error('No authorization code in the redirect'));
    });
    server.listen(PORT);
  });

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      '\nNo refresh token came back — Google issues one only the first time an account approves this app. ' +
        'If this account has authorized it before, revoke access at ' +
        'https://myaccount.google.com/permissions and run this again.',
    );
    process.exit(1);
  }

  console.log('\nAdd this to .env:\n');
  console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
}

main().catch((error) => {
  console.error('Gmail auth failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
