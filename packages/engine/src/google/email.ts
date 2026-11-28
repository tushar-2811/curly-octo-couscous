import type { GmailPart } from './workspace';

/**
 * Plain functions for email: reading headers, addresses and the body of a Gmail message,
 * cutting the quoted history off a reply, spotting automated mail, and composing a reply
 * that mail clients thread correctly. No network, so they are tested directly.
 */

/** Header the employee adds to every email it sends: finds a reply already sent, stops loops. */
export const OUTBOUND_HEADER = 'X-AIW-Outbound-Id';

export interface Address {
  name: string | null;
  email: string;
}

/** Headers by lower-case name (the first value wins, as mail clients do). */
export function headerMap(part: GmailPart | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of part?.headers ?? []) {
    const key = h.name.toLowerCase();
    if (!map.has(key)) map.set(key, h.value);
  }
  return map;
}

/** Decode RFC 2047 encoded words (=?UTF-8?B?...?=, =?ISO-8859-1?Q?...?=). Plain text is kept. */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(
      /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
      (whole, charset: string, enc: string, text: string) => {
        try {
          const bytes =
            enc.toUpperCase() === 'B'
              ? Buffer.from(text, 'base64')
              : Buffer.from(
                  text
                    .replace(/_/g, ' ')
                    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
                      String.fromCharCode(parseInt(hex, 16)),
                    ),
                  'latin1',
                );
          return new TextDecoder(charset.toLowerCase()).decode(bytes);
        } catch {
          return whole;
        }
      },
    );
}

/** Split an address header on commas outside quotes and angle brackets. */
export function parseAddressList(value: string | undefined): Address[] {
  if (!value) return [];
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if (ch === ',' && !quoted && angle === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  const out: Address[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const m = /<([^<>\s]+@[^<>\s]+)>/.exec(part);
    const email = (m ? m[1]! : part).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) continue;
    const name = m
      ? decodeWords(part.slice(0, m.index).trim().replace(/^"|"$/g, '').replace(/\\"/g, '"')).trim()
      : '';
    out.push({ name: name || null, email });
  }
  return out;
}

function decodeData(data: string | undefined): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

/** Rough HTML to text: enough for mail that has no plain-text part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The message text: the first plain-text part, else the first HTML part as text. */
export function extractBody(part: GmailPart | undefined): string {
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    const attachment = Boolean(p.filename) || Boolean(p.body?.attachmentId);
    if (!attachment && p.mimeType === 'text/plain' && p.body?.data)
      plain.push(decodeData(p.body.data));
    else if (!attachment && p.mimeType === 'text/html' && p.body?.data)
      html.push(decodeData(p.body.data));
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  const text = plain[0] ?? (html[0] ? htmlToText(html[0]) : '');
  return text.replace(/\r\n/g, '\n').trim();
}

const QUOTE_STARTS = [
  // Gmail, Apple Mail: "On Thu, 27 Nov 2026 at 21:00, Mia <mia@co.test> wrote:" (may wrap).
  /^On [^\n]{1,250}(?:\n[^\n]{1,250})?wrote:[ \t]*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  // Outlook: "From: ...\nSent: ..."
  /^From: [^\n]+\n(?:Sent|Date): /m,
  // Signature delimiter.
  /^-- $/m,
];

/**
 * The new part of a reply: cuts the quoted earlier messages and the signature. Forwarded
 * messages are kept (they are what the sender wants read). Never returns empty text when
 * the message had some.
 */
export function stripQuoted(text: string): string {
  let cut = text.length;
  for (const re of QUOTE_STARTS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  const lines = text.slice(0, cut).split('\n');
  while (lines.length > 0 && /^\s*(>.*)?$/.test(lines[lines.length - 1]!)) lines.pop();
  const fresh = lines.join('\n').trim();
  return fresh || text.trim();
}

/** Why an email is automated and must not be answered, or null for a person's email. */
export function automatedReason(headers: Map<string, string>, from: Address | null): string | null {
  if (headers.has(OUTBOUND_HEADER.toLowerCase())) return 'own_reply';
  const auto = headers.get('auto-submitted')?.trim().toLowerCase();
  if (auto && auto !== 'no') return 'auto_submitted';
  if (headers.has('x-autoreply') || headers.has('x-autorespond')) return 'auto_reply';
  const precedence = headers.get('precedence')?.trim().toLowerCase();
  if (precedence && ['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)) return 'bulk';
  if (headers.has('list-id') || headers.has('list-unsubscribe')) return 'mailing_list';
  const local = from?.email.split('@')[0] ?? '';
  if (
    /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?)([+._-]|$)/i.test(
      local,
    )
  ) {
    return 'no_reply_sender';
  }
  return null;
}

/** Message-IDs in a header, e.g. "<a@x> <b@y>". */
export function messageIds(value: string | null | undefined): string[] {
  return value?.match(/<[^<>\s]+>/g) ?? [];
}

const noBreaks = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();

/** RFC 2047 encode a header value when it is not plain ASCII, in words of ≤ 45 bytes. */
export function encodeHeader(value: string): string {
  const clean = noBreaks(value);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let chunk = '';
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

export function replySubject(subject: string | null): string {
  const s = noBreaks(subject ?? '');
  if (!s) return 'Re: your email';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export interface ReplyMime {
  to: Address;
  subject: string | null;
  /** The Message-ID of the email being answered. */
  inReplyTo: string | null;
  /** Its References header. */
  references: string | null;
  body: string;
  outboundId: string;
}

/**
 * A plain-text reply as an RFC 5322 message. From is left out: Gmail sets it to the
 * account. In-Reply-To and References thread it in every client; the outbound header
 * lets a retry find a reply already sent.
 */
export function buildReplyMime(input: ReplyMime): string {
  const to = input.to.name
    ? `${/^[\x20-\x7e]*$/.test(input.to.name) ? `"${noBreaks(input.to.name).replace(/["\\]/g, '')}"` : encodeHeader(input.to.name)} <${input.to.email}>`
    : input.to.email;
  const parent = messageIds(input.inReplyTo)[0] ?? null;
  // Keep the chain short: the first message and the most recent ones.
  const chain = [...messageIds(input.references), ...(parent ? [parent] : [])];
  const unique = [...new Set(chain)];
  const refs = unique.length > 10 ? [unique[0]!, ...unique.slice(-9)] : unique;
  const headers = [
    `To: ${noBreaks(to)}`,
    `Subject: ${encodeHeader(replySubject(input.subject))}`,
    ...(parent ? [`In-Reply-To: ${parent}`] : []),
    ...(refs.length > 0 ? [`References: ${refs.join(' ')}`] : []),
    `${OUTBOUND_HEADER}: ${noBreaks(input.outboundId)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(input.body.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}
