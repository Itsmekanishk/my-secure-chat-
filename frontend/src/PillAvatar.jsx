import React from 'react';

export function PillAvatar({ color1, color2, symbol, size = 48, className = "" }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" width={size} height={size} className={className}>
      <rect x="4.8" y="16.8" width="38.4" height="14.4" rx="7.2" fill="none" stroke={color1} strokeWidth="1.2"/>
      <rect x="4.8" y="16.8" width="19.2" height="14.4" rx="7.2" fill={`${color1}22`}/>
      <line x1="24" y1="16.8" x2="24" y2="31.2" stroke={color1} strokeWidth="1.2"/>
      <circle cx="14.4" cy="24" r="2.88" fill={color1} opacity="0.8"/>
      <circle cx="33.6" cy="24" r="2.88" fill={color2} opacity="0.8"/>
      <text x="24" y="13.44" textAnchor="middle" fontFamily="'Bebas Neue',sans-serif" fontSize="6.72" fill={color1} opacity="0.7">{symbol}</text>
    </svg>
  );
}
