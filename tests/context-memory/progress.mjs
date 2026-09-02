/**
 * Live progress rendering for the two credentialed qualification commands
 * (#227). A scored run takes the better part of an hour against real
 * gateways, and its report is written only at the end, so without this the
 * operator cannot tell a working run from a stalled one.
 *
 * Everything here writes to **stderr**: the report stays on stdout, clean and
 * pipeable. When stderr is not a TTY the renderer degrades to plain appended
 * lines, so redirecting to a file produces a readable log rather than a mess
 * of carriage returns.
 *
 * Errors are never summarised away — each one prints immediately, in full
 * enough form to act on, because a run that fails at minute forty should not
 * make the operator wait until minute fifty-eight to learn why.
 */

const TTY = Boolean(process.stderr.isTTY);
const CSI = "[";
const paint = (code, text) => (TTY ? `${CSI}${code}m${text}${CSI}0m` : text);
const dim = (t) => paint(2, t);
const bold = (t) => paint(1, t);
const red = (t) => paint(31, t);
const green = (t) => paint(32, t);
const yellow = (t) => paint(33, t);

function clock(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Human-readable remaining time from the mean of what has completed. */
function eta(doneCount, totalCount, elapsedMs) {
  if (doneCount === 0) return "--:--";
  return clock((elapsedMs / doneCount) * (totalCount - doneCount));
}

function write(line) {
  process.stderr.write(line);
}

/** Overwrite the current line on a TTY; append a fresh line otherwise. */
function status(line) {
  if (TTY) write(`\r${CSI}2K${line}`);
  else write(`${line}\n`);
}

/** Finish the transient line so the next permanent line starts clean. */
function endStatus() {
  if (TTY) write("\n");
}

/**
 * Continuity matrix renderer: one live line per run showing turn progress,
 * one permanent line per finished run, and an immediate line per failing
 * turn. Returns the `onEvent` handler `runQualification` expects.
 */
export function continuityProgress() {
  const startedAt = Date.now();
  let total = 0;
  let finished = 0;
  let okRuns = 0;
  let turnErrors = 0;
  let current = null;

  return (event) => {
    if (event.type === "matrix-start") {
      total = event.total;
      write(`${bold("Context Memory continuity qualification")} — ${total} runs\n`);
      write(dim("progress on stderr; the report goes to stdout\n\n"));
      return;
    }
    if (event.type === "run-start") {
      current = `${event.run.scenario}/${event.run.variant}/${event.run.arm}`;
      status(`${dim(`[${event.index + 1}/${event.total}]`)} ${current} ${dim("starting")}`);
      return;
    }
    if (event.type === "turn") {
      if (event.record?.error) {
        turnErrors += 1;
        endStatus();
        write(`  ${red("✗")} ${current} ${bold(event.turn)}: ${event.record.error}\n`);
      }
      const marks = `${event.index}/${event.total}`;
      status(`${dim(`[${finished + 1}/${total}]`)} ${current} ${dim(`turn ${marks}`)} ${dim(`· ${clock(Date.now() - startedAt)} elapsed`)}`);
      return;
    }
    if (event.type === "run-end") {
      finished += 1;
      if (event.score.ok) okRuns += 1;
      const s = event.score;
      const critical = s.critical.total === 0 ? 100 : Math.round((s.critical.matched / s.critical.total) * 100);
      const continuity = s.continuity.total === 0 ? 100 : Math.round((s.continuity.matched / s.continuity.total) * 100);
      const mark = s.ok ? green("✓") : yellow("•");
      const schedule = `${s.schedule.appends}a/${s.schedule.rebuilds}r`;
      endStatus();
      write(
        `${mark} ${dim(`[${finished}/${total}]`)} ${current.padEnd(42)} `
        + `${schedule.padEnd(6)} crit ${String(critical).padStart(3)}% cont ${String(continuity).padStart(3)}% `
        + `${s.finalTask ? "final✓" : "final✗"} ${s.severeTotal > 0 ? red(`severe ${s.severeTotal}`) : dim("severe 0")} `
        + `${dim(clock(event.elapsedMs))} ${dim(`eta ${eta(finished, total, Date.now() - startedAt)}`)}\n`,
      );
      for (const failure of s.hardCheckFailures) {
        write(`    ${red("↳")} ${failure.family}/${failure.id}: ${String(failure.message ?? "").slice(0, 150)}\n`);
      }
      return;
    }
    if (event.type === "matrix-end") {
      write(
        `\n${bold("matrix complete")} — ${okRuns}/${total} runs passed, `
        + `${turnErrors} turn errors, ${clock(Date.now() - startedAt)} elapsed\n\n`,
      );
    }
  };
}

/**
 * Cache experiment renderer: one line per request with the cache numbers as
 * they arrive, so a dead measurement (every arm reading the same constant) is
 * visible while the run is still going rather than only in the verdict.
 */
export function cacheProgress() {
  const startedAt = Date.now();
  let lastGroup = 0;

  return (event) => {
    if (event.type !== "request") return;
    if (event.group !== lastGroup) {
      lastGroup = event.group;
      write(`${bold(`group ${event.group}`)}\n`);
    }
    const label = `${event.arm}.${event.role}`.padEnd(14);
    if (event.error) {
      write(`  ${red("✗")} ${label} ${red(event.error)}\n`);
      return;
    }
    const ttft = event.ttftMs === undefined ? dim("ttft --") : dim(`ttft ${String(event.ttftMs).padStart(5)}ms`);
    write(
      `  ${green("✓")} ${label} read ${String(event.cacheRead).padStart(6)} `
      + `write ${String(event.cacheWrite).padStart(6)} uncached ${String(event.uncached).padStart(5)} ${ttft} `
      + `${dim(`[${event.index}/${event.total}] ${clock(Date.now() - startedAt)}`)}\n`,
    );
  };
}
