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
import type { Transition } from 'motion/react';

const spring: Transition = { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 };

export const cardMotion = {
  layout: 'position' as const,
  initial: { opacity: 0, y: -18, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1, transition: spring },
  exit: { opacity: 0, scale: 0.92, transition: { duration: 0.18, ease: 'easeIn' as const } },
  transition: spring,
};

export { AnimatePresence, motion, MotionConfig } from 'motion/react';
