import { createMessageHistory } from "./contract.js";
export function exampleHistory() {
  const history = createMessageHistory();
  history.init();
  history.addUser("owned fixture input");
  return history.toRuntimeEntries();
}
