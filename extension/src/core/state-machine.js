export const CaptureStatus = Object.freeze({
  IDLE: "idle",
  PREPARING: "preparing",
  RECORDING: "recording",
  PAUSED: "paused",
  REVIEWING: "reviewing",
  UPLOADING: "uploading",
  COMPLETED: "completed",
  ERROR: "error",
});

export const CaptureEvent = Object.freeze({
  START: "START",
  READY: "READY",
  PAUSE: "PAUSE",
  RESUME: "RESUME",
  FINISH: "FINISH",
  BEGIN_UPLOAD: "BEGIN_UPLOAD",
  COMPLETE: "COMPLETE",
  FAIL: "FAIL",
  DISCARD: "DISCARD",
  RESET: "RESET",
});

export class CaptureTransitionError extends Error {
  constructor(status, event) {
    super("Cannot apply " + event + " while capture is " + status + ".");
    this.name = "CaptureTransitionError";
    this.status = status;
    this.event = event;
  }
}

export function createIdleState(now = Date.now()) {
  return {
    status: CaptureStatus.IDLE,
    generation: 0,
    stepCount: 0,
    updatedAt: new Date(now).toISOString(),
  };
}

function timestamp(now) {
  return new Date(now).toISOString();
}

function bump(state, now) {
  return {
    ...state,
    generation: state.generation + 1,
    updatedAt: timestamp(now),
  };
}

function requireSessionPayload(payload) {
  if (
    !payload ||
    typeof payload.sessionId !== "string" ||
    !payload.sessionId ||
    !Number.isInteger(payload.tabId) ||
    !Number.isInteger(payload.windowId) ||
    typeof payload.origin !== "string" ||
    !payload.origin
  ) {
    throw new TypeError("START requires a session, tab, window, and origin.");
  }
}

export function transitionCapture(
  state,
  event,
  payload = {},
  now = Date.now(),
) {
  const current = state ?? createIdleState(now);

  switch (event) {
    case CaptureEvent.START: {
      if (
        current.status !== CaptureStatus.IDLE &&
        current.status !== CaptureStatus.COMPLETED &&
        current.status !== CaptureStatus.ERROR
      ) {
        throw new CaptureTransitionError(current.status, event);
      }
      requireSessionPayload(payload);
      return {
        status: CaptureStatus.PREPARING,
        generation: current.generation + 1,
        sessionId: payload.sessionId,
        tabId: payload.tabId,
        windowId: payload.windowId,
        origin: payload.origin,
        sanitizedUrl: payload.sanitizedUrl,
        faviconUrl: payload.faviconUrl || null,
        title: payload.title || "Untitled captured guide",
        workspaceId: payload.workspaceId || null,
        scopeLabel: payload.scopeLabel || "Current tab",
        policyVersion: payload.policyVersion || "local-v1",
        acceptingEvents: false,
        nextEventSequence: 0,
        nextNavigationSequence: 0,
        captureEntries: [],
        preparedFrames: [],
        navigationKeys: [],
        activeDocumentId: null,
        activeNavigationKey: payload.sanitizedUrl || null,
        tabDocumentSessions: {},
        pendingNavigationTargets: [],
        manualBlurCount: 0,
        diagnostics: {
          accepted: 0,
          ready: 0,
          failed: 0,
          cancelled: 0,
          deduplicated: 0,
          prepared: 0,
        },
        stepCount: 0,
        stepIds: [],
        startedAt: timestamp(now),
        updatedAt: timestamp(now),
        pausedReason: null,
        lastError: null,
      };
    }

    case CaptureEvent.READY:
      if (current.status !== CaptureStatus.PREPARING) {
        throw new CaptureTransitionError(current.status, event);
      }
      return {
        ...bump(current, now),
        status: CaptureStatus.RECORDING,
        acceptingEvents: true,
        readyAt: timestamp(now),
        pausedReason: null,
        lastError: null,
      };

    case CaptureEvent.PAUSE:
      if (current.status !== CaptureStatus.RECORDING) {
        throw new CaptureTransitionError(current.status, event);
      }
      return {
        ...bump(current, now),
        status: CaptureStatus.PAUSED,
        acceptingEvents: false,
        pausedReason: payload.reason || "Paused by user",
      };

    case CaptureEvent.RESUME:
      if (current.status !== CaptureStatus.PAUSED) {
        throw new CaptureTransitionError(current.status, event);
      }
      return {
        ...bump(current, now),
        status: CaptureStatus.RECORDING,
        acceptingEvents: true,
        windowId: Number.isInteger(payload.windowId)
          ? payload.windowId
          : current.windowId,
        origin: payload.origin || current.origin,
        sanitizedUrl: payload.sanitizedUrl || current.sanitizedUrl,
        pausedReason: null,
        lastError: null,
      };

    case CaptureEvent.FINISH:
      if (
        current.status !== CaptureStatus.RECORDING &&
        current.status !== CaptureStatus.PAUSED
      ) {
        throw new CaptureTransitionError(current.status, event);
      }
      return {
        ...bump(current, now),
        status: CaptureStatus.REVIEWING,
        acceptingEvents: false,
        finishedAt: timestamp(now),
        pausedReason: null,
      };

    case CaptureEvent.BEGIN_UPLOAD:
      if (current.status !== CaptureStatus.REVIEWING) {
        throw new CaptureTransitionError(current.status, event);
      }
      return {
        ...bump(current, now),
        status: CaptureStatus.UPLOADING,
        uploadStartedAt: timestamp(now),
      };

    case CaptureEvent.COMPLETE:
      if (current.status !== CaptureStatus.UPLOADING) {
        throw new CaptureTransitionError(current.status, event);
      }
      return {
        ...bump(current, now),
        status: CaptureStatus.COMPLETED,
        completedAt: timestamp(now),
        guideId: payload.guideId || null,
        editUrl: payload.editUrl || null,
      };

    case CaptureEvent.FAIL:
      if (current.status === CaptureStatus.IDLE) {
        throw new CaptureTransitionError(current.status, event);
      }
      return {
        ...bump(current, now),
        status: CaptureStatus.ERROR,
        lastError: payload.message || "Capture failed.",
      };

    case CaptureEvent.DISCARD:
      if (current.status === CaptureStatus.IDLE) {
        return current;
      }
      return {
        ...createIdleState(now),
        generation: current.generation + 1,
        discardedSessionId: current.sessionId || null,
      };

    case CaptureEvent.RESET:
      if (
        current.status !== CaptureStatus.COMPLETED &&
        current.status !== CaptureStatus.ERROR
      ) {
        throw new CaptureTransitionError(current.status, event);
      }
      return {
        ...createIdleState(now),
        generation: current.generation + 1,
      };

    default:
      throw new TypeError("Unknown capture event: " + event);
  }
}

export function isCollecting(state) {
  return state?.status === CaptureStatus.RECORDING;
}

export function jobIsCurrent(state, sessionId, generation) {
  return Boolean(
    state &&
      state.status === CaptureStatus.RECORDING &&
      state.sessionId === sessionId &&
      state.generation === generation,
  );
}

export function snapshotCaptureJob(state, payload = {}) {
  if (!isCollecting(state) || !state.sessionId) {
    throw new CaptureTransitionError(
      state?.status || CaptureStatus.IDLE,
      "QUEUE_SCREENSHOT",
    );
  }
  return {
    ...payload,
    sessionId: state.sessionId,
    generation: state.generation,
  };
}

export function createWindowActivationEpochs() {
  const epochs = new Map();
  return {
    current(windowId) {
      return Number.isInteger(windowId) ? epochs.get(windowId) || 0 : 0;
    },
    note(windowId) {
      if (!Number.isInteger(windowId)) return 0;
      const next = (epochs.get(windowId) || 0) + 1;
      epochs.set(windowId, next);
      return next;
    },
  };
}
