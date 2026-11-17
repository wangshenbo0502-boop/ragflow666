const ArchivePages = [
  { x: 106, y: 96, start: 0.02 },
  { x: 82, y: 120, start: 0.08 },
  { x: 58, y: 144, start: 0.14 },
];

export function RailArchiveDiagram() {
  return (
    <div className="rail-archive-illustration" aria-hidden="true">
      <div className="rail-diagram rail-diagram-archive">
        <svg viewBox="0 0 520 600" fill="none" focusable="false">
          {ArchivePages.map(({ x, y, start }, index) => (
            <g key={x} transform={`translate(${x} ${y})`}>
              <path
                className="rail-diagram-wire rail-archive-paper"
                data-rail-trace
                data-trace-start={start}
                data-trace-end={start + 0.4}
                d="M0 10A10 10 0 0 1 10 0H184L230 46V278A10 10 0 0 1 220 288H10A10 10 0 0 1 0 278Z"
                pathLength="1"
              />
              {index === 2 && (
                <>
                  <path
                    className="rail-diagram-wire"
                    data-rail-trace
                    data-trace-start="0.22"
                    data-trace-end="0.58"
                    d="M184 0V36A10 10 0 0 0 194 46H230M32 122H182M32 146H170M32 170H148M32 216H102"
                    pathLength="1"
                  />
                  <path
                    className="rail-diagram-trace"
                    data-rail-trace
                    data-trace-start="0.25"
                    data-trace-end="0.64"
                    d="M32 64H114M32 80H86"
                    pathLength="1"
                  />
                  <g className="rail-diagram-trace">
                    <circle
                      data-rail-trace
                      data-trace-start="0.4"
                      data-trace-end="0.72"
                      cx="173"
                      cy="224"
                      r="24"
                      pathLength="1"
                    />
                    <path
                      data-rail-trace
                      data-trace-start="0.55"
                      data-trace-end="0.82"
                      d="M163 224L170 231L184 217"
                      pathLength="1"
                    />
                  </g>
                </>
              )}
            </g>
          ))}
          <path
            className="rail-diagram-wire"
            data-rail-trace
            data-trace-start="0.32"
            data-trace-end="0.78"
            d="M336 240H380V180H412M380 240V348H412M174 432V486H410"
            pathLength="1"
          />
          <path
            className="rail-diagram-trace"
            data-rail-trace
            data-trace-start="0.48"
            data-trace-end="0.9"
            d="M336 240H380V348H412"
            pathLength="1"
          />
          <g className="rail-diagram-trace">
            <circle
              data-rail-trace
              data-trace-start="0.54"
              data-trace-end="0.84"
              cx="424"
              cy="180"
              r="12"
              pathLength="1"
            />
            <circle
              data-rail-trace
              data-trace-start="0.6"
              data-trace-end="0.9"
              cx="424"
              cy="348"
              r="12"
              pathLength="1"
            />
            <circle
              data-rail-trace
              data-trace-start="0.66"
              data-trace-end="0.96"
              cx="424"
              cy="486"
              r="12"
              pathLength="1"
            />
          </g>
          <g className="rail-diagram-label rail-archive-label">
            <text x="424" y="219" textAnchor="middle">
              官方来源
            </text>
            <text x="424" y="387" textAnchor="middle">
              原文核验
            </text>
            <text x="424" y="525" textAnchor="middle">
              采集日期
            </text>
          </g>
          <path
            className="rail-diagram-trace rail-diagram-baseline"
            data-rail-trace
            data-trace-start="0.52"
            data-trace-end="1"
            d="M58 570H460"
            pathLength="1"
          />
        </svg>
      </div>
    </div>
  );
}
