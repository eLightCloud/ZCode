// Electron adapter only; native session owns claims, retry, recovery and sampling.
import { startAutomationScheduler, type MainToSchedulerMessage } from "@zcode/services/node";
const scheduler = startAutomationScheduler({
  postMessage: (message) => process.parentPort?.postMessage(message),
});
process.parentPort?.on("message", (event: Electron.MessageEvent) => {
  const message = event.data as MainToSchedulerMessage;
  if (message?.type === "scheduler-dispose") {
    void scheduler.dispose().then(() => process.exit(0));
  } else {
    scheduler.acceptMessage(message);
  }
});
void scheduler.ready.catch((error) => {
  process.parentPort?.postMessage({
    type: "scheduler-log",
    level: "error",
    message: `scheduler bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
  });
  process.exit(1);
});
