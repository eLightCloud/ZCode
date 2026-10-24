/** Existing native host capabilities; only named operations are public. */
export { compactDiscoveryMetadata, collectDiscoveredTools } from "./search/history.js";
export {
  createToolRuleNameSet,
  normalizeToolNameAlias,
  isToolNameDisallowed,
  filterDisallowedToolNames,
} from "./tool-visibility.js";
export {
  buildToolExposure,
  buildToolSearchAnnouncement,
  resolveToolSearchMode,
} from "./search/exposure.js";
export { orderProviderVisibleToolContracts } from "./provider-visible-order.js";
export { projectToolModelContract } from "./model-contract.js";
