import type { InternalTurnAdmissionMethods } from "./internal-turn-admission-methods.js";
import type { InternalTurnCompactMethods } from "./internal-turn-compact-methods.js";
import type { InternalTurnPersistenceMethods } from "./internal-turn-persistence-methods.js";
import type { InternalTurnRewindMethods } from "./internal-turn-rewind-methods.js";
import type { InternalTurnToolMethods } from "./internal-turn-tool-methods.js";

export interface AgentRuntimeTurnMethods
  extends
    InternalTurnAdmissionMethods,
    InternalTurnRewindMethods,
    InternalTurnCompactMethods,
    InternalTurnToolMethods,
    InternalTurnPersistenceMethods {}
