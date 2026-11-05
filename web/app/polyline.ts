/**
 * Google's encoded-polyline format → [lat, lng] pairs for Leaflet.
 *
 * openrouteservice returns route geometry encoded at precision 5, which is ~1–8 KB for a
 * commute instead of the hundreds of coordinate pairs the GeoJSON form would carry.
 */
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const factor = 10 ** precision;
  const out: [number, number][] = [];
  let idx = 0;
  let lat = 0;
  let lng = 0;

  while (idx < encoded.length) {
    const deltas: number[] = [];
    for (let axis = 0; axis < 2; axis += 1) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(idx) - 63;
        idx += 1;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && idx < encoded.length);
      deltas.push(result & 1 ? ~(result >> 1) : result >> 1);
    }
    lat += deltas[0];
    lng += deltas[1];
    out.push([lat / factor, lng / factor]);
  }

  return out;
}
