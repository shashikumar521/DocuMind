import React from "react";
import { motion } from "motion/react";

interface DocuMindLogoProps {
  compact?: boolean;
  animated?: boolean;
}

export const DocuMindLogo: React.FC<DocuMindLogoProps> = ({
  compact = false,
  animated = true,
}) => {
  const Mark = (
    <div className="relative w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500/25 via-indigo-500/20 to-cyan-400/25 border border-violet-400/35 flex items-center justify-center shrink-0 shadow-[0_0_20px_-6px_rgba(139,92,246,0.65)]">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d="M6.5 3.5H14.5L19 8V19.5C19 20.3284 18.3284 21 17.5 21H6.5C5.67157 21 5 20.3284 5 19.5V5C5 4.17157 5.67157 3.5 6.5 3.5Z"
          stroke="url(#dmLogoStroke)"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <path
          d="M14 3.5V8.5H19"
          stroke="#22D3EE"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="9.5" cy="13.5" r="1.4" fill="#A78BFA" />
        <circle cx="14.5" cy="13.5" r="1.4" fill="#22D3EE" />
        <circle cx="12" cy="17" r="1.4" fill="#F8FAFC" />
        <path
          d="M10.7 13.5H13.3M10.2 14.6L11.3 15.9M13.8 14.6L12.7 15.9"
          stroke="#94A3B8"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
        <defs>
          <linearGradient id="dmLogoStroke" x1="5" y1="3.5" x2="19" y2="21" gradientUnits="userSpaceOnUse">
            <stop stopColor="#A78BFA" />
            <stop offset="1" stopColor="#22D3EE" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );

  return (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap shrink-0">
      {animated ? (
        <motion.span
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="inline-flex"
        >
          {Mark}
        </motion.span>
      ) : (
        Mark
      )}
      {!compact && (
        <span className="font-display font-bold text-[18px] tracking-tight text-[var(--dm-text)] leading-none">
          Docu<span className="bg-gradient-to-r from-violet-400 to-cyan-300 bg-clip-text text-transparent">Mind</span>
        </span>
      )}
    </span>
  );
};
