import { useId } from 'react';

type BrandLogoProps = {
  size?: 'sm' | 'md' | 'lg';
  variant?: 'full' | 'icon-only';
  className?: string;
};

const sizeMap = {
  sm: { width: 180, height: 56 },
  md: { width: 220, height: 70 },
  lg: { width: 280, height: 88 },
} as const;

export function BrandLogo({ size = 'md', variant = 'full', className = '' }: BrandLogoProps) {
  const id = useId().replace(/:/g, '');
  const { width, height } = sizeMap[size];

  const iconSize = size === 'sm' ? 42 : size === 'md' ? 54 : 66;
  const labelSize = size === 'sm' ? 16 : size === 'md' ? 18 : 22;
  const subtitleSize = size === 'sm' ? 8 : size === 'md' ? 9 : 11;

  if (variant === 'icon-only') {
    return (
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 120 120"
        role="img"
        aria-label="Astar Travels App logo"
        className={className}
      >
        <defs>
          <linearGradient id={`astar-gradient-${id}`} x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="#FF4E42" />
            <stop offset="100%" stopColor="#FF8F3D" />
          </linearGradient>
        </defs>

        <path
          d="M60 10L96 22L102 60L60 108L18 60L24 22L60 10Z"
          fill="rgba(18,20,24,0.82)"
          stroke="rgba(255,255,255,0.16)"
          strokeWidth="2"
        />
        <path
          d="M60 26L82 58H71L68 75H52L49 58H38L60 26ZM58 46H62L65 58H55L58 46Z"
          fill={`url(#astar-gradient-${id})`}
        />
        <path d="M34 82H86" stroke="rgba(255,255,255,0.8)" strokeWidth="4" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 220 70"
      role="img"
      aria-label="Astar Travels App"
      className={className}
    >
      <defs>
        <linearGradient id={`astar-gradient-${id}`} x1="0%" x2="100%" y1="0%" y2="100%">
          <stop offset="0%" stopColor="#FF4E42" />
          <stop offset="100%" stopColor="#FF8F3D" />
        </linearGradient>
      </defs>

      <g transform="translate(0 2)">
        <path
          d="M30 6L52 12L58 34L30 58L2 34L8 12L30 6Z"
          fill="rgba(18,20,24,0.88)"
          stroke="rgba(255,255,255,0.14)"
          strokeWidth="1.4"
          filter="drop-shadow(0 0 12px rgba(255,78,66,0.22))"
        />
        <path
          d="M30 15L41 33H34L31 41H29L26 33H19L30 15ZM28 24H32L34 30H26L28 24Z"
          fill={`url(#astar-gradient-${id})`}
        />
        <path d="M14 46H46" stroke="rgba(255,255,255,0.8)" strokeWidth="2.2" strokeLinecap="round" />
      </g>

      <g transform="translate(70 13)">
        <text
          x="0"
          y="18"
          fill="currentColor"
          className="text-slate-900 dark:text-white font-extrabold tracking-wider"
          fontSize={labelSize}
          fontWeight="800"
          letterSpacing="6"
          style={{ fontFamily: 'Inter, Segoe UI, Arial, sans-serif' }}
        >
          ASTAR
        </text>
        <rect x="1" y="24" width="94" height="16" rx="8" fill="rgba(255,255,255,0.04)" stroke="rgba(255,143,61,0.38)" />
        <text
          x="49"
          y="36"
          textAnchor="middle"
          fill="#FF8F3D"
          fontSize={subtitleSize}
          fontWeight="600"
          letterSpacing="2.6"
          style={{ fontFamily: 'Segoe UI, Arial, sans-serif' }}
        >
          TRAVELS
        </text>
      </g>
    </svg>
  );
}
