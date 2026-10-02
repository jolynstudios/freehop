// The illustration palette. Flat fills only: no gradients, no shadows, no transparency.
export const C = {
  yellow: '#ffe600',
  azure: '#007fff',
  coral: '#ef3b2c',
  ink: '#333333',
  white: '#ffffff',
} as const;

// Chunky outlines: every primitive draws its outline with this weight (in viewBox units).
export const STROKE = 4;

export const line = {
  stroke: C.ink,
  strokeWidth: STROKE,
  strokeLinejoin: 'round' as const,
  strokeLinecap: 'round' as const,
};

export const DISPLAY_FONT = "'Changa One', 'Bebas Neue', Impact, sans-serif";
