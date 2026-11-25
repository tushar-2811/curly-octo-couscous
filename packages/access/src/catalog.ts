import type { GrantLevel, ResourceType } from '@aiw/db';

/**
 * What can be granted, and what each level allows. Levels are ordered: a write grant
 * includes read. Phase 1 offers read and write only; nothing grants admin to an AI
 * employee yet (least privilege, PRD SEC-1), and it never merges its own work.
 */

export const RESOURCE_TYPES: readonly ResourceType[] = [
  'repo',
  'jira_project',
  'chat_space',
  'figma_file',
];

export const LEVEL_RANK: Record<GrantLevel, number> = { read: 1, write: 2, admin: 3 };

interface ResourceTypeInfo {
  label: string;
  plural: string;
  /** In a sentence: "a repository", "2 Jira projects". */
  noun: string;
  nouns: string;
  /** Levels an AI employee may be granted on this type. */
  levels: GrantLevel[];
  /** What the external id looks like, and how to normalise it. */
  externalId: { pattern: RegExp; example: string; hint: string; normalize: (v: string) => string };
  levelHelp: Partial<Record<GrantLevel, string>>;
}

export const RESOURCE_TYPE_INFO: Record<ResourceType, ResourceTypeInfo> = {
  repo: {
    label: 'Repository',
    plural: 'Repositories',
    noun: 'repository',
    nouns: 'repositories',
    levels: ['read', 'write'],
    externalId: {
      pattern: /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/,
      example: 'acme/web-app',
      hint: 'Use owner/name, for example acme/web-app',
      normalize: (v) => v.trim(),
    },
    levelHelp: {
      read: 'Clone and read code',
      write: 'Push branches, open pull requests and reply to reviews',
    },
  },
  jira_project: {
    label: 'Jira project',
    plural: 'Jira projects',
    noun: 'Jira project',
    nouns: 'Jira projects',
    levels: ['read', 'write'],
    externalId: {
      pattern: /^[A-Z][A-Z0-9_]{1,9}$/,
      example: 'PF',
      hint: 'Use the project key, for example PF',
      normalize: (v) => v.trim().toUpperCase(),
    },
    levelHelp: {
      read: 'Read issues, comments and attachments',
      write: 'Comment, move issues through the workflow and create issues',
    },
  },
  chat_space: {
    label: 'Chat space',
    plural: 'Chat spaces',
    noun: 'Chat space',
    nouns: 'Chat spaces',
    levels: ['read', 'write'],
    externalId: {
      pattern: /^spaces\/[A-Za-z0-9_-]{1,100}$/,
      example: 'spaces/AAAAbcd123',
      hint: 'Use the space id, for example spaces/AAAAbcd123',
      normalize: (v) => v.trim(),
    },
    levelHelp: {
      read: 'Listen to messages in the space',
      write: 'Post messages and reply in threads',
    },
  },
  figma_file: {
    label: 'Figma file',
    plural: 'Figma files',
    noun: 'Figma file',
    nouns: 'Figma files',
    levels: ['read'],
    externalId: {
      pattern: /^[A-Za-z0-9]{10,64}$/,
      example: 'aBcD1234efGH5678',
      hint: 'Use the file key from the Figma URL',
      normalize: (v) => v.trim(),
    },
    levelHelp: { read: 'Read frames, components and render images' },
  },
};

/** Actions the platform checks, and the level each needs (Technical architecture §11). */
export const ACTIONS = {
  'repo.read': { type: 'repo', level: 'read', label: 'Clone and read code' },
  'repo.push_branch': { type: 'repo', level: 'write', label: 'Push a branch', branch: true },
  'repo.open_pr': { type: 'repo', level: 'write', label: 'Open a pull request', branch: true },
  'repo.comment': { type: 'repo', level: 'write', label: 'Comment on a pull request' },
  'jira.read_issue': { type: 'jira_project', level: 'read', label: 'Read issues' },
  'jira.comment': { type: 'jira_project', level: 'write', label: 'Comment on issues' },
  'jira.transition': { type: 'jira_project', level: 'write', label: 'Move issues' },
  'jira.create_issue': { type: 'jira_project', level: 'write', label: 'Create issues' },
  'chat.read': { type: 'chat_space', level: 'read', label: 'Read messages' },
  'chat.post': { type: 'chat_space', level: 'write', label: 'Post messages' },
  'figma.read': { type: 'figma_file', level: 'read', label: 'Read designs' },
} as const satisfies Record<
  string,
  { type: ResourceType; level: GrantLevel; label: string; branch?: boolean }
>;

export type ActionKey = keyof typeof ACTIONS;

export function isAction(value: string): value is ActionKey {
  return Object.hasOwn(ACTIONS, value);
}

/** Role template integrations that need a grant of this resource type before onboarding. */
export const INTEGRATION_RESOURCE: Record<string, ResourceType> = {
  git_host: 'repo',
  jira: 'jira_project',
  figma: 'figma_file',
};

export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const BRANCH_PATTERN = /^[A-Za-z0-9._/*-]{1,100}$/;
export const MAX_TAGS = 20;
export const MAX_BRANCHES = 20;

/** Glob match where * matches any run of characters, including "/". */
export function branchMatches(pattern: string, branch: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\/-]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(branch);
}
