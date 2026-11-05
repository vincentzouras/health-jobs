/**
 * The two job clusters. Kept out of `lib/db.ts` because that module imports `pg`, and the
 * board is a client component: importing a value from it drags the driver into the browser
 * bundle (webpack fails on it outright).
 */
export type Area = 'york' | 'west_chester';

export const AREAS: Area[] = ['york', 'west_chester'];

export const AREA_LABEL: Record<Area, string> = {
  york: 'York',
  west_chester: 'West Chester',
};

export function isArea(value: unknown): value is Area {
  return value === 'york' || value === 'west_chester';
}
