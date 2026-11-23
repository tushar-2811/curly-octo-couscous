/**
 * Role templates ship as code (Technical architecture §9) and are referenced from
 * ai_profiles.role_key. A template gives an AI employee its default title, instructions,
 * capabilities and the tools it needs before it can work. Phase 1 has engineering roles
 * only; the role template SDK for other roles comes in Phase 6.
 */

export type IntegrationKey = 'google_workspace' | 'jira' | 'git_host' | 'figma';

export interface RoleTemplate {
  key: string;
  name: string;
  summary: string;
  defaultTitle: string;
  /** Baseline instructions; the employee's own instructions are added after these. */
  baseInstructions: string;
  capabilities: string[];
  integrations: { key: IntegrationKey; required: boolean }[];
  defaults: { maxConcurrency: number; maxOpenTasks: number };
}

export const INTEGRATION_LABELS: Record<IntegrationKey, string> = {
  google_workspace: 'Google Workspace account',
  jira: 'Jira',
  git_host: 'GitHub or Bitbucket',
  figma: 'Figma',
};

const ENGINEERING_INTEGRATIONS: RoleTemplate['integrations'] = [
  { key: 'jira', required: true },
  { key: 'git_host', required: true },
];

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: 'frontend_engineer',
    name: 'Frontend engineer',
    summary:
      'Builds and fixes user interfaces from Jira tickets and designs, and opens pull requests with screenshots.',
    defaultTitle: 'Frontend Software Engineer',
    baseInstructions:
      'Work on web user interfaces. Follow the repository conventions, keep components accessible, and attach screenshots of UI changes to every pull request.',
    capabilities: [
      'code.read',
      'code.write',
      'pull_requests',
      'tests.run',
      'browser.e2e',
      'jira.update',
      'design.read',
    ],
    integrations: [...ENGINEERING_INTEGRATIONS, { key: 'figma', required: false }],
    defaults: { maxConcurrency: 2, maxOpenTasks: 6 },
  },
  {
    key: 'backend_engineer',
    name: 'Backend engineer',
    summary:
      'Builds APIs, services and data changes, with tests and migration notes in every pull request.',
    defaultTitle: 'Backend Software Engineer',
    baseInstructions:
      'Work on services, APIs and data. Write tests for every change, never run destructive migrations without approval, and explain schema changes in the pull request.',
    capabilities: ['code.read', 'code.write', 'pull_requests', 'tests.run', 'jira.update'],
    integrations: ENGINEERING_INTEGRATIONS,
    defaults: { maxConcurrency: 2, maxOpenTasks: 6 },
  },
  {
    key: 'fullstack_engineer',
    name: 'Full-stack engineer',
    summary: 'Takes features end to end across the UI and the API.',
    defaultTitle: 'Full-stack Software Engineer',
    baseInstructions:
      'Work across the user interface and backend services. Keep changes small and reviewable, add tests at each layer, and attach screenshots of UI changes.',
    capabilities: [
      'code.read',
      'code.write',
      'pull_requests',
      'tests.run',
      'browser.e2e',
      'jira.update',
      'design.read',
    ],
    integrations: [...ENGINEERING_INTEGRATIONS, { key: 'figma', required: false }],
    defaults: { maxConcurrency: 2, maxOpenTasks: 6 },
  },
  {
    key: 'qa_engineer',
    name: 'QA engineer',
    summary: 'Writes and runs automated tests, reproduces bugs and reports findings on the ticket.',
    defaultTitle: 'QA Engineer',
    baseInstructions:
      'Reproduce reported bugs, write automated tests that cover them, and report results on the Jira ticket with clear steps and evidence.',
    capabilities: [
      'code.read',
      'code.write',
      'pull_requests',
      'tests.run',
      'browser.e2e',
      'jira.update',
    ],
    integrations: ENGINEERING_INTEGRATIONS,
    defaults: { maxConcurrency: 2, maxOpenTasks: 6 },
  },
];

export function findRoleTemplate(key: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((t) => t.key === key);
}
