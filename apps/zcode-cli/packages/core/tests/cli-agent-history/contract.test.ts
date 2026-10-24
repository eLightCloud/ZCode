import { expect, it } from "vitest";
import { createMessageHistory } from "../../src/agent/contract.js";
it("keeps defensive history copies separate from the runtime writer", () => {
  const history = createMessageHistory();
  history.init();
  history.addUser("owned fixture input");
  const copy = history.toRuntimeEntries();
  copy.splice(0);
  expect(history.getMessageCount()).toBe(1);
  expect(history.toRuntimeEntries()).toHaveLength(1);
});
