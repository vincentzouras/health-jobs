/**
 * Per-employer chip colours. Employers are ranked by when the scan first saw them, so the
 * index for an existing employer never changes as new sources are added, and the golden
 * angle puts consecutive employers on maximally different hues.
 */
const GOLDEN_ANGLE = 137.508;

export interface EmployerColor {
  bg: string;
  fg: string;
  border: string;
  dot: string;
}

export function employerColor(index: number): EmployerColor {
  const hue = Math.round((index * GOLDEN_ANGLE) % 360);
  return {
    bg: `hsl(${hue}, 72%, 95%)`,
    fg: `hsl(${hue}, 62%, 26%)`,
    border: `hsl(${hue}, 45%, 79%)`,
    dot: `hsl(${hue}, 62%, 52%)`,
  };
}
