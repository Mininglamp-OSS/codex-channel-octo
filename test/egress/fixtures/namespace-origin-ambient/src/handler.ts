import type { Box } from './shape.js';
export function f(x: Box, key: string) {
  const y = x as unknown as Record<string, { sendMessage: () => void }>;
  y[key]?.sendMessage();
}
