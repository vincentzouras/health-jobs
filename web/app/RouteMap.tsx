'use client';

import { useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import type { Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { decodePolyline } from './polyline';

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · routes by openrouteservice/OSRM';

/**
 * The drive from the pinned origin to one posting, drawn over OpenStreetMap tiles.
 *
 * Nothing is fetched from a routing or map API at view time: the Pi resolved the route once and
 * the polyline is already in the page. Leaflet is imported lazily and only once the card is
 * actually on screen, so a board of 50 jobs does not create 50 maps (or request 50 tile sets).
 */
export default function RouteMap({
  geometry,
  originLabel,
  destination,
  height = 140,
  interactive = false,
}: {
  geometry: string;
  originLabel: string | null;
  destination: string;
  height?: number;
  interactive?: boolean;
}) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = holderRef.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const el = holderRef.current;
    if (!el) return;
    let cancelled = false;

    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !holderRef.current) return;

      const points = decodePolyline(geometry);
      if (points.length < 2) return;

      mapRef.current?.remove();
      const map = L.map(holderRef.current, {
        scrollWheelZoom: false,
        dragging: interactive,
        touchZoom: interactive,
        doubleClickZoom: interactive,
        boxZoom: false,
        keyboard: false,
        zoomControl: interactive,
        attributionControl: true,
        // Matches the tile layer: without this a very short drive fits at a zoom with no tiles.
        maxZoom: 18,
      });
      mapRef.current = map;

      L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 18 }).addTo(map);

      const start = points[0];
      const end = points[points.length - 1];
      L.polyline(points, { color: '#1f6feb', weight: 4, opacity: 0.9 }).addTo(map);
      L.circleMarker(start, {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: '#1a7f4b',
        fillOpacity: 1,
      })
        .addTo(map)
        .bindTooltip(originLabel ?? 'Start', { direction: 'top' });
      L.circleMarker(end, {
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: '#1f6feb',
        fillOpacity: 1,
      })
        .addTo(map)
        .bindTooltip(destination, { direction: 'top' });

      map.fitBounds(L.latLngBounds(points), { padding: [16, 16] });
      // The card may have been laid out after the map was created (fonts, flexible rows).
      setTimeout(() => map.invalidateSize(), 0);
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [visible, geometry, originLabel, destination, interactive]);

  return (
    <Box
      sx={{
        position: 'relative',
        height,
        borderRadius: 1,
        border: 1,
        borderColor: 'divider',
        overflow: 'hidden',
        bgcolor: 'action.hover',
      }}
    >
      <Box ref={holderRef} sx={{ position: 'absolute', inset: 0 }} />
      {!visible && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}
        >
          Map
        </Typography>
      )}
    </Box>
  );
}
