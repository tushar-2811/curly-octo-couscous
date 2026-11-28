export { WorkforceError, type WorkforceErrorCode } from './errors';
export { requireAdmin } from './guards';
export {
  createOrgUnit,
  deleteOrgUnit,
  getOrgUnit,
  listOrgUnits,
  MAX_UNIT_DEPTH,
  updateOrgUnit,
  type OrgUnitWithCounts,
} from './org-units';
export {
  getMember,
  getOrganization,
  normalizeDomain,
  registerOrganization,
  slugify,
  updateOrganization,
  validateOrgDomain,
  type RegisterOrganizationInput,
} from './organizations';
export {
  addPerson,
  directReports,
  getMemberRow,
  listMembers,
  setLineManager,
  updateMember,
  type MemberFilter,
  type MemberRow,
} from './people';
export {
  getEmployee,
  hireEmployee,
  listEmployees,
  onboardingChecklist,
  resumeEmployee,
  setCompanyEmail,
  suspendEmployee,
  terminateEmployee,
  updateEmployee,
  type CheckStatus,
  type EmployeePatch,
  type EmployeeRow,
  type HireInput,
  type OnboardingCheck,
} from './employees';
export { AI_TRANSITIONS, canTransition, ONBOARDING_STATES, transition } from './lifecycle';
export {
  findRoleTemplate,
  INTEGRATION_LABELS,
  ROLE_TEMPLATES,
  type IntegrationKey,
  type RoleTemplate,
} from './role-templates';
export {
  checkLinkedIdentity,
  checkLinkRequester,
  consumeLinkRequest,
  continueOnboarding,
  createLinkRequest,
  disconnectIdentity,
  GOOGLE_PROVIDER,
  CHAT_SCOPES,
  GMAIL_SCOPES,
  IDENTITY_SCOPES,
  IdentityLinkError,
  LINK_ERROR_MESSAGES,
  LINK_REQUEST_TTL_MS,
  listIdentities,
  missingScopes,
  recordLinkFailure,
  saveLinkedIdentity,
  type LinkErrorCode,
  type LinkRequestInput,
  type VerifiedGoogleIdentity,
} from './identities';
