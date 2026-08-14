import {
  CheckCircle2,
  FileCheck2,
  MoreHorizontal,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import styles from "../marketing.module.css";

export function ProductPreview() {
  return (
    <div
      className={styles.productPreview}
      role="img"
      aria-label="KnowHow guide workspace showing a published employee onboarding guide, three process steps, audience controls, and guide health"
    >
      <div className={styles.windowBar}>
        <div className={styles.windowDots} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className={styles.windowTitle}>Operations workspace</span>
        <span className={styles.windowState}>Secure session</span>
      </div>

      <div className={styles.previewShell}>
        <aside className={styles.previewRail} aria-hidden="true">
          <span className={styles.previewMark}>
            <Sparkles />
          </span>
          <span className={styles.railItemActive}>
            <FileCheck2 />
          </span>
          <span>
            <Users />
          </span>
          <span>
            <ShieldCheck />
          </span>
        </aside>

        <div className={styles.previewWorkspace}>
          <div className={styles.previewTopbar}>
            <div>
              <small>Guides</small>
              <strong>Employee onboarding</strong>
            </div>
            <div className={styles.previewSearch}>
              <Search aria-hidden="true" />
              <span>Search workspace</span>
            </div>
            <span className={styles.previewAvatar}>YS</span>
          </div>

          <div className={styles.previewContent}>
            <div className={styles.guideHeader}>
              <div>
                <span className={styles.publishedBadge}>
                  <span aria-hidden="true" /> Published
                </span>
                <h2>Prepare a new starter</h2>
                <p>People operations · Updated today</p>
              </div>
              <span className={styles.guideMenu} aria-hidden="true">
                <MoreHorizontal />
              </span>
            </div>

            <div className={styles.previewGrid}>
              <ol className={styles.stepList}>
                <li>
                  <span className={styles.stepNumber}>1</span>
                  <div>
                    <strong>Open the identity console</strong>
                    <small>Use the approved administrator profile.</small>
                  </div>
                  <CheckCircle2 aria-hidden="true" />
                </li>
                <li className={styles.activeStep}>
                  <span className={styles.stepNumber}>2</span>
                  <div>
                    <strong>Create the employee record</strong>
                    <small>Complete the highlighted required fields.</small>
                  </div>
                  <span className={styles.stepFocus}>Current</span>
                </li>
                <li>
                  <span className={styles.stepNumber}>3</span>
                  <div>
                    <strong>Confirm access groups</strong>
                    <small>Review the standard assignment set.</small>
                  </div>
                </li>
              </ol>

              <aside className={styles.healthCard}>
                <div className={styles.healthHeading}>
                  <span>Guide health</span>
                  <strong>92%</strong>
                </div>
                <div className={styles.healthBar}>
                  <span />
                </div>
                <dl>
                  <div>
                    <dt>Audience</dt>
                    <dd>People ops</dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>Yara S.</dd>
                  </div>
                  <div>
                    <dt>Review</dt>
                    <dd>In 28 days</dd>
                  </div>
                </dl>
                <div className={styles.completionNote}>
                  <CheckCircle2 aria-hidden="true" />
                  <span>
                    <strong>12 teammates</strong> completed this guide
                  </span>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
