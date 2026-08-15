(() => {
  "use strict";

  const QUIET_MS = 500;
  const TIMEOUT_MS = 10_000;

  function isKnowHowNode(node) {
    if (!(node instanceof Node)) return false;
    const element =
      node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(
      element?.closest?.("[data-knowhow-ui],[data-knowhow-overlay]"),
    );
  }

  function mutationIsPageWork(records) {
    for (const record of records) {
      if (isKnowHowNode(record.target)) continue;
      if (
        [...record.addedNodes, ...record.removedNodes].some(
          (node) => !isKnowHowNode(node),
        )
      ) {
        return true;
      }
      if (
        record.type === "characterData" &&
        !isKnowHowNode(record.target)
      ) {
        return true;
      }
      if (
        record.type === "attributes" &&
        !isKnowHowNode(record.target)
      ) {
        return true;
      }
    }
    return false;
  }

  function waitForDocumentComplete(timeoutMs = TIMEOUT_MS) {
    if (document.readyState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        removeEventListener("load", finish);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      addEventListener("load", finish, { once: true });
    });
  }

  function waitForQuietWindow({
    quietMs = QUIET_MS,
    timeoutMs = TIMEOUT_MS,
  } = {}) {
    return new Promise((resolve) => {
      let finished = false;
      let quietTimer = null;
      let observer = null;
      let performanceObserver = null;

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(quietTimer);
        observer?.disconnect();
        performanceObserver?.disconnect();
        resolve();
      };

      const bump = () => {
        if (finished) return;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, Math.max(0, quietMs));
      };

      observer = new MutationObserver((records) => {
        if (mutationIsPageWork(records)) bump();
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });

      try {
        performanceObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (
              entry.initiatorType === "fetch" ||
              entry.initiatorType === "xmlhttprequest"
            ) {
              bump();
              break;
            }
          }
        });
        performanceObserver.observe({ type: "resource" });
      } catch {
        performanceObserver = null;
      }

      bump();
      setTimeout(finish, Math.max(quietMs, timeoutMs));
    });
  }

  function waitForPageSettled({
    quietMs = QUIET_MS,
    timeoutMs = TIMEOUT_MS,
  } = {}) {
    const startedAt = Date.now();
    return waitForDocumentComplete(timeoutMs).then(() => {
      const remaining = Math.max(
        quietMs,
        timeoutMs - (Date.now() - startedAt),
      );
      return waitForQuietWindow({ quietMs, timeoutMs: remaining });
    });
  }

  globalThis.__KNOWHOW_PAGE_SETTLED__ = Object.freeze({
    waitForPageSettled,
    quietMs: QUIET_MS,
    timeoutMs: TIMEOUT_MS,
  });
})();
