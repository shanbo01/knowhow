"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main className="opening-screen recovery-screen" role="alert">
          <span className="opening-mark">K</span>
          <h1>KnowHow needs a fresh start</h1>
          <p>Reload the workspace to continue.</p>
          <button className="button primary" type="button" onClick={reset}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
