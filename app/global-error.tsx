"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="opening-screen recovery-screen" role="alert">
          <span className="opening-mark">K</span>
          <h1>KnowHow needs a fresh start</h1>
          <p>The failure was recorded without customer content or credentials.</p>
          <button className="button primary" type="button" onClick={reset}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
