/**
 * Recognize a failing Node.js TAP report independently of the process exit
 * code. This is a backstop for wrappers/runtimes that accidentally return 0.
 */
export function hasTestFailures(output: string): boolean {
  return /(?:^|\r?\n)(?:not ok\s+\d+\b|# fail\s+[1-9]\d*(?:\s|$))/m.test(output);
}
