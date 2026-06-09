/**
 * Shared Wow TUI color palette.
 */

export type ColorFn = (s: string) => string;

export function rgb(r: number, g: number, b: number): ColorFn {
  return (s: string) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}

export const GREEN = rgb(0x1f, 0xaf, 0x7a);
export const YELLOW = rgb(0xc9, 0xa8, 0x4c);
export const RED = rgb(0xe8, 0x63, 0x4f);
export const BLUE = rgb(0x17, 0xda, 0xe7);
export const PURPLE = rgb(0x7a, 0x5e, 0xa0);
export const ORANGE = rgb(0xf5, 0xa7, 0x42);
export const EXECUTE_BLUE = rgb(0x5c, 0x9c, 0xf5);
export const DIM = rgb(0x66, 0x66, 0x66);
