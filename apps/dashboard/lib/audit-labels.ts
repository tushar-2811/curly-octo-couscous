/**
 * Plain-language audit actions, written to follow the actor's name ("Ada linked the
 * Google account of Nova"). Unknown actions show their raw name.
 */
const ACTION_LABELS: Record<string, string> = {
  'auth.signed_in': 'signed in',
  'organization.created': 'registered',
  'organization.updated': 'changed the settings of',
  'org_unit.created': 'created',
  'org_unit.updated': 'changed',
  'org_unit.deleted': 'deleted',
  'member.added': 'added',
  'member.joined': 'joined',
  'member.updated': 'changed the profile of',
  'member.deactivated': 'deactivated',
  'member.reactivated': 'reactivated',
  'member.manager_changed': 'changed the manager of',
  'member.hired': 'hired',
  'member.company_email_set': 'set the company Google account of',
  'member.state_changed': 'changed the state of',
  'ai_profile.updated': 'changed the AI employee settings of',
  'identity.link_started': 'started linking the Google account of',
  'identity.linked': 'linked the Google account of',
  'identity.link_failed': 'failed to link the Google account of',
  'identity.disconnected': 'disconnected the Google account of',
  'grant.created': 'added an access rule (removed feature)',
  'grant.revoked': 'revoked an access rule (removed feature)',
  'resource.registered': 'registered a resource (removed feature)',
};

export const CATEGORY_LABELS: Record<string, string> = {
  auth: 'Sign-ins',
  organization: 'Organization',
  org_unit: 'Departments and teams',
  member: 'People and AI employees',
  ai_profile: 'AI employee settings',
  identity: 'Google accounts',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** "from → to" for state changes, which are the most common entries. */
export function actionSummary(action: string, details: Record<string, unknown>): string | null {
  if (action === 'member.state_changed' && typeof details.to === 'string') {
    return `${String(details.from ?? '?').replaceAll('_', ' ')} → ${details.to.replaceAll('_', ' ')}`;
  }
  if (action === 'identity.link_failed' && typeof details.code === 'string') {
    return details.code.replaceAll('_', ' ');
  }
  return null;
}
