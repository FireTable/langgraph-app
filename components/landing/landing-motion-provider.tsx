"use client";

// ponytail: single LazyMotion boundary for the marketing route. Every
// motion-using component below relies on this provider; without it,
// the `motion.*` components throw at runtime. `domAnimation` is the
// minimum feature set that covers the demos (no layout animations, no
// drag — those aren't used here).

import { LazyMotion, domAnimation } from "motion/react";
import type { FC, ReactNode } from "react";

export const LandingMotionProvider: FC<{ children: ReactNode }> = ({ children }) => (
  <LazyMotion features={domAnimation} strict>
    {children}
  </LazyMotion>
);
