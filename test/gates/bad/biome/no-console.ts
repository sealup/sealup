// Bites: noConsole in product code; output goes through `report`, the one redacting sink (R1).
// Placed at: src/plan/no-console.ts
// Expect: lint/suspicious/noConsole
export function shout(message: string): void {
  console.log(message);
}
