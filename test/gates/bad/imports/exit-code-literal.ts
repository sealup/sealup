// Bites: an exit code written as a bare number instead of through ExitCode.
// Placed at: src/cli/finish.ts
// Expect: exit-code-literal
export function finish(): void {
  process.exitCode = 6;
}
