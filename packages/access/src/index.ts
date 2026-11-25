/**
 * Access module (Technical architecture §2, §11): the resource registry, grants and the
 * authorize() check. Connections and credentials arrive with Phase 2 integrations.
 */
export { AccessError, type AccessErrorCode } from './errors';
export {
  ACTIONS,
  branchMatches,
  INTEGRATION_RESOURCE,
  isAction,
  LEVEL_RANK,
  RESOURCE_TYPE_INFO,
  RESOURCE_TYPES,
  type ActionKey,
} from './catalog';
export {
  effectiveAccess,
  evaluate,
  grantCovers,
  NO_ACCESS_STATES,
  type Decision,
  type DenyReason,
  type EffectiveAccess,
} from './evaluate';
export {
  archiveResource,
  getResource,
  listResources,
  registerResource,
  requireRegistryAdmin,
  updateResource,
  type RegisterResourceInput,
  type ResourcePatch,
  type ResourceRow,
} from './resources';
export {
  authorize,
  canManageGrants,
  createGrant,
  effectivePermissions,
  grantsCheck,
  listGrants,
  revokeAllGrants,
  revokeGrant,
  updateGrant,
  type EffectiveRow,
  type GrantInput,
  type GrantPatch,
  type GrantRow,
} from './grants';
