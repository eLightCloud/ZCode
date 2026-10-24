import {
  ConversationSyncError,
  type SyncCommand,
  type SyncState,
  type SyncVersion,
} from "@zcode/contracts";
import { digest } from "./canonical.js";

export interface VersionFacts {
  id: string;
  parent: string | null;
  location: string;
  generation: number;
  checkpointDigest: string | null;
}
export function versionFacts(value: SyncVersion): VersionFacts {
  return {
    id: value.id,
    parent: value.parent,
    location: value.location,
    generation: value.generation,
    checkpointDigest: value.checkpoint === null ? null : digest(value.checkpoint),
  };
}

export function initialState(): SyncState {
  return {
    revision: 0,
    selection: 0,
    generation: 0,
    selected: null,
    candidates: [],
    resolved: [],
    active: null,
    pending: null,
    handoff: null,
  };
}
export function ancestor(versions: Map<string, VersionFacts>, base: string, tip: string): boolean {
  let current: string | null = tip;
  const visited = new Set<string>();
  while (current !== null && !visited.has(current)) {
    if (current === base) return true;
    visited.add(current);
    current = versions.get(current)?.parent ?? null;
  }
  return false;
}
function requireRule(
  ok: unknown,
  code: ConstructorParameters<typeof ConversationSyncError>[0] = "blocked",
): asserts ok {
  if (!ok) throw new ConversationSyncError(code);
}
function versionOf(versions: Map<string, VersionFacts>, id: string): VersionFacts {
  const version = versions.get(id);
  requireRule(version, "not_found");
  return version;
}
function nextBinding(state: SyncState, location: string, version: string) {
  state.generation += 1;
  state.pending = { location, generation: state.generation, version };
  state.active = null;
}
/** Pure native storage transitions. Runtime evidence is supplied by trusted assembly. */
export function transition(
  previous: SyncState,
  command: SyncCommand,
  versions: Map<string, VersionFacts>,
): SyncState {
  const state = structuredClone(previous);
  if ("revision" in command) requireRule(command.revision === state.revision, "stale");
  switch (command.kind) {
    case "receive": {
      const value = command.version;
      requireRule(!versions.has(value.id), "conflict");
      if (value.parent !== null) versionOf(versions, value.parent);
      versions.set(value.id, versionFacts(value));
      if (!state.candidates.some((id) => ancestor(versions, value.id, id))) {
        // 普通删除必须由显式选择关闭；其后的编辑不能通过祖先压缩把删除候选抹掉。
        state.candidates = state.candidates.filter(
          (id) =>
            !ancestor(versions, id, value.id) ||
            (value.checkpoint !== null && versions.get(id)?.checkpointDigest === null),
        );
        state.candidates.push(value.id);
      }
      break;
    }
    case "promote": {
      const value = versionOf(versions, command.version);
      requireRule(value.checkpointDigest !== null);
      if (state.selected)
        requireRule(versionOf(versions, state.selected).checkpointDigest !== null, "conflict");
      requireRule(state.handoff?.phase !== "requested" && state.handoff?.phase !== "granted");
      requireRule(!state.selected || ancestor(versions, state.selected, value.id), "conflict");
      requireRule(
        state.candidates.every((id) => ancestor(versions, id, value.id)),
        "conflict",
      );
      requireRule(!state.active || state.active.location === command.location);
      state.selected = value.id;
      state.selection += 1;
      nextBinding(state, command.location, value.id);
      break;
    }
    case "select": {
      const seen = [...new Set(command.candidates)].sort();
      requireRule(JSON.stringify(seen) === JSON.stringify([...state.candidates].sort()), "stale");
      requireRule(state.candidates.includes(command.version), "stale");
      requireRule(state.handoff?.phase !== "requested" && state.handoff?.phase !== "granted");
      const value = versionOf(versions, command.version);
      // 未关闭旧位置前，选择不能隐式撤销其已经接纳的工作。
      requireRule(state.active === null && state.pending === null);
      if (value.checkpointDigest !== null)
        requireRule(command.recoveryVerified && command.location !== null);
      else requireRule(command.location === null);
      state.resolved = [
        ...new Set([...state.resolved, ...state.candidates.filter((id) => id !== value.id)]),
      ];
      state.candidates = [value.id];
      state.selected = value.id;
      state.selection += 1;
      state.active = null;
      state.pending = null;
      if (value.checkpointDigest !== null && command.location)
        nextBinding(state, command.location, value.id);
      else state.generation += 1;
      break;
    }
    case "begin": {
      requireRule(state.handoff?.id !== command.handoff, "conflict");
      requireRule(
        state.active &&
          state.active.location === command.source &&
          state.active.generation === command.generation &&
          state.active.version === command.baseline,
        "stale",
      );
      requireRule(
        state.selected === command.baseline && command.source !== command.target,
        "stale",
      );
      requireRule(state.handoff?.phase !== "requested" && state.handoff?.phase !== "granted");
      state.handoff = {
        id: command.handoff,
        source: command.source,
        target: command.target,
        generation: command.generation,
        baseline: command.baseline,
        checkpoint: null,
        selection: state.selection,
        phase: "requested",
      };
      break;
    }
    case "grant": {
      const h = state.handoff;
      requireRule(h && h.id === command.handoff && h.phase === "requested", "stale");
      requireRule(h.selection === state.selection && state.selected === h.baseline, "stale");
      const value = versionOf(versions, command.checkpoint);
      requireRule(
        value.checkpointDigest !== null &&
          (value.id === h.baseline ||
            (value.location === h.source && value.generation === h.generation)),
      );
      requireRule(ancestor(versions, h.baseline, value.id), "stale");
      requireRule(
        state.candidates.every((id) => ancestor(versions, id, value.id)),
        "conflict",
      );
      // C 的每一步都必须来自同一源与同一屏障代次，不能把外部分支夹进收口结果。
      let cursor: string | null = value.id;
      while (cursor !== h.baseline) {
        const item = versionOf(versions, cursor!);
        requireRule(item.location === h.source && item.generation === h.generation);
        cursor = item.parent;
        requireRule(cursor !== null, "stale");
      }
      h.phase = "granted";
      h.checkpoint = value.id;
      state.selected = value.id;
      state.selection += 1;
      nextBinding(state, h.target, value.id);
      break;
    }
    case "cancel": {
      const h = state.handoff;
      requireRule(h && h.id === command.handoff, "stale");
      requireRule(h.phase !== "granted" && h.phase !== "activated", "forward_only");
      requireRule(h.phase === "requested", "stale");
      h.phase = "cancelled";
      requireRule(state.active && state.selected === h.baseline, "stale");
      state.generation += 1;
      state.active.generation = state.generation;
      break;
    }
    case "fence": {
      const owner = state.active ?? state.pending;
      requireRule(
        owner && owner.location === command.location && owner.generation === command.generation,
        "stale",
      );
      requireRule(state.handoff?.phase !== "requested" && state.handoff?.phase !== "granted");
      state.active = null;
      state.pending = null;
      state.generation += 1;
      break;
    }
    case "activate": {
      const pending = state.pending;
      requireRule(
        pending &&
          pending.location === command.location &&
          pending.generation === command.generation &&
          pending.version === command.version &&
          state.selected === command.version,
        "stale",
      );
      state.active = pending;
      state.pending = null;
      if (state.handoff?.phase === "granted") state.handoff.phase = "activated";
      break;
    }
  }
  state.revision += 1;
  return state;
}
