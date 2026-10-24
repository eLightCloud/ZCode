import { inputEventHandlers } from "./event-reducer-input.js";
import { sessionEventHandlers } from "./event-reducer-session.js";
import { toolsEventHandlers } from "./event-reducer-tools.js";
// ============================================================
// Event Reducer - State projection from events
// ============================================================

import type { SessionProjection } from "../interfaces/session.port.js";
import { initialSessionProjection } from "./event-reducer-helpers.js";
import type { SessionEvent } from "./session-event-identity.js";

// -----------------------------------------------
// Event Reducer
// -----------------------------------------------

export class EventReducer {
  reduce(events: SessionEvent[]): SessionProjection {
    return events.reduce((projection, event) => this.apply(projection, event), {
      ...initialSessionProjection,
      id: events[0]?.sessionId ?? ("unknown" as any),
    } as SessionProjection);
  }

  apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
    const handler = this.handlers[event.type];
    if (handler) {
      return handler(projection, event);
    }
    return {
      ...projection,
      updatedAt: event.timestamp,
    };
  }

  private handlers = { ...sessionEventHandlers, ...inputEventHandlers, ...toolsEventHandlers };
}

// -----------------------------------------------
// Utility Functions
// -----------------------------------------------

export function reduce(events: SessionEvent[]): SessionProjection {
  return new EventReducer().reduce(events);
}

export function apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
  return new EventReducer().apply(projection, event);
}
