type BrandMarkGlyphProps = {
  size?: number;
};

/** The canonical KnowHow mark used by the landing page and product UI. */
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
