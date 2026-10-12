// The wordmark at a stable path, /brand/sealup-wordmark.svg (spec sealup/sealup-private#88
// decision 27): the README loads it from here, on GitHub and on npm. Built from the one source the
// header uses, so the two never differ.

import wordmark from '../../assets/sealup-wordmark.svg?raw';

export const GET = (): Response =>
  new Response(wordmark, { headers: { 'Content-Type': 'image/svg+xml' } });
