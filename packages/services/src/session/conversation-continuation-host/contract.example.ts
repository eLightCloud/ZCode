import type { ConversationRuntimeHostOptions } from "./contract.js";
import { createConversationRuntimeHost } from "./index.js";

/** Native composition injects its existing Core, index writer and current model facade. */
export function prepareNativeRuntimeHost(options: ConversationRuntimeHostOptions) {
  return createConversationRuntimeHost(options);
}
