"use client";

import {
  Children,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type RefAttributes,
} from "react";
import {
  motion,
  useInView,
  type DOMMotionComponents,
  type HTMLMotionProps,
  type MotionProps,
} from "motion/react";

const cn = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(" ");

interface SequenceContextValue {
  completeItem: (index: number) => void;
  activeIndex: number;
  sequenceStarted: boolean;
}

const SequenceContext = createContext<SequenceContextValue | null>(null);
const useSequence = () => useContext(SequenceContext);

const ItemIndexContext = createContext<number | null>(null);
const useItemIndex = () => useContext(ItemIndexContext);

const motionElements = {
  article: motion.article,
  div: motion.div,
  h1: motion.h1,
  h2: motion.h2,
  h3: motion.h3,
  h4: motion.h4,
  h5: motion.h5,
  h6: motion.h6,
  li: motion.li,
  p: motion.p,
  section: motion.section,
  span: motion.span,
} as const;

type MotionElementType = Extract<
  keyof DOMMotionComponents,
  keyof typeof motionElements
>;
type TerminalTypingMotionComponent = ComponentType<
  Omit<HTMLMotionProps<"span">, "ref"> & RefAttributes<HTMLElement>
>;

interface AnimatedSpanProps extends MotionProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  startOnView?: boolean;
}

export const AnimatedSpan = ({
  children,
  delay = 0,
  className,
  startOnView = false,
  ...props
}: AnimatedSpanProps) => {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const isInView = useInView(elementRef as React.RefObject<Element>, {
    amount: 0.3,
    once: true,
  });

  const sequence = useSequence();
  const itemIndex = useItemIndex();
  const [hasStarted, setHasStarted] = useState(false);
  useEffect(() => {
    if (!sequence || itemIndex === null) return;
    if (!sequence.sequenceStarted) return;
    if (hasStarted) return;
    if (sequence.activeIndex === itemIndex) {
      setHasStarted(true);
    }
  }, [sequence, hasStarted, itemIndex]);

  const shouldAnimate = sequence ? hasStarted : startOnView ? isInView : true;

  return (
    <motion.div
      ref={elementRef}
      initial={{ opacity: 0, y: -5 }}
      animate={shouldAnimate ? { opacity: 1, y: 0 } : { opacity: 0, y: -5 }}
      transition={{ duration: 0.3, delay: sequence ? 0 : delay / 1000 }}
      className={cn("grid text-sm font-normal tracking-tight", className)}
      onAnimationComplete={() => {
        if (!sequence) return;
        if (itemIndex === null) return;
        // The "stay hidden" animate() (pre-sequence-start) also completes —
        // without this guard it advances the chain invisibly, so terminals
        // that mount below the fold are already "finished" when scrolled in.
        if (!hasStarted) return;
        sequence.completeItem(itemIndex);
      }}
      {...props}
    >
      {children}
    </motion.div>
  );
};

interface TypingAnimationProps extends Omit<MotionProps, "children"> {
  children: string;
  className?: string;
  duration?: number;
  delay?: number;
  as?: MotionElementType;
  startOnView?: boolean;
}

export const TypingAnimation = ({
  children,
  className,
  duration = 60,
  delay = 0,
  as: Component = "span",
  startOnView = true,
  ...props
}: TypingAnimationProps) => {
  if (typeof children !== "string") {
    throw new Error("TypingAnimation: children must be a string. Received:");
  }

  const MotionComponent = motionElements[
    Component
  ] as TerminalTypingMotionComponent;

  const [displayedText, setDisplayedText] = useState<string>("");
  const [started, setStarted] = useState(false);
  const elementRef = useRef<HTMLElement | null>(null);
  const isInView = useInView(elementRef as React.RefObject<Element>, {
    amount: 0.3,
    once: true,
  });

  const sequence = useSequence();
  const itemIndex = useItemIndex();
  const hasSequence = sequence !== null;
  const sequenceStarted = sequence?.sequenceStarted ?? false;
  const sequenceActiveIndex = sequence?.activeIndex ?? null;
  const sequenceCompleteItemRef = useRef<
    SequenceContextValue["completeItem"] | null
  >(null);
  const sequenceItemIndexRef = useRef<number | null>(null);

  useEffect(() => {
    sequenceCompleteItemRef.current = sequence?.completeItem ?? null;
    sequenceItemIndexRef.current = itemIndex;
  }, [sequence?.completeItem, itemIndex]);

  useEffect(() => {
    let startTimeout: ReturnType<typeof setTimeout> | null = null;

    if (hasSequence && itemIndex !== null) {
      if (sequenceStarted && !started && sequenceActiveIndex === itemIndex) {
        setStarted(true);
      }
    } else if (!startOnView || isInView) {
      startTimeout = setTimeout(() => setStarted(true), delay);
    }

    return () => {
      if (startTimeout !== null) clearTimeout(startTimeout);
    };
  }, [
    delay,
    startOnView,
    isInView,
    started,
    hasSequence,
    sequenceActiveIndex,
    sequenceStarted,
    itemIndex,
  ]);

  useEffect(() => {
    let typingEffect: ReturnType<typeof setInterval> | null = null;

    if (started) {
      let i = 0;
      typingEffect = setInterval(() => {
        if (i < children.length) {
          setDisplayedText(children.substring(0, i + 1));
          i++;
        } else {
          if (typingEffect !== null) clearInterval(typingEffect);
          const completeItem = sequenceCompleteItemRef.current;
          const currentItemIndex = sequenceItemIndexRef.current;
          if (completeItem && currentItemIndex !== null) {
            completeItem(currentItemIndex);
          }
        }
      }, duration);
    }

    return () => {
      if (typingEffect !== null) clearInterval(typingEffect);
    };
  }, [children, duration, started]);

  return (
    <MotionComponent
      ref={elementRef}
      className={cn("text-sm font-normal tracking-tight", className)}
      {...props}
    >
      {displayedText}
    </MotionComponent>
  );
};

interface TerminalProps {
  children: React.ReactNode;
  className?: string;
  sequence?: boolean;
  startOnView?: boolean;
  /** rendered directly below the chrome (traffic-light) bar — e.g. a
      progress strip. Most terminals don't use this. */
  chromeExtra?: React.ReactNode;
}

export const Terminal = ({
  children,
  className,
  sequence = true,
  startOnView = true,
  chromeExtra,
}: TerminalProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Native IntersectionObserver instead of motion's useInView: the latter
  // silently never fired for terminals that scroll into view after load
  // (verified in-browser — a native IO on the same element reports ratio 1
  // while useInView stays false), leaving whole transcripts at opacity 0.
  const [isInView, setIsInView] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const [activeIndex, setActiveIndex] = useState(0);
  const sequenceHasStarted = sequence ? !startOnView || isInView : false;

  const contextValue = useMemo<SequenceContextValue | null>(() => {
    if (!sequence) return null;
    return {
      completeItem: (index: number) => {
        setActiveIndex((current) =>
          index === current ? current + 1 : current
        );
      },
      activeIndex,
      sequenceStarted: sequenceHasStarted,
    };
  }, [sequence, activeIndex, sequenceHasStarted]);

  const wrappedChildren = useMemo(() => {
    if (!sequence) return children;
    const array = Children.toArray(children);
    return array.map((child, index) => (
      <ItemIndexContext.Provider key={index} value={index}>
        {child as React.ReactNode}
      </ItemIndexContext.Provider>
    ));
  }, [children, sequence]);

  // Inlined chrome (instead of <MacWindow>) so containerRef attaches to the
  // real DOM node — useInView needs that to fire `sequenceStarted` for the
  // typed-in animations. Same visual chrome as CodeFile.
  const content = (
    <div
      ref={containerRef}
      className={cn(
        "bg-fd-background border-fd-border text-fd-foreground z-0 h-full max-h-100 w-full max-w-lg overflow-hidden rounded-[8px] border",
        className,
      )}
    >
      <div className="border-fd-border bg-fd-muted/40 text-fd-muted-foreground flex items-center gap-x-2 border-b px-4 py-3 font-mono text-[12px]">
        <span className="h-2 w-2 rounded-full bg-[#E46A6A]"></span>
        <span className="h-2 w-2 rounded-full bg-[#E2C04C]"></span>
        <span className="h-2 w-2 rounded-full bg-[#5DCE78]"></span>
      </div>
      {chromeExtra}
      <pre className="p-4">
        <code className="grid gap-y-1 overflow-auto">{wrappedChildren}</code>
      </pre>
    </div>
  );

  if (!sequence) return content;

  return (
    <SequenceContext.Provider value={contextValue}>
      {content}
    </SequenceContext.Provider>
  );
};

// Static file viewer with macOS chrome + filename label. No animations.
export function CodeFile({
  filename,
  className,
  children,
}: {
  filename: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <MacWindow filename={filename} className={cn("bg-fd-card", className)}>
      <div className="p-5 font-mono">{children}</div>
    </MacWindow>
  );
}

// Shared macOS-window chrome — traffic lights + optional filename label.
// Used by CodeFile; Terminal inlines the same markup so it can attach its
// own ref for useInView.
const MacWindow = ({
  filename,
  className,
  children,
}: {
  filename?: string;
  className?: string;
  children: React.ReactNode;
}) => (
  <div
    className={cn(
      "border-fd-border text-fd-foreground z-0 w-full overflow-hidden rounded-[8px] border",
      className,
    )}
  >
    <div className="border-fd-border bg-fd-muted/40 text-fd-muted-foreground flex items-center gap-x-2 border-b px-4 py-3 font-mono text-[12px]">
      <span className="h-2 w-2 rounded-full bg-[#E46A6A]"></span>
      <span className="h-2 w-2 rounded-full bg-[#E2C04C]"></span>
      <span className="h-2 w-2 rounded-full bg-[#5DCE78]"></span>
      {filename ? <span className="ml-2">{filename}</span> : null}
    </div>
    {children}
  </div>
);
