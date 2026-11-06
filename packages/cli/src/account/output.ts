// Output of the account commands. This file holds only the final line for now; the
// envelope with intermediate lines, the state catalog and the output guard grow here.

export const CLI_SCHEMA = "op8x.cli/1";

export type AccountCommand = "init";

/** The final JSON line of a run (JSON Lines, one object per line). */
export function finalLine(
  command: AccountCommand | null,
  state: string,
  exitCode: number,
  extra: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({ schema: CLI_SCHEMA, command, final: true, state, exit_code: exitCode, ...extra })}\n`;
}
