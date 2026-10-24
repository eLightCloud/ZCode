import { captureConversationIndexFacts } from "./contract.js";
export function exampleIndexCapture<T>(
  options: Parameters<typeof captureConversationIndexFacts<T>>[0],
) {
  return captureConversationIndexFacts(options);
}
