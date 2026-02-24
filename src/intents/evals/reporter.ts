import type { EvalResult, EvalRunResult } from './types.js';

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

export function printReport(run: EvalRunResult): void {
  const { summary } = run;

  console.log(`\n${BOLD}=== Intent Eval Run ===${RESET}`);
  console.log(`Model:       ${run.model} (${run.provider})`);
  console.log(`Prompt hash: ${run.promptHash}`);
  console.log(`Source:      ${run.source}`);
  console.log(`Time:        ${run.timestamp}`);

  if (Object.keys(summary.byTag).length > 0) {
    console.log(`\nResults by tag:`);
    for (const [tag, stats] of Object.entries(summary.byTag)) {
      const pct = Math.round(stats.passRate * 100);
      const passedStr = String(stats.passed).padStart(2);
      const totalStr  = String(stats.total).padStart(2);
      const tagCases  = run.cases.filter((c) => c.tags.includes(tag));
      const avgTagScore =
        tagCases.length > 0
          ? tagCases.reduce((sum, c) => sum + c.score, 0) / tagCases.length
          : 0;
      const isLow = pct < 80;
      const color = pct === 100 ? GREEN : pct >= 80 ? YELLOW : RED;
      const regressionNote = isLow ? `  ${RED}← REGRESSION${RESET}` : '';
      console.log(
        `  ${CYAN}${tag.padEnd(14)}${RESET} ${color}${passedStr}/${totalStr}  ${String(pct).padStart(3)}%${RESET}  avg ${avgTagScore.toFixed(2)}${regressionNote}`,
      );
    }
  }

  const overallPct = Math.round(summary.passRate * 100);
  const overallColor = overallPct === 100 ? GREEN : overallPct >= 80 ? YELLOW : RED;
  console.log(
    `\n${BOLD}Overall: ${overallColor}${summary.passed}/${summary.total} passed (${overallPct}%)${RESET}${BOLD}  avg score: ${summary.avgScore.toFixed(2)}${RESET}`,
  );
  if (summary.hardFails > 0) {
    console.log(`${RED}Hard fails: ${summary.hardFails}${RESET}`);
  }

  const failures = run.cases.filter((c) => !c.passed);
  if (failures.length > 0) {
    console.log(`\nFailures (${failures.length}):`);
    for (const r of failures) {
      const hardLabel = r.hardFail ? `${RED}[HARD] ${RESET}` : '';
      const tagStr = r.tags.length > 0 ? ` (${r.tags.join(', ')})` : '';
      console.log(`  ${RED}✗${RESET} ${hardLabel}${r.caseId}${tagStr}`);
      console.log(`      ${r.description}`);
      if (r.hardFail && r.hardFailFields.length > 0) {
        console.log(`      Hard fail: ${r.hardFailFields.join(', ')}`);
      }
      if (r.error != null) {
        console.log(`      Error: ${r.error}`);
      } else {
        console.log(`      Score: ${r.score.toFixed(2)}  Expected: ${r.expectedDecision} | Got: ${r.actualDecision}`);
      }
      console.log('');
    }
  }
}

export function diffRuns(baseline: EvalRunResult, current: EvalRunResult): string {
  const lines: string[] = [];

  const baseRate = Math.round(baseline.summary.passRate * 100);
  const currRate = Math.round(current.summary.passRate * 100);
  const delta = currRate - baseRate;
  const deltaStr =
    delta > 0
      ? `${GREEN}+${delta}%${RESET}`
      : delta < 0
        ? `${RED}${delta}%${RESET}`
        : `${YELLOW}no change${RESET}`;

  lines.push(`\n${BOLD}=== Run Diff ===${RESET}`);
  lines.push(`Baseline: ${baseline.model} @ ${baseline.timestamp.slice(0, 10)}  ${baseRate}% pass`);
  lines.push(`Current:  ${current.model} @ ${current.timestamp.slice(0, 10)}  ${currRate}% pass`);
  lines.push(`Pass rate change: ${deltaStr}`);

  const baseById = new Map(baseline.cases.map((c) => [c.caseId, c]));
  const currById = new Map(current.cases.map((c) => [c.caseId, c]));

  const regressions: EvalResult[] = [];
  const improvements: EvalResult[] = [];

  for (const [id, curr] of currById) {
    const base = baseById.get(id);
    if (!base) continue;
    if (base.passed && !curr.passed) regressions.push(curr);
    if (!base.passed && curr.passed) improvements.push(curr);
  }

  if (regressions.length > 0) {
    lines.push(`\n${RED}Regressions (${regressions.length}):${RESET}`);
    for (const r of regressions) {
      lines.push(`  ${RED}✗${RESET} ${r.caseId} — ${r.description}`);
      lines.push(`      Expected: ${r.expectedDecision} | Got: ${r.actualDecision}`);
    }
  }

  if (improvements.length > 0) {
    lines.push(`\n${GREEN}Improvements (${improvements.length}):${RESET}`);
    for (const r of improvements) {
      lines.push(`  ${GREEN}✓${RESET} ${r.caseId} — ${r.description}`);
      lines.push(`      Now passing: ${r.actualDecision}`);
    }
  }

  if (regressions.length === 0 && improvements.length === 0) {
    lines.push(`\nNo cases changed between runs.`);
  }

  return lines.join('\n');
}
