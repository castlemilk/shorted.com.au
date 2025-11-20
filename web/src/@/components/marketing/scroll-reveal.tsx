"use client";

import { useEffect, useRef, useState } from "react";
import { useSpring, animated } from "react-spring";

interface ScrollRevealProps {
  children: React.ReactNode;
  delay?: number;
  direction?: "up" | "down" | "left" | "right";
  className?: string;
}

export function ScrollReveal({
  children,
  delay = 0,
  direction = "up",
  className = "",
}: ScrollRevealProps) {
  const [isVisible, setIsVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsVisible(true);
        }
      },
      { threshold: 0.1 }
    );

    if (ref.current) {
      observer.observe(ref.current);
    }

    return () => {
      if (ref.current) {
        observer.unobserve(ref.current);
      }
    };
  }, []);

  const directions = {
    up: { from: { opacity: 0, transform: "translateY(30px)" }, to: { opacity: 1, transform: "translateY(0)" } },
    down: { from: { opacity: 0, transform: "translateY(-30px)" }, to: { opacity: 1, transform: "translateY(0)" } },
    left: { from: { opacity: 0, transform: "translateX(30px)" }, to: { opacity: 1, transform: "translateX(0)" } },
    right: { from: { opacity: 0, transform: "translateX(-30px)" }, to: { opacity: 1, transform: "translateX(0)" } },
  };

  const spring = useSpring({
    ...directions[direction].from,
    ...(isVisible ? directions[direction].to : directions[direction].from),
    config: { tension: 50, friction: 20 },
    delay,
  });

  return (
    <animated.div ref={ref} style={spring} className={className}>
      {children}
    </animated.div>
  );
}

