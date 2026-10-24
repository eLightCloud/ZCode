import { createElement } from "react";
import { ConversationHistory } from "./contract.js";
export function exampleNativeHistory(props: Parameters<typeof ConversationHistory>[0]) {
  return createElement(ConversationHistory, props);
}
