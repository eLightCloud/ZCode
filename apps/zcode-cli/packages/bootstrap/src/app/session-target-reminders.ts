export type GoalStateChangeReminderAction = "paused" | "resumed" | "cleared";

export function goalStateChangeReminderText(action: GoalStateChangeReminderAction): string;

export function goalStateChangeReminderText(action: undefined): undefined;

export function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined;

export function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined {
  switch (action) {
    case "paused":
      return "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.";
    case "resumed":
      return "The session goal is active again and will be pursued.";
    case "cleared":
      return "The session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.";
    default:
      return undefined;
  }
}
