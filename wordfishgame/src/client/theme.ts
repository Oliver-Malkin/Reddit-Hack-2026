/** Shared Memphis palette + color helpers, used by both the background and puzzle scenes. */

export const PALETTE = {
  offWhite: 0xf2f0e9,
  gridLine: 0xdcd8cd,
  pink: 0xff2f8f,
  cyan: 0x2ec4d6,
  yellow: 0xf5b727,
  navy: 0x2b2d6e,
  green: 0x27ae60,
  purple: 0x8e44ad,
  red: 0xef3b3b,
  ink: 0x1c1c1c,
};

export function cssColor(color: number, alpha = 1): string {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Chunky UI font stack for tiles and chips — matches the blocky Memphis look. */
export const UI_FONT = '"Arial Black", "Arial Bold", Arial, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
