"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Glass, glassValue, type GlassOptics, type GlassSurfaceLens } from "@samasante/liquid-glass";
import { cn } from "@/lib/cn";

/**
 * The demo film player: heyclicky's feel via Shelf's glass (laksh-ya/shelf video-tile.tsx).
 * - Before playing: a liquid-glass "play video" pill follows the cursor over the poster
 *   (the cursor hides); on touch it stays centred. The whole frame presses in when clicked.
 * - While playing: play/pause, +-10 s, sound and the scrub bar are separate glass lenses
 *   bending the live video (samasante/liquid-glass, one WebGL renderer). Controls and the
 *   cursor hide when idle; tapping the picture shows or hides them; pausing keeps them up.
 */

const LENS: Partial<GlassOptics> = {
  mapSize: 256,
  clipToShape: true,
  softEdge: true,
  strength: 0.16,
  depth: 0.22,
  curvature: 0.55,
  bend: 0.25,
  bendWidth: 0.08,
  dispersion: 0.15,
  specular: 1.1,
  sheenAngle: 50,
  glow: 0.15,
  glowSpread: 1,
  glowFalloff: 1.5,
  sheen: 0.95,
  sheenWidth: 2,
  sheenFalloff: 1.5,
  frost: 2,
  brightness: -0.14,
};

const TRACK: Partial<GlassOptics> = {
  strength: 0.03,
  depth: 0.3,
  curvature: 0.25,
  dispersion: 0.2,
  bend: 0.05,
  bendWidth: 0.06,
  specular: 1,
  sheen: 0.35,
  sheenWidth: 3,
  sheenFalloff: 1.5,
  glow: 0.1,
  frost: 6,
  brightness: -0.1,
};

const ICON = "drop-shadow(0 1px 2px rgba(0,0,0,0.5)) drop-shadow(0 0 8px rgba(0,0,0,0.3))";

function useBox<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

/** Live glass only on or near the screen. */
function useNear(ref: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(!!e?.isIntersecting), { rootMargin: "150px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return near;
}

const PlayIcon = ({ playing, size }: { playing: boolean; size: number }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" fill="#fff" style={{ filter: ICON }} aria-hidden>
    {playing ? (
      <>
        <rect x="36.2" y="30.8" width="9.2" height="38.4" rx="2.2" />
        <rect x="54.6" y="30.8" width="9.2" height="38.4" rx="2.2" />
      </>
    ) : (
      <path d="M39 29.5 Q39 27 41.3 28.2 L72 47.8 Q74 49 72 51 L41.3 71.8 Q39 73 39 70.5 Z" />
    )}
  </svg>
);

const SkipIcon = ({ dir, size }: { dir: 1 | -1; size: number }) => {
  const mirror = dir > 0 ? "translate(24,0) scale(-1,1)" : undefined;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ filter: ICON, overflow: "visible" }} aria-hidden>
      <g transform={mirror}>
        <path d="M16.5 4.2 A9 9 0 1 1 7.5 4.2" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M5.4 4.2 L9 2.5 L8.9 6.1 Z" fill="#fff" />
        <text x="12" y="12.6" textAnchor="middle" dominantBaseline="central" fontSize="9" fontWeight="600" fill="#fff" transform={mirror}>
          10
        </text>
      </g>
    </svg>
  );
};

const SoundIcon = ({ muted, size }: { muted: boolean; size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ filter: ICON }} aria-hidden>
    <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="#fff" />
    {muted ? (
      <>
        <path d="M16 9.5l5 5" />
        <path d="M21 9.5l-5 5" />
      </>
    ) : (
      <>
        <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
        <path d="M18.3 6.6a7.6 7.6 0 0 1 0 10.8" />
      </>
    )}
  </svg>
);

// The heyclicky play pill: light, clear glass with a soft frost, one bending pass and a white rim.
const PILL: Partial<GlassOptics> = {
  mapSize: 128,
  clipToShape: true,
  softEdge: true,
  strength: 0.18,
  depth: 0.5,
  curvature: 0.2,
  bend: 0.3,
  bendWidth: 0.18,
  dispersion: 0,
  frost: 2,
  specular: 1,
  sheen: 0.8,
  sheenWidth: 1.4,
  sheenAngle: 40,
  brightness: 0.02,
};

/** Press-in feedback for the whole frame (heyclicky: 97% in 0.12 s). */
function usePress() {
  const [pressing, setPressing] = useState(false);
  const end = () => setPressing(false);
  return { pressing, onPointerDown: (e: React.PointerEvent) => e.button === 0 && setPressing(true), onPointerUp: end, onPointerCancel: end, end };
}

const SRC = "/demo.mp4";
const POSTER = "/demo-poster.jpg";

export function DemoFilmPlayer({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const [playing, setPlaying] = useState(false);
  if (playing) return <Player className={className} style={style} />;
  return <Poster className={className} style={style} onPlay={() => setPlaying(true)} />;
}

function Poster({ className, style, onPlay }: { className?: string; style?: React.CSSProperties; onPlay: () => void }) {
  const press = usePress();
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNear(ref);
  const [follow, setFollow] = useState(false);
  const move = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el || e.pointerType === "touch") return; // on phones the pill stays centred
    const r = el.getBoundingClientRect();
    el.style.setProperty("--gx", `${e.clientX - r.left}px`);
    el.style.setProperty("--gy", `${e.clientY - r.top}px`);
    setFollow(true);
  };
  const pill = (
    <span className="relative z-10 flex items-center gap-2.5">
      {/* A chunky rounded triangle, nudged right so it sits optically centred. */}
      <svg viewBox="0 0 20 20" className="size-[18px] shrink-0" fill="currentColor" aria-hidden>
        <path d="M8.7 2.2C6.7.9 4.2 2.3 4.2 4.6v10.8c0 2.3 2.5 3.7 4.5 2.4l8.3-5.4c1.8-1.1 1.8-3.8 0-4.9z" />
      </svg>
      <span>play video</span>
    </span>
  );
  return (
    <button
      ref={ref}
      type="button"
      onClick={onPlay}
      onPointerMove={move}
      onPointerDown={press.onPointerDown}
      onPointerUp={press.onPointerUp}
      onPointerCancel={press.onPointerCancel}
      onPointerLeave={() => (press.end(), setFollow(false))}
      className={cn(
        "vid-frame group relative block aspect-video w-full overflow-hidden bg-black transition-transform duration-[120ms] ease-out",
        follow && "cursor-none",
        press.pressing && "scale-[0.97]",
        className,
      )}
      style={style}
      aria-label="Play the demo video"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={POSTER} alt="" className="size-full object-cover" />
      <span className={cn("pointer-events-none absolute z-10", follow ? "play-follow" : "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2")} aria-hidden>
        <span className="block transition-[scale] duration-200 ease-[cubic-bezier(0.34,1.5,0.5,1)] group-hover:scale-[1.04] group-active:scale-[0.94]">
          {near ? (
            <Glass optics={PILL} className="play-glass">
              {pill}
            </Glass>
          ) : (
            <span className="play-glass play-glass--flat">{pill}</span>
          )}
        </span>
      </span>
    </button>
  );
}

type Ctrl = "play" | "back" | "fwd" | "sound";
const CTRLS: Ctrl[] = ["play", "back", "fwd", "sound"];

/** A small spring per control (stiff, slightly bouncy), stepped once per frame only while moving. */
function useSprings(targets: Record<Ctrl, number>) {
  const [val, setVal] = useState(targets);
  const state = useRef({ x: { ...targets }, v: { play: 0, back: 0, fwd: 0, sound: 0 } as Record<Ctrl, number> });
  const key = CTRLS.map((c) => targets[c]).join();
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      let moving = false;
      const next = {} as Record<Ctrl, number>;
      for (const c of CTRLS) {
        const { x, v } = state.current;
        const a = 700 * (targets[c] - x[c]) - 30 * v[c];
        v[c] += a * dt;
        x[c] += v[c] * dt;
        if (Math.abs(targets[c] - x[c]) > 0.0008 || Math.abs(v[c]) > 0.01) moving = true;
        next[c] = x[c];
      }
      setVal(next);
      if (moving) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the targets
  }, [key]);
  return val;
}

/** A control sitting on its lens; hover and press feed the lens's scale so glass and icon move together. */
function LensButton({ id, d, left, top, label, scale, onHover, onPress, onClick, children }: {
  id: Ctrl;
  d: number;
  left: string;
  top: string;
  label: string;
  scale: number;
  onHover: (c: Ctrl | null) => void;
  onPress: (c: Ctrl | null) => void;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerEnter={() => onHover(id)}
      onPointerLeave={() => (onHover(null), onPress(null))}
      onPointerDown={() => onPress(id)}
      onPointerUp={() => onPress(null)}
      className="absolute grid place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-white/60"
      style={{ left, top, width: d, height: d, transform: `translate(-50%,-50%) scale(${scale})` }}
    >
      {children}
    </button>
  );
}

function Player({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const [ref, { w, h }] = useBox<HTMLDivElement>();
  const video = useRef<HTMLVideoElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(false);
  const [hover, setHover] = useState<Ctrl | null>(null);
  const [press, setPress] = useState<Ctrl | null>(null);
  const scrubbing = useRef(false);
  const frame = usePress();

  // When the controls show (heyclicky's rules): while the pointer is over the video, or after you
  // tap it, and always while paused. Leaving the video hides them at once; so does clicking anywhere
  // else; three still seconds while playing hide them (and the cursor) too.
  const [inside, setInside] = useState(false);
  const [active, setActive] = useState(true);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef(0);
  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 3000);
  }, []);
  useEffect(() => {
    idleTimer.current = window.setTimeout(() => setIdle(true), 3000);
    return () => clearTimeout(idleTimer.current);
  }, []);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setActive(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [ref]);
  const visible = !playing || ((inside || active) && !idle);

  // Scrolling the player away pauses it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => !!e && !e.isIntersecting && setPlaying(false), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  // Progress follows playback imperatively (no re-render per frame).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v && fill.current && v.duration > 0) fill.current.style.width = `${(v.currentTime / v.duration) * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const poke = () => {
    setActive(true);
    wake();
  };
  const togglePlay = () => {
    setPlaying((p) => !p);
    poke();
  };
  const skip = (d: number) => {
    const v = video.current;
    if (v && v.duration > 0) v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + d));
    poke();
  };
  const seekTo = (clientX: number, el: HTMLElement) => {
    const v = video.current;
    if (!v || !(v.duration > 0)) return;
    const r = el.getBoundingClientRect();
    v.currentTime = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * v.duration;
  };

  // Geometry scales with the player.
  const play = Math.round(Math.max(58, Math.min(92, w * 0.15)));
  const skipD = Math.round(play * 0.62);
  const soundD = Math.round(Math.max(34, play * 0.46));
  const gap = Math.min(0.24, (play * 1.4) / Math.max(w, 1));
  const trackH = 22;
  const inset = 0.05;
  const bottom = 0.07;
  const soundX = w ? 1 - (14 + soundD / 2) / w : 0.9;
  const soundY = h ? (14 + soundD / 2) / h : 0.1;

  // Hover swells a control a little; a press pushes it in; hidden controls shrink away. The glass
  // lens and its icon share one spring, so the whole bubble presses and bounces back together.
  const target = (c: Ctrl) => (!visible ? 0.8 : press === c ? 0.84 : hover === c ? 1.06 : 1);
  const sc = useSprings({ play: target("play"), back: target("back"), fwd: target("fwd"), sound: target("sound") });
  const k = (c: Ctrl) => sc[c];
  const o = visible ? 1 : 0;
  // The glass library redraws lenses only on new video frames unless a lens has live geometry, so a
  // paused video froze the lens while its icon sprang. While the controls are up, give the play lens
  // a live (motion-value) centre: the lenses then redraw every frame and move with their icons.
  const liveX = useMemo(() => glassValue(0.5), []);
  const lenses: GlassSurfaceLens[] = [
    { x: visible ? (liveX as unknown as number) : 0.5, y: 0.5, w: play, h: play, radius: play / 2, opacity: o, scale: k("play") },
    { x: 0.5 - gap, y: 0.5, w: skipD, h: skipD, radius: skipD / 2, opacity: o, scale: k("back") },
    { x: 0.5 + gap, y: 0.5, w: skipD, h: skipD, radius: skipD / 2, opacity: o, scale: k("fwd") },
    { x: soundX, y: soundY, w: soundD, h: soundD, radius: soundD / 2, opacity: o, scale: k("sound") },
  ];
  if (w > 0 && h > 0) lenses.push({ x: 0.5, y: 1 - bottom - trackH / 2 / h, w: w * (1 - 2 * inset), h: trackH, radius: 7, opacity: o, optics: TRACK });

  return (
    <div
      ref={ref}
      className={cn(
        "vid-frame relative aspect-video w-full overflow-hidden bg-black transition-transform duration-[120ms] ease-out",
        !visible && "cursor-none",
        frame.pressing && "scale-[0.97]",
        className,
      )}
      style={style}
      onPointerEnter={(e) => e.pointerType === "mouse" && (setInside(true), wake())}
      onPointerMove={(e) => e.pointerType === "mouse" && wake()}
      onPointerUp={frame.onPointerUp}
      onPointerCancel={frame.onPointerCancel}
      onPointerLeave={() => (frame.end(), setInside(false))}
    >
      <Glass
        src={SRC}
        poster={POSTER}
        optics={LENS}
        lenses={lenses}
        videoRef={video}
        paused={!playing}
        muted={muted}
        autoPlay
        crossOrigin="anonymous"
        maxDpr={2}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      >
        {/* Tapping the picture shows or hides the controls. */}
        <div className="absolute inset-0" onPointerDown={frame.onPointerDown} onClick={() => (visible && playing ? (setActive(false), setInside(false)) : poke())} aria-hidden />
        <div className={cn("absolute inset-0 transition-opacity duration-300", visible ? "opacity-100" : "pointer-events-none opacity-0")}>
          <LensButton id="back" d={skipD} left={`${(0.5 - gap) * 100}%`} top="50%" label="Back 10 seconds" scale={k("back")} onHover={setHover} onPress={setPress} onClick={() => skip(-10)}>
            <SkipIcon dir={-1} size={skipD * 0.6} />
          </LensButton>
          <LensButton id="play" d={play} left="50%" top="50%" label={playing ? "Pause" : "Play"} scale={k("play")} onHover={setHover} onPress={setPress} onClick={togglePlay}>
            <PlayIcon playing={playing} size={play * 0.92} />
          </LensButton>
          <LensButton id="fwd" d={skipD} left={`${(0.5 + gap) * 100}%`} top="50%" label="Forward 10 seconds" scale={k("fwd")} onHover={setHover} onPress={setPress} onClick={() => skip(10)}>
            <SkipIcon dir={1} size={skipD * 0.6} />
          </LensButton>
          <LensButton id="sound" d={soundD} left={`${soundX * 100}%`} top={`${soundY * 100}%`} label={muted ? "Unmute" : "Mute"} scale={k("sound")} onHover={setHover} onPress={setPress} onClick={() => (setMuted((x) => !x), poke())}>
            <SoundIcon muted={muted} size={soundD * 0.5} />
          </LensButton>
          <div
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={0}
            tabIndex={0}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => {
              e.stopPropagation();
              scrubbing.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              seekTo(e.clientX, e.currentTarget);
              clearTimeout(idleTimer.current);
            }}
            onPointerMove={(e) => scrubbing.current && seekTo(e.clientX, e.currentTarget)}
            onPointerUp={() => ((scrubbing.current = false), poke())}
            onKeyDown={(e) => (e.key === "ArrowLeft" ? skip(-5) : e.key === "ArrowRight" ? skip(5) : null)}
            className="group/scrub absolute flex cursor-pointer touch-none items-center px-3"
            style={{ left: `${inset * 100}%`, right: `${inset * 100}%`, bottom: `${bottom * 100}%`, height: trackH, borderRadius: 7 }}
          >
            <div className="relative h-1 w-full overflow-hidden rounded-full bg-white/30 shadow-[0_0_3px_rgba(0,0,0,0.25)] transition-[height] duration-200 group-hover/scrub:h-1.5">
              <div ref={fill} className="h-full w-0 rounded-full bg-white" />
            </div>
          </div>
        </div>
      </Glass>
    </div>
  );
}
