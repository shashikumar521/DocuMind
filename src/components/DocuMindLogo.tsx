import React, { useState } from "react";
import { motion } from "motion/react";

export type LogoSize = "xs" | "sm" | "md" | "lg";
export type LogoTone = "auto" | "dark" | "light";

interface DocuMindLogoProps {
  compact?: boolean;
  animated?: boolean;
  size?: LogoSize;
  tone?: LogoTone;
  className?: string;
}

interface DocuMindMarkProps {
  size?: LogoSize;
  className?: string;
}

const MARK_SIZE_CLASSES: Record<LogoSize, string> = {
  xs: "w-5 h-5",
  sm: "w-7 h-7",
  md: "w-8 h-8",
  lg: "w-12 h-12",
};

const FULL_LOGO_HEIGHT_CLASSES: Record<LogoSize, string> = {
  xs: "h-6",
  sm: "h-7",
  md: "h-8 sm:h-9",
  lg: "h-10 sm:h-12",
};

export const DocuMindMark: React.FC<DocuMindMarkProps> = ({
  size = "md",
  className = "",
}) => {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span
        aria-label="DocuMind"
        className={`${MARK_SIZE_CLASSES[size]} rounded-lg bg-gradient-to-br from-blue-600 to-cyan-400 text-white font-display font-bold text-xs inline-flex items-center justify-center shrink-0 ${className}`}
      >
        DM
      </span>
    );
  }

  return (
    <img
      src="/assets/documind-icon.png"
      alt="DocuMind"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(true)}
      className={`${MARK_SIZE_CLASSES[size]} object-contain shrink-0 select-none ${className}`}
    />
  );
};

export const DocuMindLogo: React.FC<DocuMindLogoProps> = ({
  compact = false,
  animated = true,
  size = "md",
  tone = "auto",
  className = "",
}) => {
  const [lightFailed, setLightFailed] = useState(false);
  const [darkFailed, setDarkFailed] = useState(false);

  const heightCls = FULL_LOGO_HEIGHT_CLASSES[size];

  const FullLogo = (
    <span className={`inline-flex items-center shrink-0 ${className}`}>
      {tone === "light" ? (
        lightFailed ? (
          <DocuMindTextFallback />
        ) : (
          <img
            src="/assets/documind-logo-light.png"
            alt="DocuMind"
            referrerPolicy="no-referrer"
            draggable={false}
            onError={() => setLightFailed(true)}
            className={`${heightCls} w-auto object-contain shrink-0 select-none`}
          />
        )
      ) : tone === "dark" ? (
        darkFailed ? (
          <DocuMindTextFallback />
        ) : (
          <img
            src="/assets/documind-logo-dark.png"
            alt="DocuMind"
            referrerPolicy="no-referrer"
            draggable={false}
            onError={() => setDarkFailed(true)}
            className={`${heightCls} w-auto object-contain shrink-0 select-none`}
          />
        )
      ) : (
        <>
          {lightFailed ? (
            <span className="dark:hidden">
              <DocuMindTextFallback />
            </span>
          ) : (
            <img
              src="/assets/documind-logo-light.png"
              alt="DocuMind"
              referrerPolicy="no-referrer"
              draggable={false}
              onError={() => setLightFailed(true)}
              className={`${heightCls} w-auto object-contain shrink-0 select-none dark:hidden`}
            />
          )}
          {darkFailed ? (
            <span className="hidden dark:inline-flex">
              <DocuMindTextFallback />
            </span>
          ) : (
            <img
              src="/assets/documind-logo-dark.png"
              alt="DocuMind"
              referrerPolicy="no-referrer"
              draggable={false}
              onError={() => setDarkFailed(true)}
              className={`${heightCls} w-auto object-contain shrink-0 select-none hidden dark:block`}
            />
          )}
        </>
      )}
    </span>
  );

  const content = compact ? <DocuMindMark size={size} className={className} /> : FullLogo;

  if (!animated) {
    return (
      <span className="inline-flex items-center whitespace-nowrap shrink-0">
        {content}
      </span>
    );
  }

  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="inline-flex items-center whitespace-nowrap shrink-0"
    >
      {content}
    </motion.span>
  );
};

const DocuMindTextFallback: React.FC = () => (
  <span className="inline-flex items-center gap-2 font-display font-bold text-[18px] tracking-tight text-[var(--dm-text)] leading-none">
    <DocuMindMark size="sm" />
    <span>
      Docu
      <span className="bg-gradient-to-r from-blue-600 to-cyan-400 bg-clip-text text-transparent">
        Mind
      </span>
    </span>
  </span>
);
