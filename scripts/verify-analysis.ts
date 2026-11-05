/**
 * Offline calibration check for the client-side analysis port.
 *
 * Run: npm run verify
 *
 * It parses the first eight games of the clean GM broadcast fixture and must
 * reproduce the Python anchors: score 22 / Low signal, 441 analysed moves,
 * ACPL 16.7 and accuracy 93.6.
 */
import fs from "node:fs";
import path from "node:path";

import {
  aggregateReport,
  computeGameMetrics,
  finalizeGames,
  parsePgnGames,
} from "../src/lib/analysis";
import type { GameMetrics } from "../src/lib/types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok  ${message}`);
}

function main(): void {
  const fixture = path.resolve("tests/fixtures/broadcast_round.pgn");
  const pgn = fs.readFileSync(fixture, "utf8");
  const games = parsePgnGames(pgn, 8);
  assert(games.length === 8, "parsed 8 games");
  assert(games.every((game) => game.moves.length > 0), "every game has moves");
  assert(
    games.some((game) => game.moves.some((move) => move.clock !== null)),
    "clock comments parsed",
  );
  assert(
    games.some((game) => game.moves.some((move) => move.eval_cp !== null)),
    "eval comments parsed",
  );

  const metrics: GameMetrics[] = games.map((game) => computeGameMetrics(game, "white"));
  finalizeGames(metrics);
  const report = aggregateReport(metrics, {
    username: "GM Broadcast Sample",
    profile: {},
    engineMode: "lichess",
    depth: 0,
    samples: 0,
    source: "demo",
  });

  const summary = report.summary;
  const m = summary.metrics;
  console.log(
    `\nScore ${summary.score} / ${summary.verdict} · raw_z ${summary.raw_z} · confidence ${summary.confidence} (${summary.confidence_label})`,
  );
  console.log(
    `Games ${m.games} · analysed ${m.analyzed_moves} · ACPL ${m.acpl} · accuracy ${m.accuracy}% · fast ${m.fast_accuracy}%`,
  );
  console.log(
    "Components: " +
      summary.components.map((c) => `${c.key}=${c.z}`).join(", "),
  );
  console.log(
    "Per game: " +
      report.games.map((g) => `${g.game_id}:${g.suspicion}`).join(", "),
  );

  assert(summary.score === 22, "score matches the 22 / Low anchor");
  assert(summary.verdict === "Low signal", "verdict matches the clean anchor");
  assert(m.games === 8, "aggregate game count is 8");
  assert(m.analyzed_moves === 441, "analysed move count is 441");
  assert(m.acpl === 16.7, "ACPL is 16.7");
  assert(m.accuracy === 93.6, "accuracy is 93.6");
  assert(m.fast_accuracy === 98.6, "fast accuracy is 98.6");

  const demoPath = path.resolve("public/demo_clean.json");
  if (fs.existsSync(demoPath)) {
    const demo = JSON.parse(fs.readFileSync(demoPath, "utf8"));
    assert(demo.summary.score === summary.score, "demo JSON score agrees with the port");
    assert(
      demo.summary.metrics.acpl === m.acpl,
      "demo JSON ACPL agrees with the port",
    );
  }

  console.log("\nAll calibration checks passed.");
}

try {
  main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
