export function RailBrand() {
  return (
    <span className="rail-brand">
      <svg
        className="rail-logo"
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <path
          fill="currentColor"
          d="M2 25h4.5l17-17H19L2 25Zm7.5 0H14L31 8h-4.5l-17 17Z"
        />
        <path
          fill="var(--rail-mark-accent)"
          d="M17 24h9.5l3.5-3.5h-9.5L17 24Z"
        />
      </svg>
      <span className="rail-wordmark">
        轨知 <span>RailMind</span>
      </span>
    </span>
  );
}
