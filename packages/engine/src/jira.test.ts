import { Writable } from 'node:stream';
import { createLogger } from '@aiw/logger';
import { describe, expect, it } from 'vitest';
import { adfToText, issueEvidenceText, JiraError, type JiraIssue, type JiraReader } from './jira';
import { jiraEvidence, searchKeywords } from './jira-evidence';

const silent = createLogger({
  service: 'test',
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

const issue = (key: string, over: Partial<JiraIssue> = {}): JiraIssue => ({
  key,
  url: `https://example.atlassian.net/browse/${key}`,
  type: 'Task',
  summary: `Summary of ${key}`,
  status: 'In Review',
  statusCategory: 'In Progress',
  assignee: 'Mia',
  reporter: 'Raj',
  priority: 'Medium',
  created: '2026-11-01T10:00:00.000+0000',
  updated: '2026-11-25T10:00:00.000+0000',
  due: null,
  labels: [],
  parent: null,
  sprint: 'PF Sprint 9',
  description: 'Do the thing',
  comments: [{ author: 'Raj', created: '2026-11-24T09:00:00.000+0000', text: 'Looks good' }],
  ...over,
});

class FakeJira implements JiraReader {
  readonly site = 'example.atlassian.net';
  issues = new Map<string, JiraIssue>([
    ['PF-1', issue('PF-1')],
    ['PF-2', issue('PF-2')],
  ]);
  fail = false;
  searched: string[] = [];
  allows(key: string) {
    return key.startsWith('PF-');
  }
  async getIssue(key: string) {
    if (this.fail) throw new JiraError('unavailable', 'down');
    return this.issues.get(key) ?? null;
  }
  async searchText(words: string) {
    this.searched.push(words);
    return [issue('PF-9')];
  }
}

describe('Atlassian document format', () => {
  it('becomes readable text', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Scope' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ask ' },
            { type: 'mention', attrs: { text: '@Mia' } },
            { type: 'hardBreak' },
            { type: 'inlineCard', attrs: { url: 'https://x.test/a' } },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }],
            },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe('Scope\nAsk @Mia\nhttps://x.test/a\n- one\n- two\n');
    expect(adfToText(null)).toBe('');
  });

  it('summarizes a ticket with status, owner and recent comments', () => {
    const text = issueEvidenceText(issue('PF-1'));
    expect(text).toContain('PF-1 (Task): Summary of PF-1');
    expect(text).toContain('Status: In Review (In Progress)');
    expect(text).toContain('Assignee: Mia');
    expect(text).toContain('Sprint: PF Sprint 9');
    expect(text).toContain('Comment by Raj on 2026-11-24: Looks good');
  });
});

describe('search keywords', () => {
  it('drops filler and question words', () => {
    expect(searchKeywords('Is there a ticket for the payments API timeout bug?')).toEqual([
      'payments',
      'api',
      'timeout',
      'bug',
    ]);
    expect(searchKeywords('Nova, any update?', ['Nova'])).toEqual([]);
  });
});

describe('finding tickets for a reply', () => {
  const run = (jira: JiraReader | null, over: Partial<Parameters<typeof jiraEvidence>[1]> = {}) =>
    jiraEvidence(jira, {
      needed: true,
      keys: [],
      text: '',
      summary: null,
      logger: silent,
      ...over,
    });

  it('reads keys found in the text or by the classifier', async () => {
    const out = await run(new FakeJira(), { text: 'what about pf-1?', keys: ['PF-2'] });
    expect(out.items.map((i) => i.id)).toEqual(['PF-1', 'PF-2']);
    expect(out.items[0]).toMatchObject({
      source: 'jira',
      url: expect.stringContaining('/browse/PF-1'),
    });
    expect(out.notes).toEqual([]);
  });

  it('says when a ticket is missing or in a project it may not read', async () => {
    const out = await run(new FakeJira(), { text: 'PF-404 and SEC-1' });
    expect(out.items).toEqual([]);
    expect(out.notes.join(' ')).toMatch(/SEC-1 is in a Jira project you are not allowed to read/);
    expect(out.notes.join(' ')).toMatch(/PF-404 was not found/);
  });

  it('searches when Jira is needed but no key was given, and only then', async () => {
    const jira = new FakeJira();
    const out = await run(jira, {
      text: "Nova, what's the status of the webview ticket generation form?",
      summary: 'Asks about the webview form',
      ignore: ['Nova'],
    });
    expect(jira.searched).toEqual(['webview generation form']);
    expect(out.items.map((i) => i.id)).toEqual(['PF-9']);
    expect(out.notes[0]).toMatch(/text search/);
    const none = await run(jira, { needed: false, text: 'hello' });
    expect(none.items).toEqual([]);
    expect(jira.searched).toHaveLength(1);
  });

  it('turns a Jira failure into a note, and reports when Jira is off', async () => {
    const jira = new FakeJira();
    jira.fail = true;
    const out = await run(jira, { text: 'PF-1?' });
    expect(out).toMatchObject({ items: [], available: true });
    expect(out.notes[0]).toMatch(/could not be reached/);
    expect(await run(null, { text: 'PF-1?' })).toEqual({ items: [], notes: [], available: false });
  });
});
