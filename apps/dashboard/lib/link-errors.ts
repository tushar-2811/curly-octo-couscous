/**
 * What went wrong when linking a Google account, keyed by the code the API puts in the
 * redirect (?link_error=…). Mirrors LINK_ERROR_MESSAGES in @aiw/workforce.
 */
const MESSAGES: Record<string, { title: string; detail: string }> = {
  link_expired: {
    title: 'The sign-in link expired',
    detail: 'It was older than 10 minutes or already used. Start again.',
  },
  session_mismatch: {
    title: 'Sign-in finished in another session',
    detail:
      'Start linking from this page and finish in the same browser, signed in to this dashboard.',
  },
  consent_denied: {
    title: 'Google sign-in was cancelled',
    detail: 'Nothing was linked. Start again and allow the listed permissions.',
  },
  admin_blocked: {
    title: 'Your Google Workspace admin blocks this app',
    detail:
      'Ask them to allow it in the Google Admin console (Security → API controls → App access control).',
  },
  email_unverified: {
    title: 'The account’s email isn’t verified',
    detail: 'Google reports this account’s email address as unverified.',
  },
  not_workspace: {
    title: 'That’s a personal Google account',
    detail: 'Sign in with the company Google Workspace account.',
  },
  wrong_domain: {
    title: 'That account isn’t in your company’s Google Workspace',
    detail: 'Sign in with an account on your organization’s domain.',
  },
  wrong_account: {
    title: 'You signed in as another account',
    detail: 'Choose the employee’s account on Google’s account picker, not your own.',
  },
  already_linked: {
    title: 'That Google account is already linked',
    detail: 'It belongs to another AI employee. Each employee needs its own account.',
  },
  scopes_missing: {
    title: 'Some permissions weren’t granted',
    detail: 'Start again and allow every permission Google lists.',
  },
  invalid_state: {
    title: 'This employee isn’t waiting for a Google account',
    detail: 'Its state changed while you were signing in. Reload the page.',
  },
  google_error: {
    title: 'Google didn’t complete the sign-in',
    detail: 'Try again in a minute. If it keeps failing, quote the request ID below.',
  },
};

export function linkErrorMessage(code: string, expectedEmail?: string | null) {
  const message = MESSAGES[code] ?? MESSAGES.google_error!;
  if (code === 'wrong_account' && expectedEmail) {
    return { ...message, detail: `Sign in as ${expectedEmail}. ${message.detail}` };
  }
  return message;
}
