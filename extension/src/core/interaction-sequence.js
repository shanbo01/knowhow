export function createInteractionSequencer() {
  let received = 0;
  const confirmed = new Map();

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
      const sequences = confirmed.get(sessionId) || new Set();
      sequences.add(interactionSequence);
      confirmed.set(sessionId, sequences);
      return interactionSequence;
    },

    isLatest(request) {
      if (request?.sourceEvent !== "click") return true;
      return Boolean(
        confirmed
          .get(request.sessionId)
          ?.has(request.interactionSequence),
      );
    },
  };
}
