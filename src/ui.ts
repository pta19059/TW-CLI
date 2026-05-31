// Tiny zero-dependency UI helpers (ANSI colors + spinner) used by the
// interactive REPL and one-shot mode. Designed to mimic the look-and-feel
// of GitHub Copilot CLI without pulling in chalk/ora.

const isTty = process.stdout.isTTY === true && !process.env.NO_COLOR;

function wrap(code: string, text: string): string {
  if (!isTty) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

export const color = {
  dim: (t: string) => wrap("2", t),
  bold: (t: string) => wrap("1", t),
  red: (t: string) => wrap("31", t),
  green: (t: string) => wrap("32", t),
  yellow: (t: string) => wrap("33", t),
  blue: (t: string) => wrap("34", t),
  magenta: (t: string) => wrap("35", t),
  cyan: (t: string) => wrap("36", t),
  gray: (t: string) => wrap("90", t)
};

export interface Spinner {
  stop(finalText?: string): void;
  update(text: string): void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function startSpinner(text: string): Spinner {
  if (!isTty) {
    process.stdout.write(`${text}\n`);
    return {
      stop: (finalText) => {
        if (finalText) process.stdout.write(`${finalText}\n`);
      },
      update: (next) => process.stdout.write(`${next}\n`)
    };
  }

  let currentText = text;
  let frame = 0;
  const render = () => {
    process.stdout.write(`\r\u001b[2K${color.cyan(SPINNER_FRAMES[frame])} ${currentText}`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  };
  render();
  const handle = setInterval(render, 80);

  return {
    stop(finalText?: string) {
      clearInterval(handle);
      process.stdout.write(`\r\u001b[2K`);
      if (finalText) process.stdout.write(`${finalText}\n`);
    },
    update(next: string) {
      currentText = next;
    }
  };
}

export function banner(lines: string[]): string {
  const width = Math.max(...lines.map((l) => l.length));
  const top = color.gray(`╭${"─".repeat(width + 2)}╮`);
  const bottom = color.gray(`╰${"─".repeat(width + 2)}╯`);
  const body = lines.map((l) => color.gray("│ ") + l + " ".repeat(width - l.length) + color.gray(" │"));
  return [top, ...body, bottom].join("\n");
}
