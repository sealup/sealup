// Bites: the recommended preset is on (noDebugger is one of its rules).
// Placed at: src/plan/no-debugger.ts
// Expect: lint/suspicious/noDebugger
export function stop(): void {
  debugger;
}
