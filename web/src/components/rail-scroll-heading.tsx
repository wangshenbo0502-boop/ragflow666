export function RailScrollHeading({ lines }: { lines: string[] }) {
  return (
    <h2 className="rail-statement" aria-label={lines.join('')}>
      {lines.map((line) => (
        <span className="rail-statement-line" key={line} aria-hidden>
          {Array.from(line).map((character, index) => (
            <span data-rail-word key={`${character}-${index}`}>
              {character}
            </span>
          ))}
        </span>
      ))}
    </h2>
  );
}
