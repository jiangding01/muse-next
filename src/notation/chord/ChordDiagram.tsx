import type { GuitarChord } from '../../domain/music';

interface ChordDiagramProps {
  chord: GuitarChord;
  width?: number;
}

const STRING_COUNT = 6;
const FRET_COUNT = 5;

export function ChordDiagram({ chord, width = 124 }: ChordDiagramProps) {
  const height = Math.round(width * 1.15);
  const left = 18;
  const top = 34;
  const gridWidth = width - 34;
  const gridHeight = height - 54;
  const stringGap = gridWidth / (STRING_COUNT - 1);
  const fretGap = gridHeight / FRET_COUNT;

  return (
    <svg
      className="chord-diagram"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${chord.name} guitar chord`}
    >
      <text x={width / 2} y={15} textAnchor="middle" className="chord-name">
        {chord.name}
      </text>

      {chord.baseFret > 1 && (
        <text x={2} y={top + fretGap * 0.72} className="base-fret-label">
          {chord.baseFret}fr
        </text>
      )}

      {Array.from({ length: STRING_COUNT }, (_, index) => {
        const x = left + index * stringGap;
        return (
          <line key={`string-${index}`} x1={x} y1={top} x2={x} y2={top + gridHeight} />
        );
      })}

      {Array.from({ length: FRET_COUNT + 1 }, (_, index) => {
        const y = top + index * fretGap;
        return (
          <line
            key={`fret-${index}`}
            x1={left}
            y1={y}
            x2={left + gridWidth}
            y2={y}
            className={index === 0 && chord.baseFret === 1 ? 'nut-line' : undefined}
          />
        );
      })}

      {chord.strings.map((string) => {
        const x = left + string.stringIndex * stringGap;

        if (string.state === 'muted') {
          return (
            <text key={string.stringIndex} x={x} y={top - 8} textAnchor="middle" className="string-state">
              ×
            </text>
          );
        }

        if (string.state === 'open') {
          return (
            <circle
              key={string.stringIndex}
              cx={x}
              cy={top - 11}
              r={4}
              className="open-string"
            />
          );
        }

        const absoluteFret = string.fret ?? chord.baseFret;
        const visibleFret = absoluteFret - chord.baseFret + 1;
        const y = top + (Math.max(1, visibleFret) - 0.5) * fretGap;

        return (
          <g key={string.stringIndex}>
            <circle cx={x} cy={y} r={7} className="finger-dot" />
            {string.finger && (
              <text x={x} y={y + 3.5} textAnchor="middle" className="finger-number">
                {string.finger}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
