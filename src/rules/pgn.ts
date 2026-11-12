import type { Outcome } from "./position.js";

// The SAN in PGN move text, e.g. "1. e4 e5 2. Nf3" or "1...e5", skipping move numbers, comments, variations, NAGs
// and the result
export const parseMoveText = (text: string): string[] => {
  const sans: string[] = [];
  // Comments and variations removed first, as they can hold spaces; variations can nest
  let stripped = text.replace(/\{[^}]*\}/g, " ").replace(/;[^\n]*/g, " ");
  let previous = "";
  while (previous !== stripped) {
    previous = stripped;
    stripped = stripped.replace(/\([^()]*\)/g, " ");
  }
  for (const token of stripped.split(/\s+/)) {
    const move = token.replace(/^\d+\.+/, "");
    if (move === "" || /^\$\d+$/.test(move) || ["*", "1-0", "0-1", "1/2-1/2"].includes(move)) {
      continue;
    }
    sans.push(move);
  }
  return sans;
}

export const makeOutcome = (outcome: Outcome | undefined): string => {
  if (outcome === undefined) return "*";
  if (outcome.winner === undefined) return "1/2-1/2";
  return (outcome.winner === "white") ? "1-0" : "0-1";
}

// Seconds as H:MM:SS, for [%emt] and [%clk]
export const makeClock = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(whole / 3600)}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}`;
}

export interface PgnMove {
  san: string,
  // A comment after the move, without braces
  comment?: string
}

// A PGN: the tags in order, a blank line, then the moves numbered from `fullmoves` with `turn` to play first, and the
// result
export const writePgn = (headers: Map<string, string>, moves: PgnMove[], turn: "white" | "black", fullmoves: number,
  result: string): string => {
  const lines = [...headers].map(([key, value]) => `[${key} "${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`);
  const tokens: string[] = [];
  let white = turn === "white";
  let number = fullmoves;
  moves.forEach(({ san, comment }, index) => {
    if (white) {
      tokens.push(`${number}.`);
    } else if (index === 0) {
      tokens.push(`${number}...`);
    }
    tokens.push(san);
    if (comment !== undefined) {
      tokens.push(`{ ${comment} }`);
    }
    if (!white) number += 1;
    white = !white;
  });
  tokens.push(result);
  return `${lines.join("\n")}\n\n${tokens.join(" ")}\n`;
}
