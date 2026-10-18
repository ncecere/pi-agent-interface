import type { CSSProperties, ReactNode } from 'react';
import { cn } from '~/lib/utils';
import './avatar.css';
import './face.css';
import type { AvatarState } from './states';

export type AvatarStyle = 'face' | 'orb' | 'pi' | 'bars' | 'dots';

export const AVATAR_STYLES: { id: AvatarStyle; name: string; blurb: string }[] = [
  {
    id: 'face',
    name: 'Face',
    blurb: "pi-d-ui's face, ported as it is: a character with a routine of its own.",
  },
  {
    id: 'orb',
    name: 'Orb',
    blurb: 'A glass sphere whose bright core looks around. Calm; reads from across the room.',
  },
  {
    id: 'pi',
    name: 'Pi',
    blurb: 'The π mark as a little character: its bar and legs act out what the agent is doing.',
  },
  {
    id: 'bars',
    name: 'Signal',
    blurb: 'A level meter. Precise and technical; the clearest at tiny sizes.',
  },
  {
    id: 'dots',
    name: 'Pixel',
    blurb: 'A round dot matrix, a nod to the terminal. Crisp, playful, cheap to draw.',
  },
];

/** Hues for agents, spread around the wheel and close to pi-d-ui's palette. */
export const AVATAR_HUES = [255, 55, 25, 150, 305, 180, 350, 85] as const;

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

/** An agent's own hue, stable across sessions. */
export const avatarHue = (agentId: string): number =>
  AVATAR_HUES[hash(agentId) % AVATAR_HUES.length]!;

/** Seconds into its idle routine this agent starts at, so a list of them does not move in step. */
export const avatarPhase = (agentId: string): number => hash(`phase:${agentId}`) % 24;

export interface AvatarArtProps {
  style: AvatarStyle;
  state: AvatarState;
  /** 0-360. */
  hue: number;
  /** Pixels. */
  size?: number;
  /** Seconds into the idle routine; see avatarPhase. */
  phase?: number;
  /** A disabled agent: grey and still. */
  off?: boolean;
  /** Spoken name. Without one the avatar is decorative (its row says the same in words). */
  label?: string;
  className?: string;
}

/** An agent's animated avatar. All five styles take the same states (see states.ts). */
export function AvatarArt({
  style,
  state,
  hue,
  size = 40,
  phase = 0,
  off = false,
  label,
  className,
}: AvatarArtProps) {
  const css = {
    '--agent-h': hue,
    '--phase': `-${phase}s`,
    fontSize: size,
  } as CSSProperties;
  return (
    <span
      role="img"
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-state={state}
      className={cn('av', `av-${style}`, `av-${state}`, off && 'av-off', className)}
      style={css}
    >
      {style === 'face' && <FaceArt />}
      {style === 'orb' && <OrbArt />}
      {style === 'pi' && <PiArt />}
      {style === 'bars' && <BarsArt />}
      {style === 'dots' && <DotsArt />}
    </span>
  );
}

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="av-svg" viewBox="0 0 100 100" aria-hidden="true">
      {children}
    </svg>
  );
}

/** Three z's drawn as strokes, rising while asleep. */
function Zzz({ at }: { at: [number, number, number][] }) {
  return (
    <g className="av-zzz">
      {at.map(([x, y, scale]) => (
        <g key={`${x}-${y}`} transform={`translate(${x} ${y}) scale(${scale})`}>
          <path className="av-z" d="M0 0 H9 L0 10 H9" />
        </g>
      ))}
    </g>
  );
}

const SPARKLE = 'M83 5 L86 15 L96 18 L86 21 L83 31 L80 21 L70 18 L80 15 Z';

// ── Face: pi-d-ui's, as it is ───────────────────────────────────────────────────────────────

function FaceArt() {
  return (
    <Svg>
      <g className="face-body">
        <circle className="face-disc" cx="50" cy="50" r="44" />
        <g className="face-gaze">
          <g className="face-eye face-eye-l">
            <g className="face-blink">
              <rect />
            </g>
          </g>
          <g className="face-eye face-eye-r">
            <g className="face-blink">
              <rect />
            </g>
          </g>
        </g>
        <g className="face-happy">
          <path d="M32 51 Q38.5 41 45 51" />
          <path d="M55 51 Q61.5 41 68 51" />
        </g>
      </g>
      <g className="face-zzz">
        <text className="face-z face-z-1" x="68" y="26">
          z
        </text>
        <text className="face-z face-z-2" x="78" y="15">
          z
        </text>
        <text className="face-z face-z-3" x="88" y="5">
          z
        </text>
      </g>
      <path className="face-sweat" d="M84 20 Q89 28 84 31 Q79 28 84 20 Z" />
      <path
        className="face-sparkle"
        d="M84 4 L86.5 11.5 L94 14 L86.5 16.5 L84 24 L81.5 16.5 L74 14 L81.5 11.5 Z"
      />
      <g className="face-alert">
        <rect x="44" y="12" width="12" height="52" rx="6" />
        <circle cx="50" cy="82" r="7" />
      </g>
    </Svg>
  );
}

// ── Orb ─────────────────────────────────────────────────────────────────────────────────────

function OrbArt() {
  return (
    <>
      <span className="orb-glow" />
      <span className="orb-body">
        <span className="orb-swirl" />
        <span className="orb-core" />
        <span className="orb-shine" />
      </span>
      <span className="orb-orbit" />
      <span className="orb-ring" />
      <span className="orb-ping" />
      <span className="orb-badge" />
    </>
  );
}

// ── Pi ──────────────────────────────────────────────────────────────────────────────────────

function PiArt() {
  return (
    <Svg>
      <circle className="pi-back" cx="50" cy="50" r="46" />
      <circle className="pi-ping" cx="50" cy="50" r="46" />
      <circle className="pi-dash" cx="50" cy="50" r="46" />
      <g className="pi-body">
        <g className="pi-bar">
          <path d="M21 31 H79" />
        </g>
        <g className="pi-leg pi-leg-l">
          <path d="M38 33 V73" />
        </g>
        <g className="pi-leg pi-leg-r">
          <path d="M62 33 V61 Q62 73 75 73" />
        </g>
      </g>
      <Zzz
        at={[
          [64, 28, 0.75],
          [74, 15, 0.95],
          [85, 2, 1.15],
        ]}
      />
      <path className="av-spark" d={SPARKLE} />
      <circle className="pi-badge" cx="84" cy="16" r="11" />
    </Svg>
  );
}

// ── Signal ──────────────────────────────────────────────────────────────────────────────────

function BarsArt() {
  return (
    <Svg>
      <rect className="bars-tile" x="4" y="4" width="92" height="92" rx="26" />
      <rect className="bars-ping" x="4" y="4" width="92" height="92" rx="26" />
      {[0, 1, 2, 3, 4].map((i) => (
        <rect
          key={i}
          className="bars-bar"
          style={{ '--i': i } as CSSProperties}
          x={18 + i * 14}
          y="22"
          width="8"
          height="56"
          rx="4"
        />
      ))}
    </Svg>
  );
}

// ── Pixel ───────────────────────────────────────────────────────────────────────────────────

/** Round dot matrix: a 4×4 grid without its corners. `o` is the order around its ring. */
const OUTER: [number, number][] = [
  [1, 0],
  [2, 0],
  [3, 1],
  [3, 2],
  [2, 3],
  [1, 3],
  [0, 2],
  [0, 1],
];
const INNER: [number, number][] = [
  [1, 1],
  [2, 1],
  [2, 2],
  [1, 2],
];
const DOTS = [
  ...INNER.map(([x, y], o) => ({ x, y, o, inner: true })),
  ...OUTER.map(([x, y], o) => ({ x, y, o, inner: false })),
].map((dot, i) => ({ ...dot, i, d: Math.hypot(dot.x - 1.5, dot.y - 1.5) }));

function DotsArt() {
  return (
    <Svg>
      <circle className="dots-back" cx="50" cy="50" r="46" />
      {DOTS.map((dot) => (
        <circle
          key={dot.i}
          className={cn('dot', dot.inner ? 'dot-in' : 'dot-out', dot.i === 0 && 'dot-heart')}
          style={{ '--i': dot.i, '--o': dot.o, '--d': dot.d.toFixed(2) } as CSSProperties}
          cx={20 + dot.x * 20}
          cy={20 + dot.y * 20}
          r="7"
        />
      ))}
    </Svg>
  );
}
