export type MediaLifecycleState =
  | "idle"
  | "queued"
  | "loading"
  | "ready"
  | "buffering"
  | "retrying"
  | "failed"
  | "unsupported";

export type MediaScope = "preview" | "playback" | "download";

export type MediaLifecycleAction = {
  scope: MediaScope;
  type:
    | "queued"
    | "load"
    | "ready"
    | "buffer"
    | "fail"
    | "unsupported"
    | "retry";
} | { type: "reset" };

export type MediaLifecycleMap = Record<MediaScope, MediaLifecycleState>;

const initialMediaLifecycleMap: MediaLifecycleMap = {
  preview: "idle",
  playback: "idle",
  download: "idle",
};

const stateRank: Record<MediaLifecycleState, number> = {
  idle: 0,
  ready: 1,
  queued: 2,
  loading: 3,
  buffering: 3,
  retrying: 4,
  failed: 4,
  unsupported: 4,
};

export function createMediaLifecycleMap(): MediaLifecycleMap {
  return { ...initialMediaLifecycleMap };
}

export function reduceMediaLifecycle(
  state: MediaLifecycleMap,
  action: MediaLifecycleAction,
): MediaLifecycleMap {
  if (action.type === "reset") {
    return createMediaLifecycleMap();
  }

  const current = state[action.scope];
  let next: MediaLifecycleState;

  switch (action.type) {
    case "queued":
      next = current === "ready" ? current : "queued";
      break;
    case "load":
    case "retry":
      next = "loading";
      break;
    case "ready":
      next = current === "unsupported" ? current : "ready";
      break;
    case "buffer":
      next = current === "loading" || current === "ready" ? "buffering" : current;
      break;
    case "fail":
      next = "failed";
      break;
    case "unsupported":
      next = "unsupported";
      break;
    default:
      next = current;
  }

  return { ...state, [action.scope]: next };
}

export function selectActiveMediaState(
  entries: ReadonlyArray<{ scope: MediaScope; state: MediaLifecycleState }>,
): { scope: MediaScope; state: MediaLifecycleState } {
  return entries.reduce((active, entry) =>
    stateRank[entry.state] > stateRank[active.state] ? entry : active,
  );
}

export function isFailureMediaState(state: MediaLifecycleState): boolean {
  return state === "retrying" || state === "failed" || state === "unsupported";
}
