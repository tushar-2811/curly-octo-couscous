/**
 * Reading Jira (Phase 2, slice 6). Read-only: the employee can look tickets up to answer
 * questions, never change them. Behind an interface so tests use a fake and the Atlassian
 * account can later be the employee's own.
 */
export interface JiraComment {
  author: string;
  created: string;
  text: string;
}

export interface JiraIssue {
  key: string;
  url: string;
  type: string | null;
  summary: string;
  status: string | null;
  statusCategory: string | null;
  assignee: string | null;
  reporter: string | null;
  priority: string | null;
  created: string | null;
  updated: string | null;
  due: string | null;
  labels: string[];
  parent: string | null;
  sprint: string | null;
  description: string;
  /** Newest first. */
  comments: JiraComment[];
}

export interface JiraReader {
  readonly site: string;
  /** Null when the issue does not exist or the account cannot see it. */
  getIssue(key: string): Promise<JiraIssue | null>;
  /** Issues matching words, newest change first. */
  searchText(words: string, limit: number): Promise<JiraIssue[]>;
  /** Whether this project may be read at all (JIRA_PROJECTS). */
  allows(key: string): boolean;
}

export type JiraErrorCode =
  'auth' | 'forbidden' | 'rate_limited' | 'timeout' | 'unavailable' | 'bad_request';

export class JiraError extends Error {
  readonly retryable: boolean;
  constructor(
    public readonly code: JiraErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'JiraError';
    this.retryable = code === 'rate_limited' || code === 'timeout' || code === 'unavailable';
  }
}

export const JIRA_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;

type Adf = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: Adf[] };

/** Atlassian Document Format to plain text: paragraphs, lists, mentions, links, code. */
export function adfToText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as Adf;
  const inner = (sep = '') => (n.content ?? []).map((c) => adfToText(c)).join(sep);
  switch (n.type) {
    case 'text':
      return n.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
      return String(n.attrs?.text ?? '@someone');
    case 'emoji':
      return String(n.attrs?.text ?? n.attrs?.shortName ?? '');
    case 'inlineCard':
    case 'blockCard':
      return String(n.attrs?.url ?? '');
    case 'date':
      return n.attrs?.timestamp
        ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10)
        : '';
    case 'paragraph':
    case 'heading':
      return `${inner()}\n`;
    case 'codeBlock':
      return `\`\`\`\n${inner()}\n\`\`\`\n`;
    case 'listItem':
      return `- ${inner().trim()}\n`;
    case 'bulletList':
    case 'orderedList':
      return `${inner()}`;
    case 'tableRow':
      return `${(n.content ?? []).map((c) => adfToText(c).trim()).join(' | ')}\n`;
    case 'mediaSingle':
    case 'media':
    case 'mediaGroup':
      return '[attachment]\n';
    default:
      return inner();
  }
}

function clip(text: string, max: number): string {
  const t = text.replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const ISSUE_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'assignee',
  'reporter',
  'priority',
  'created',
  'updated',
  'duedate',
  'labels',
  'parent',
  'description',
];

export interface JiraCloudOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Project keys that may be read, e.g. ["PF"]. Empty: any project the account can see. */
  projects?: string[];
  timeoutMs?: number;
  maxRetries?: number;
}

/** Jira Cloud REST API v3 with an Atlassian API token (Basic auth). */
export class JiraCloudClient implements JiraReader {
  readonly site: string;
  private readonly auth: string;
  private readonly projects: Set<string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: JiraCloudOptions) {
    this.site = new URL(options.baseUrl).host;
    this.auth = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString('base64')}`;
    this.projects = new Set(
      (options.projects ?? []).map((p) => p.trim().toUpperCase()).filter(Boolean),
    );
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  allows(key: string): boolean {
    if (!JIRA_KEY.test(key)) return false;
    return this.projects.size === 0 || this.projects.has(key.split('-')[0]!);
  }

  async getIssue(key: string): Promise<JiraIssue | null> {
    if (!this.allows(key)) return null;
    const fields = await this.request<{ key: string; fields: Record<string, unknown> }>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(',')},customfield_10020`,
    );
    if (!fields) return null;
    const comments = await this.request<{
      comments?: { author?: { displayName?: string }; created?: string; body?: unknown }[];
    }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/comment?orderBy=-created&maxResults=5`);
    return this.toIssue(fields.key, fields.fields, comments?.comments ?? []);
  }

  async searchText(words: string, limit: number): Promise<JiraIssue[]> {
    const text = words.replace(/["\\]/g, ' ').trim().slice(0, 200);
    if (!text) return [];
    const scope =
      this.projects.size > 0 ? `project in (${[...this.projects].join(', ')}) AND ` : '';
    const out = await this.request<{ issues?: { key: string; fields: Record<string, unknown> }[] }>(
      'POST',
      '/rest/api/3/search/jql',
      {
        jql: `${scope}text ~ "${text}" ORDER BY updated DESC`,
        maxResults: Math.min(Math.max(limit, 1), 10),
        fields: [...ISSUE_FIELDS, 'customfield_10020'],
      },
    );
    return (out?.issues ?? []).map((i) => this.toIssue(i.key, i.fields, []));
  }

  private toIssue(
    key: string,
    f: Record<string, unknown>,
    comments: { author?: { displayName?: string }; created?: string; body?: unknown }[],
  ): JiraIssue {
    const name = (v: unknown) =>
      v && typeof v === 'object' && 'name' in v ? String((v as { name: unknown }).name) : null;
    const person = (v: unknown) =>
      v && typeof v === 'object' && 'displayName' in v
        ? String((v as { displayName: unknown }).displayName)
        : null;
    const status = f.status as { name?: string; statusCategory?: { name?: string } } | undefined;
    const sprints = Array.isArray(f.customfield_10020)
      ? (f.customfield_10020 as { name?: string; state?: string }[])
      : [];
    const sprint = sprints.find((s) => s.state === 'active') ?? sprints.at(-1);
    return {
      key,
      url: `${this.options.baseUrl.replace(/\/$/, '')}/browse/${key}`,
      type: name(f.issuetype),
      summary: String(f.summary ?? ''),
      status: status?.name ?? null,
      statusCategory: status?.statusCategory?.name ?? null,
      assignee: person(f.assignee),
      reporter: person(f.reporter),
      priority: name(f.priority),
      created: typeof f.created === 'string' ? f.created : null,
      updated: typeof f.updated === 'string' ? f.updated : null,
      due: typeof f.duedate === 'string' ? f.duedate : null,
      labels: Array.isArray(f.labels) ? (f.labels as string[]) : [],
      parent:
        f.parent && typeof f.parent === 'object' && 'key' in f.parent
          ? String((f.parent as { key: unknown }).key)
          : null,
      sprint: sprint?.name ?? null,
      description: clip(adfToText(f.description), 3000),
      comments: comments.map((c) => ({
        author: c.author?.displayName ?? 'Someone',
        created: c.created ?? '',
        text: clip(adfToText(c.body), 800),
      })),
    };
  }

  /** Null on 404 (missing or not visible to this account). */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, path, body);
      } catch (err) {
        if (!(err instanceof JiraError) || !err.retryable || attempt >= this.maxRetries) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
      }
    }
  }

  private async once<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | null> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          authorization: this.auth,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new JiraError('timeout', 'Jira did not answer in time');
      }
      throw new JiraError('unavailable', 'Could not reach Jira');
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      const s = response.status;
      if (s === 401) throw new JiraError('auth', 'Jira rejected the API token or email', s);
      if (s === 403) throw new JiraError('forbidden', `Jira refused access: ${detail}`, s);
      if (s === 429) throw new JiraError('rate_limited', 'Jira rate limit reached', s);
      if (s >= 500) throw new JiraError('unavailable', `Jira error ${s}`, s);
      throw new JiraError('bad_request', `Jira rejected the request: ${detail}`, s);
    }
    return (await response.json()) as T;
  }
}

/** A ticket as text for the reply model: the facts first, then recent comments. */
export function issueEvidenceText(issue: JiraIssue): string {
  const lines = [
    `${issue.key} (${issue.type ?? 'issue'}): ${issue.summary}`,
    `Status: ${issue.status ?? 'unknown'}${issue.statusCategory ? ` (${issue.statusCategory})` : ''}`,
    `Assignee: ${issue.assignee ?? 'unassigned'} · Reporter: ${issue.reporter ?? 'unknown'} · Priority: ${issue.priority ?? 'none'}`,
    `Updated: ${issue.updated?.slice(0, 10) ?? 'unknown'}${issue.due ? ` · Due: ${issue.due}` : ''}${issue.sprint ? ` · Sprint: ${issue.sprint}` : ''}`,
    issue.parent ? `Parent: ${issue.parent}` : '',
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}` : '',
    issue.description ? `Description: ${clip(issue.description, 1200)}` : 'Description: none',
    ...issue.comments
      .slice(0, 3)
      .map((c) => `Comment by ${c.author} on ${c.created.slice(0, 10)}: ${clip(c.text, 400)}`),
  ];
  return lines.filter(Boolean).join('\n');
}
