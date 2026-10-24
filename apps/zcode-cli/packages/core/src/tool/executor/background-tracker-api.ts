import type { BackgroundTaskTrackerContext } from "./background-tracker-context.js";
/** Single background lifecycle capability; shape does not depend on its polling implementation. */
export type BackgroundTaskTrackerApi = Pick<BackgroundTaskTrackerContext, "trackBackgroundTask">;
