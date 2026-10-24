import { sanitizeHookDisplayText } from "./contract.js";
export function exampleSafeHookDisplay(command: string) {
  return sanitizeHookDisplayText(command);
}
