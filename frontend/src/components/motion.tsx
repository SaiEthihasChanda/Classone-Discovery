/**
 * Card enter / leave / reflow, iOS-notification style: a new card drops in
 * from above with a soft spring, a leaving card fades and shrinks away, and
 * the cards around it glide into the gap instead of jumping.
 *
 * Use with `<AnimatePresence mode="popLayout" initial={false}>` around a list
 * of `motion.*` elements spreading `cardMotion`. `initial={false}` keeps the
 * first render still, so only real arrivals animate. Reduced-motion users get
 * plain fades (MotionConfig reducedMotion="user" in App).
 */
import { useEffect, useRef, useState } from 'react';
import type { Transition } from 'motion/react';

const spring: Transition = { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 };

export const cardMotion = {
  layout: 'position' as const,
  initial: { opacity: 0, y: -18, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1, transition: spring },
  exit: { opacity: 0, scale: 0.92, transition: { duration: 0.18, ease: 'easeIn' as const } },
  transition: spring,
};

/** The house spring: quick to settle, no wobble. Shared by pills, indicators and cards. */
export const softSpring: Transition = { type: 'spring', stiffness: 520, damping: 40, mass: 0.8 };

/** Page enter: a short rise and fade. Opacity and transform only, so it stays on the compositor. */
export const pageMotion = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
};

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A number that counts up to its value ("946", "20%", "1.7 h"): the leading number animates and the
 * rest of the text stays as it is. Later changes count from the old value. Reduced motion: no count.
 */
export function CountUp({ text, duration = 900 }: { text: string; duration?: number }) {
  const m = /^(\d+(?:\.\d+)?)(.*)$/s.exec(text);
  const target = m ? Number(m[1]) : NaN;
  const decimals = m && m[1].includes('.') ? m[1].split('.')[1].length : 0;
  const from = useRef(0);
  const [shown, setShown] = useState(() => (reducedMotion() || !m ? target : 0));
  useEffect(() => {
    if (!m || reducedMotion()) {
      setShown(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      setShown(a + (target - a) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      from.current = target;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);
  if (!m) return <>{text}</>;
  const num = decimals ? shown.toFixed(decimals) : Math.round(shown).toLocaleString('en-IN');
  return (
    <>
      <span aria-hidden>{num + m[2]}</span>
      <span className="visually-hidden">{text}</span>
    </>
  );
}

export { AnimatePresence, LayoutGroup, motion, MotionConfig } from 'motion/react';
