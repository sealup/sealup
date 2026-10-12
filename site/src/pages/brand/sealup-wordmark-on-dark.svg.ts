// The wordmark for dark backgrounds at a stable path, /brand/sealup-wordmark-on-dark.svg (spec
// sealup/sealup-private#88 decision 27): the README's <picture> gives it to GitHub's dark mode.
// Built from the one source the header uses, so the two never differ.

import wordmark from '../../assets/sealup-wordmark-on-dark.svg?raw';

export const GET = (): Response =>
  new Response(wordmark, { headers: { 'Content-Type': 'image/svg+xml' } });
