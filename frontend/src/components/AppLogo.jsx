/**
 * Compact mark for the AI Translator. Two overlapping rounded squares
 * with an inner sound-wave glyph — meant to read as "two languages
 * meeting" plus "audio". Pure inline SVG, no asset bundling, scales
 * with the parent's font size when used inline.
 */
export default function AppLogo({ className = "h-9 w-9", ...rest }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 40 40"
      className={className}
      role="img"
      aria-label="AI Translator logo"
      {...rest}
    >
      <defs>
        <linearGradient id="ai-translator-grad" x1="0" x2="40" y1="0" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      {/* Outer rounded tile */}
      <rect x="2" y="2" width="36" height="36" rx="9" fill="url(#ai-translator-grad)" />
      {/* Sound-wave glyph */}
      <g
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 20 L14 20" />
        <path d="M11 16 L11 24" />
        <path d="M17 14 L17 26" opacity="0.9" />
        <path d="M23 12 L23 28" />
        <path d="M29 16 L29 24" opacity="0.9" />
      </g>
    </svg>
  );
}
