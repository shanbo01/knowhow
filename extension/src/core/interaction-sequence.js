export function createInteractionSequencer() {
  let received = 0;
  let latest = { sessionId: null, interactionSequence: 0 };

  return {
    reserve() {
      received += 1;
      return received;
    },

    confirm(sessionId, interactionSequence) {
      if (
        typeof sessionId !== "string" ||
        !sessionId ||
        !Number.isInteger(interactionSequence) ||
        interactionSequence < 1
      ) {
        throw new TypeError("A confirmed interaction needs a valid sequence.");
      }
      if (
        latest.sessionId !== sessionId ||
        interactionSequence > latest.interactionSequence
      ) {
        latest = { sessionId, interactionSequence };
      }
      return interactionSequence;
    },

    isLatest(request) {
      return (
        request?.sourceEvent !== "click" ||
        (latest.sessionId === request.sessionId &&
          latest.interactionSequence === request.interactionSequence)
      );
    },
  };
}
