const ServerSlots = [0, 1, 2, 3, 4, 5];
const BrowserLines = [0, 1, 2];

export function RailScrollDiagram({
  variant,
}: {
  variant: 'server' | 'browser';
}) {
  return (
    <div className={`rail-diagram rail-diagram-${variant}`} aria-hidden="true">
      {variant === 'server' ? (
        <svg viewBox="0 0 920 760" fill="none" focusable="false">
          <rect
            className="rail-diagram-wire"
            data-rail-trace
            data-trace-start="0"
            data-trace-end="0.38"
            x="305"
            y="90"
            width="380"
            height="572"
            rx="20"
            pathLength="1"
          />
          <path
            className="rail-diagram-trace"
            data-rail-trace
            data-trace-start="0.2"
            data-trace-end="0.6"
            d="M305 625H170V165H305"
            pathLength="1"
          />
          <path
            className="rail-diagram-wire"
            data-rail-trace
            data-trace-start="0.24"
            data-trace-end="0.64"
            d="M685 510H838V253H685"
            pathLength="1"
          />
          {ServerSlots.map((slot) => (
            <g
              key={slot}
              className="rail-diagram-slot"
              data-rail-slot
              transform={`translate(335 ${132 + slot * 87})`}
            >
              <rect
                className={
                  slot === 0 ? 'rail-diagram-trace' : 'rail-diagram-wire'
                }
                data-rail-trace
                data-trace-start={0.025 + slot * 0.025}
                data-trace-end={0.4 + slot * 0.025}
                width="320"
                height="65"
                rx="8"
                pathLength="1"
              />
              <circle
                className={
                  slot === 0 ? 'rail-diagram-trace' : 'rail-diagram-wire'
                }
                data-rail-trace
                data-trace-start={0.15 + slot * 0.025}
                data-trace-end={0.5 + slot * 0.025}
                cx="30"
                cy="32"
                r="4"
                pathLength="1"
              />
              <path
                className="rail-diagram-slot-detail"
                data-rail-trace
                data-trace-start={0.16 + slot * 0.025}
                data-trace-end={0.51 + slot * 0.025}
                d="M246 27V37M254 27V37M262 27V37M270 27V37M278 27V37"
                pathLength="1"
              />
            </g>
          ))}
          <g className="rail-diagram-lock">
            <path
              className="rail-diagram-lock-shackle"
              data-rail-trace
              data-trace-start="0.34"
              data-trace-end="0.7"
              d="M810 151V131C810 109 841 109 841 131V151"
              pathLength="1"
            />
            <rect
              data-rail-trace
              data-trace-start="0.28"
              data-trace-end="0.66"
              x="797"
              y="151"
              width="57"
              height="46"
              rx="7"
              pathLength="1"
            />
            <circle
              data-rail-trace
              data-trace-start="0.4"
              data-trace-end="0.7"
              cx="825.5"
              cy="171"
              r="3"
              pathLength="1"
            />
            <path
              data-rail-trace
              data-trace-start="0.4"
              data-trace-end="0.7"
              d="M825.5 174V181"
              pathLength="1"
            />
          </g>
          <g className="rail-diagram-label">
            <text x="170" y="684" textAnchor="middle">
              uplink
            </text>
            <text x="825" y="231" textAnchor="middle">
              encrypted
            </text>
          </g>
        </svg>
      ) : (
        <svg viewBox="0 0 920 640" fill="none" focusable="false">
          <g className="rail-diagram-wire" strokeWidth="1.5">
            <rect
              data-rail-trace
              data-trace-start="0"
              data-trace-end="0.38"
              x="55"
              y="74"
              width="810"
              height="476"
              rx="22"
              pathLength="1"
            />
            <path
              data-rail-trace
              data-trace-start="0.04"
              data-trace-end="0.42"
              d="M55 155H865"
              pathLength="1"
            />
            <circle
              data-rail-trace
              data-trace-start="0.08"
              data-trace-end="0.4"
              cx="106"
              cy="114"
              r="6"
              pathLength="1"
            />
            <circle
              data-rail-trace
              data-trace-start="0.1"
              data-trace-end="0.42"
              cx="139"
              cy="114"
              r="6"
              pathLength="1"
            />
            <circle
              data-rail-trace
              data-trace-start="0.12"
              data-trace-end="0.44"
              cx="172"
              cy="114"
              r="6"
              pathLength="1"
            />
          </g>
          {BrowserLines.map((line) => (
            <g key={line} className="rail-diagram-browser-line">
              <rect
                className="rail-diagram-wire"
                data-rail-trace
                data-trace-start={0.14 + line * 0.04}
                data-trace-end={0.5 + line * 0.04}
                x="112"
                y={222 + line * 57}
                width={[356, 548, 452][line]}
                height="24"
                rx="12"
                pathLength="1"
              />
            </g>
          ))}
          <rect
            className="rail-diagram-browser-button"
            data-rail-trace
            data-trace-start="0.28"
            data-trace-end="0.64"
            x="112"
            y="421"
            width="230"
            height="62"
            rx="31"
            pathLength="1"
          />
          <path
            className="rail-diagram-browser-arrow"
            data-rail-trace
            data-trace-start="0.38"
            data-trace-end="0.7"
            d="M204 452H249M241 444L249 452L241 460"
            pathLength="1"
          />
          <path
            className="rail-diagram-trace rail-diagram-baseline"
            data-rail-trace
            data-trace-start="0.25"
            data-trace-end="0.7"
            d="M55 604H865"
            pathLength="1"
          />
        </svg>
      )}
    </div>
  );
}
