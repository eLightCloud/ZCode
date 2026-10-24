import { conversationContinuationIntentSchema } from "./contract.js";
export function exampleNativeContinuationIntent(input: unknown) {
  return conversationContinuationIntentSchema.parse(input);
}
