import { describe, expect, it } from 'vitest';
import {
  automatedReason,
  buildReplyMime,
  decodeWords,
  encodeHeader,
  extractBody,
  parseAddressList,
  replySubject,
  stripQuoted,
} from './email';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const headers = (o: Record<string, string>) =>
  new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

describe('email addresses', () => {
  it('reads names, quotes, commas and bare addresses', () => {
    expect(
      parseAddressList('"Dubey, Chirag" <Chirag@Co.test>, mia@co.test, Raj <raj@co.test>, junk'),
    ).toEqual([
      { name: 'Dubey, Chirag', email: 'chirag@co.test' },
      { name: null, email: 'mia@co.test' },
      { name: 'Raj', email: 'raj@co.test' },
    ]);
    expect(parseAddressList(undefined)).toEqual([]);
  });

  it('decodes encoded words', () => {
    expect(decodeWords('=?UTF-8?B?w4lxdWlwZQ==?= <e@co.test>')).toBe('Équipe <e@co.test>');
    expect(decodeWords('=?ISO-8859-1?Q?caf=E9_time?=')).toBe('café time');
    expect(decodeWords('plain')).toBe('plain');
  });
});

describe('email body', () => {
  it('prefers the plain-text part and skips attachments', () => {
    const body = extractBody({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('Hello\r\nthere') } },
            { mimeType: 'text/html', body: { data: b64('<p>Hello</p>') } },
          ],
        },
        { mimeType: 'text/plain', filename: 'notes.txt', body: { attachmentId: 'a1' } },
      ],
    });
    expect(body).toBe('Hello\nthere');
  });

  it('turns HTML into text when there is no plain part', () => {
    const body = extractBody({
      mimeType: 'text/html',
      body: {
        data: b64(
          '<style>p{}</style><p>Hi&nbsp;Nova,</p><ul><li>one</li><li>two &amp; three</li></ul>',
        ),
      },
    });
    expect(body).toBe('Hi Nova,\n- one\n- two & three');
  });

  it('cuts the quoted history and signature, keeping forwards', () => {
    expect(
      stripQuoted(
        'Yes, ship it.\n\nOn Thu, 27 Nov 2026 at 21:00, Mia Wong <\nmia@co.test> wrote:\n> Ship?\n',
      ),
    ).toBe('Yes, ship it.');
    expect(stripQuoted('Done.\n\nFrom: Raj\nSent: Friday\nTo: Nova\n\nold')).toBe('Done.');
    expect(stripQuoted('Thanks\n-- \nRaj Kumar\nEngineer')).toBe('Thanks');
    expect(stripQuoted('Please read\n\n---------- Forwarded message ---------\nFrom: X')).toContain(
      'Forwarded message',
    );
    // Only quoted text: keep it rather than store nothing.
    expect(stripQuoted('> just a quote')).toBe('> just a quote');
  });
});

describe('automated mail', () => {
  it('spots lists, auto-replies, no-reply senders and its own replies', () => {
    const person = { name: 'Mia', email: 'mia@co.test' };
    expect(automatedReason(headers({}), person)).toBeNull();
    expect(automatedReason(headers({ 'Auto-Submitted': 'auto-replied' }), person)).toBe(
      'auto_submitted',
    );
    expect(automatedReason(headers({ 'Auto-Submitted': 'no' }), person)).toBeNull();
    expect(automatedReason(headers({ 'List-Unsubscribe': '<x>' }), person)).toBe('mailing_list');
    expect(automatedReason(headers({ Precedence: 'bulk' }), person)).toBe('bulk');
    expect(automatedReason(headers({}), { name: null, email: 'no-reply@jira.test' })).toBe(
      'no_reply_sender',
    );
    expect(automatedReason(headers({}), { name: null, email: 'noreply+x@co.test' })).toBe(
      'no_reply_sender',
    );
    expect(automatedReason(headers({ 'X-AIW-Outbound-Id': 'r1' }), person)).toBe('own_reply');
  });
});

describe('reply MIME', () => {
  const parse = (mime: string) => {
    const [head, body] = mime.split('\r\n\r\n');
    const unfolded = head!.replace(/\r\n /g, ' ');
    const h = new Map(
      unfolded.split('\r\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]),
    );
    return { h, body: Buffer.from(body!.replace(/\r\n/g, ''), 'base64').toString('utf8') };
  };

  it('threads the reply and marks it as ours', () => {
    const { h, body } = parse(
      buildReplyMime({
        to: { name: 'Mia Wong', email: 'mia@co.test' },
        subject: 'Release plan',
        inReplyTo: '<m2@co.test>',
        references: '<m1@co.test>',
        body: 'Hi Mia,\nYes.\n\nNova',
        outboundId: 'reply-1',
      }),
    );
    expect(h.get('To')).toBe('"Mia Wong" <mia@co.test>');
    expect(h.get('Subject')).toBe('Re: Release plan');
    expect(h.get('In-Reply-To')).toBe('<m2@co.test>');
    expect(h.get('References')).toBe('<m1@co.test> <m2@co.test>');
    expect(h.get('X-AIW-Outbound-Id')).toBe('reply-1');
    expect(h.has('From')).toBe(false);
    expect(body).toBe('Hi Mia,\r\nYes.\r\n\r\nNova');
  });

  it('encodes non-ASCII headers and drops line breaks that could add headers', () => {
    const mime = buildReplyMime({
      to: { name: 'Zoë', email: 'zoe@co.test' },
      subject: 'Café plan\r\nBcc: evil@x.test',
      inReplyTo: null,
      references: null,
      body: 'ok',
      outboundId: 'r2',
    });
    const head = mime.split('\r\n\r\n')[0]!;
    expect(head).not.toMatch(/^Bcc:/m);
    expect(head).toContain('=?UTF-8?B?');
    expect(head).not.toContain('In-Reply-To');
    expect(decodeWords(encodeHeader('Re: Café plan Bcc: evil@x.test'))).toBe(
      'Re: Café plan Bcc: evil@x.test',
    );
  });

  it('keeps an existing Re: and fills an empty subject', () => {
    expect(replySubject('RE: hi')).toBe('RE: hi');
    expect(replySubject(null)).toBe('Re: your email');
  });
});
