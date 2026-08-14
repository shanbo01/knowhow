import Link from "next/link";
import { Download } from "lucide-react";
import { extensionStoreUrls } from "../../lib/extension-bridge";
import { EXTENSION_PACKAGE_PATH } from "../../lib/extension-package-path";

export function ExtensionInstallInstructions({
  actionClassName,
  showPageLink = false,
}: {
  actionClassName: string;
  showPageLink?: boolean;
}) {
  const { chrome, edge } = extensionStoreUrls();
  if (chrome || edge) {
    return (
      <div className="extension-install-actions">
        {chrome ? (
          <a
            className={actionClassName}
            href={chrome}
            target="_blank"
            rel="noreferrer"
          >
            <Download /> Install for Chrome
          </a>
        ) : null}
        {edge ? (
          <a
            className={actionClassName}
            href={edge}
            target="_blank"
            rel="noreferrer"
          >
            <Download /> Install for Edge
          </a>
        ) : null}
        {showPageLink ? <Link href="/extension">Install instructions</Link> : null}
      </div>
    );
  }

  return (
    <div className="extension-unpacked">
      <p>
        Download KnowHow Capture, unzip it, then load the folder in Chrome or
        Edge.
      </p>
      <div className="extension-install-actions">
        <a
          className={actionClassName}
          href={EXTENSION_PACKAGE_PATH}
          download="knowhow-capture.zip"
        >
          <Download /> Download KnowHow Capture
        </a>
      </div>
      <ol>
        <li>Unzip the downloaded file.</li>
        <li>
          Open <code>chrome://extensions</code> or{" "}
          <code>edge://extensions</code>.
        </li>
        <li>
          Turn on Developer mode, choose Load unpacked, and select the unzipped
          folder.
        </li>
      </ol>
      {showPageLink ? <Link href="/extension">Install instructions</Link> : null}
    </div>
  );
}
