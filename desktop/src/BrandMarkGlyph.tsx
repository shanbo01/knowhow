type BrandMarkGlyphProps = {
  size?: number;
};

// A local copy of the web app's canonical mark (app/components/brand-mark-glyph.tsx).
// Desktop is a fully separate npm/Vite project from the root Next app — no
// workspace linking — so the component is duplicated here rather than
// imported across that boundary. Keep this in sync with the web original if
// the mark ever changes there.
export function BrandMarkGlyph({ size = 18 }: BrandMarkGlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 5v14M6 12h5.1M11.1 12l5-6M11.1 12l6 7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
