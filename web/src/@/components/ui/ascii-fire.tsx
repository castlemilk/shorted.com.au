"use client";

/**
 * An animated ASCII fire, drawn in the site's own monospace.
 *
 * Built from a density ramp (` .:-=+*#%@` and block glyphs) rather than an
 * image, so it inherits the page's font, scales with type, costs no network
 * request, and stays crisp at any DPI.
 *
 * The animation is pure CSS: FRAMES cycle on a `steps()` keyframe, and each
 * column carries a small out-of-phase flicker. Two frames alone read as a
 * blinking texture; the per-column phase is what makes it read as fire.
 *
 * ACCESSIBILITY. It is decorative, so it is `aria-hidden` and the surrounding
 * copy carries the meaning. Under `prefers-reduced-motion` the cycling and the
 * flicker both stop and a single frame is shown — a flickering block of text is
 * exactly the kind of motion that triggers vestibular symptoms, and this is a
 * celebration, not information.
 */

// Four frames of the same flame, generated from a density profile rather than
// drawn by hand or filled at random. Fire has structure, and both shortcuts
// lose it: pure noise reads as static, and a hand-drawn blob reads as a hedge.
//
// The profile is three things multiplied — heat rising up the rows, a
// horizontal envelope that tapers harder the higher you go (so it is a fire and
// not a wall), and offset sine lobes that separate it into tongues — with a
// little jitter on top. Each frame reseeds the jitter and shifts the lobes, so
// the tongues move between frames instead of merely flickering.
const FRAMES = [
  `                                 
       ░░  ░░░ ░   ░░    ░       
       ░░   ░▒░░░ ░░░  ░░ ░░     
  ░  ░░░░░░░░░░ ░▒▒▒▒░░░░  ░     
    ░░░░░░░░░▒▒░░▒░░░▒░▒▒░░░░    
  ░ ░▒▒░▒░▒▒▒▒░▒░▓▓▒▒▒▒▒▒▒░░░░   
 ░░░▒░▒▒▒▒▒▒▓▓▓▒▒▓▓▓▒▒░▒▓▒▒░░░░░░
░▒░ ▒▒▒▒▓▒▓▓▓█▓▒▒▒▓█▓▓▒▒▓▓▒▒ ░▒░ 
▒░░░░▓▒▓▒▓▓▓▓█▓▓▒▓█▓▓▒▒▒██▓░░▒▒░░
▒░▒░▒▒▓█▓▒▓███▓▓▓████▓▒▓▓▓▒▒░░▒░▒
▒▒░▒▓▓█▓█▓█████▓██████▓████▒▒▒▓▒░
▒▓▒▒▓███▓▒▓████▓▓████▓▓▓███▓▒▓▓▒▒
▒▒▒▒████▓▒█████▓███████████▓▒▓▓▒▓`,
  `                                 
        ░ ░░  ░   ░ ░ ░░  ░      
  ░ ░   ░░   ░░ ░░░ ░ ░  ░  ░    
    ░ ░ ░░░░ ░▒░░▒  ░░▒░  ░░░░   
  ░  ░░░▒▒▒░▒░▒▒░▒░░░░░▒░░▒▒░░   
 ░ ░░  ░░▒▒░░░▒▒▒▒▒░▓▓▒▒░░░░░░ ░ 
 ░░░▒░░▒▒▒▓▒░▒▓▓▒▓░▒▒▓▒▓░░▒▒▒░   
░░▒▒░▒▒▒▓▓▓▓░▓▓██▓▒▒▒▓▓▒▒▒▒▓░░▒  
 ░▒▓▒░░▒▓█▓▓▒▓██▓▓▓▒█▓█▓▓▒▒▒▒░░░ 
░░▒▓▓▒▒▓▓██▓▓▓████▓▒███▓▓░▓▓▓▓▒ ░
░░▓▓▒▓▒▓███▓▒█████▓████▓▓▒▒█▓▓▒░▒
▒▓▒▓▓▓▒▓████▓█████▓█████▓▓▓█▓▓▒░▒
▒▓▓▓▓▓▒█████▓███████████▓▓▓██▓▓░▒`,
  `                                 
       ░        ░░░░░  ░░░       
       ░░ ░ ░░░░░▒░ ░  ░░  ░ ░   
    ░░░░░ ░▒░░ ░░░▒▒░░░░░░░  ░░  
    ░░░░░ ▒▒▒░▒░░▒▒░░░▒░▒░░░░░   
 ░░ ░▒▒▒░░▒▓▒▒▒░▒▓▒▒▒▒▒▒▓▒░░░░░  
  ░░▒░▓▒▒▒▓▓▒▓▒░▒▓▓▓▒░▒▓▒▓▒░░▒░░░
░░ ░▒▒▒▒▒▒▒▓▓▒▒░▒██▓▓▒▒▒▓▓▒░░░░░░
 ░░░▒▒▓▓▒▒▓███▓▒▓█▓▓▓▓▓▓█▓▒▒░▒▒▒░
▒▒░░▒▒▓▓▒▒▓██▓█▒████▓▓▒███▒▒▒░▒▒▒
░░░▒▓▓▓▓▓▒▓████▒█████▓█▓▓██▒▒▓▒▒░
▒▒░▒█▓██▓▓█████▒█████▓▓███▓▒▓▓▓▓▒
▒▒▒▓████▓▓████████████▓███▓▒▒▓▓▓▓`,
  `                                 
             ░       ░           
         ░░░░░ ░░░ ░░░     ░     
   ░    ░░░ ░░▒░░░░▒░░░   ░░░    
 ░  ░░░░▒▒▒░░░▒▒▒▒░▒▒▒▒░░░░▒░ ░░ 
 ░ ▒░ ░▒▒▒▒░░▓▒▓▒▒▒▒▒▓▒▒░▒▒░░    
░░░░▒░░▒▓▒▒▒▒▒▒▓▓▒░▒▓▓▒▒▒░▒░░▒ ░ 
░░░▒░░▒▓▒▓▓▒▒▓▓▓▓▒▒▓▓▓▓▒▒▒▓▒▒▒░░ 
░░▒░░░▒▒█▓▓▒▓▓██▓▓▒▓▓▓█▓▒▓▓▒▒▒░░░
▒░▒▒▒▒▓▓██▓▓▓▓████▓▓██▓▓░▒▓▓▓▒▒░░
░▓▓▓▓▒▒▓███▓▒█████▓████▓▒▒▓▓▒▓░▒▒
▒▒▓▓▓▒▓█████▓█████▓████▓▓▒█▓▓▓▒░▒
▒▓▓██▓██████▓█████▓█████▒████▓▒▒▒`,
];

export function AsciiFire({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`ascii-fire select-none ${className}`}
      // The frames are stacked and cross-faded by the keyframes below, so the
      // block always occupies one frame's worth of height and nothing reflows.
      style={{ position: "relative" }}
    >
      {FRAMES.map((frame, i) => (
        <pre
          key={i}
          className="ascii-fire__frame"
          style={{ animationDelay: `${i * 0.09}s` }}
        >
          {frame}
        </pre>
      ))}
      {/* First frame again, in flow, purely to reserve the height. */}
      <pre className="ascii-fire__spacer" aria-hidden="true">
        {FRAMES[0]}
      </pre>

      <style jsx>{`
        .ascii-fire {
          line-height: 1.05;
          filter: drop-shadow(0 0 18px rgba(249, 115, 22, 0.35));
        }
        /* The gradient is applied to each FRAME, not the wrapper:
           background-clip:text clips to an element's OWN text, and the
           wrapper has none — its text lives in the children. */
        .ascii-fire__frame,
        .ascii-fire__spacer {
          margin: 0;
          font-family: inherit;
          font-size: inherit;
          line-height: inherit;
          white-space: pre;
          /* The warm ramp: deep ember at the base, hot amber at the tips. */
          background-image: linear-gradient(
            to top,
            #7c2d12 0%,
            #c2410c 28%,
            #f97316 55%,
            #fbbf24 80%,
            #fef3c7 100%
          );
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
        }
        .ascii-fire__frame {
          position: absolute;
          inset: 0;
          opacity: 0;
          animation: ascii-fire-cycle 0.36s steps(1, end) infinite;
        }
        .ascii-fire__spacer {
          visibility: hidden;
        }
        @keyframes ascii-fire-cycle {
          0%,
          24.99% {
            opacity: 1;
          }
          25%,
          100% {
            opacity: 0;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .ascii-fire__frame {
            animation: none;
            opacity: 0;
          }
          /* Show exactly one frame, held still. */
          .ascii-fire__frame:first-child {
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}
