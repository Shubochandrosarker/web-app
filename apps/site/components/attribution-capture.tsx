'use client';

import { useEffect } from 'react';
import { captureAttribution } from '@/lib/attribution';

/**
 * Records the visit's first and last touch, once per page.
 *
 * A client component containing no markup: it renders nothing, so it adds no
 * DOM and cannot shift layout. All it does is run one function after paint,
 * which is deliberate — attribution is not worth a millisecond of the largest
 * contentful paint.
 */
export function AttributionCapture() {
  useEffect(() => {
    captureAttribution();
  }, []);

  return null;
}
