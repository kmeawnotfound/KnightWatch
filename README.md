# KnightWatch

A client-side fair-play scanner for Lichess and Chess.com games. It downloads a player's game history (or accepts a PGN), evaluates positions with **Stockfish 19 Lite compiled to WebAssembly**, and compares the player's accuracy, centipawn loss, move timing, and results against rating-appropriate baselines.

**Everything runs in the browser.** There is no application server, no server-side credentials, and no server-side report storage. The deployed app is a static Vite build that can be hosted on Vercel.

**It produces a statistical signal, not a verdict.** Strong players, fast time controls, small samples, and unusual openings can all produce high scores. No score here is proof of cheating, and the app is not affiliated with Lichess or Chess.com.

- **Source:** <https://github.com/kmeawnotfound/KnightWatch>
- **Live:** <https://knightwatch-one.vercel.app>

---

## Quick start

```powershell
npm install
npm run dev
```

Open <http://127.0.0.1:5173>.

Production build and preview:

```powershell
npm run build
npm run preview
```

The built site is in `dist/`.

### Deploy to Vercel

1. Push this repository to GitHub (or run `vercel` from the project root).
2. Import the project in Vercel. The included `vercel.json` sets:
   - framework: `vite`
   - build command: `npm run build`
   - output directory: `dist`
3. Deploy. No environment variables are required.

The only runtime network calls are direct browser requests to `lichess.org` (profile, game export, optional cloud evaluation), `api.chess.com` (public profile and game archives), and same-origin requests for the bundled Stockfish WASM assets.

---

## Four ways to use it

### 1. Lichess scan

Enter a username, pick a time control and game count, and start the scan. No account or login is required. **All standard** is the default time control; bullet, blitz, rapid, classical, UltraBullet, and correspondence are also available. The browser:

1. loads the player's public profile and rating from Lichess;
2. streams their games as NDJSON (with clocks and any existing Lichess analysis);
3. runs a pool of single-threaded Stockfish WASM workers over sampled positions;
4. scores each game and the overall sample.

Games that already contain Lichess analysis keep their existing accuracy and ACPL; the browser still samples positions locally to estimate top-move agreement. **Existing Lichess analysis only** skips local evaluation entirely.

Reports are saved in this browser's IndexedDB. Reopen one with `?job=<report-id>` while it is still stored locally, or from the **Saved reports** library. Exports are generated in the browser as JSON, CSV, or a self-contained HTML document.

### 2. Chess.com scan

No account, password, or login is required. Enter a Chess.com username, choose a time control (default **All standard**) and how many games to scan. The browser:

1. loads the public profile from `api.chess.com`;
2. walks the player's monthly game archives newest-first, keeping standard rated games that match the chosen time class;
3. parses the embedded PGN (clocks included) and analyses it with Stockfish WASM;
4. scores each game and the overall sample.

Chess.com's public API returns at most the last 12 months of archives in a scan. Daily games are mapped to correspondence speed, and unrated games are excluded unless you tick **Include unrated games**.

### 3. Paste PGN

No account required. Lichess-style `[%eval ...]` and `[%clk ...]` comments are used when present; otherwise the browser analyses with Stockfish WASM. Leave **Player to analyse** blank to analyse White in every game.

### 4. Demo reports

Two precomputed reports ship with the app:

- **Clean control** — eight real classical games from a public Lichess broadcast. Scores **22 / 100 (Low signal)**.
- **Synthetic suspect** — six generated games where Black plays strong engine moves in under two seconds. Scores **89 / 100 (Very high signal)**. The player is not real.

These exist so you can explore the UI and sanity-check the scoring without an account.

---

## Reviewing a report

Every report includes a set of review tools, all running locally against the stored move data:

- **Interactive board.** Open any game row to replay it on a chessboard with the played move and, when available, the engine's preferred move drawn as arrows. Step with the on-screen controls or the arrow keys, jump to any move in the move list, and flip the board. The evaluation, clock time, and judgment for the current move are shown beside the board. You can also play moves on the board: drag a piece or tap a piece and then a destination. Legal targets are marked, checks are highlighted, and promotions open a piece picker. Playing the game's actual next move advances the review; any other legal move starts a variation with undo and reset controls. Stepping through moves scrolls only the move list, so the board stays in place.
- **Critical moments.** Two shortlists rank the decisions that matter most: **Costly decisions** (largest centipawn losses, weighted toward tense positions) and **Fast engine matches** (engine-best moves played quickly in balanced positions). Clicking a row opens the board at that exact move.
- **Think time vs position tension.** A scatter plot of the player's moves, with think time on a logarithmic axis and a "tension" score on the other (balanced positions rank higher than already-decided ones). Summary stats compare average time in tense versus clear positions, and **Instant strong moves** lists the fastest strong decisions in tense positions.
- **Export and import.** Export the report as JSON (re-importable), CSV (per-game table), or a **self-contained HTML file** with the score, verdict, reasons, critical moments, and game table — no scripts, no external assets. Import a previously exported JSON report to load and store it again.
- **Saved reports library.** The **Saved reports** button lists every report stored in this browser, with open, export, and delete actions. Select any two reports to compare them side by side: headline metrics plus per-component z-score deltas, so you can see what changed between scans.
- **Works on phones.** The layout is responsive down to 320px: the input panel, summary, charts, tables, and comparison view reflow for narrow screens, the game and library modals go full-screen with safe-area padding, and the board scales with large tap targets for pieces and controls. On small screens only the external Lichess, Chess.com, and GitHub links are hidden; everything else, including saved reports, stays available.

---

## Performance and engine configuration

The browser engine uses one single-threaded Stockfish WASM worker per logical CPU except one, capped at eight workers for browser stability. At the shallow-to-mid depths used here, several independent single-threaded searches finish a batch of games faster than one multi-threaded search.

- **Workers:** `navigator.hardwareConcurrency - 1`, capped at 8. Devices reporting 4 GB of RAM or less are capped at 4 workers.
- **Hash:** up to ~1 GB total across workers, split evenly, with a 16 MB minimum per worker.
- **Defaults:** depth 12 and 12 sampled positions per game. Raise depth for stronger analysis; lower it for speed.
- **Engine mode:** `Auto` uses local Stockfish, `Cloud` uses Lichess cloud evaluation (throttled and cached), and `Existing Lichess analysis only` skips local search.

All analysis is CPU-bound in the browser. A phone or low-power laptop will be much slower than a desktop. The worker pool starts warming as soon as you focus a scan field, is reused across scans, and is released after two idle minutes. The WASM assets are cached by the browser after the first load.

---

## How the score works

The overall score is a weighted average of transparent z-score components, then shrunk toward a neutral value when the sample is small or engine coverage is poor.

| Component | What it measures | Default weight |
| --- | --- | --- |
| Average centipawn loss | How much evaluation the player gives up per move, versus a rating baseline | 0.95 |
| Accuracy | Win-probability-based accuracy, versus a rating baseline | 0.55 |
| Engine top-move agreement | How often the player matches the engine's first choice | 0.40 |
| Fast-move accuracy | Accuracy on moves played quickly, including the fast/slow gap | 0.45 |
| Rating performance | Elo performance versus the player's own rating | 0.22 |
| Think-time uniformity | Whether think times are unusually machine-like | 0.10 |
| Winning streak | Longest streak in the sample | 0.08 |

Per-game accuracy follows Lichess's method: the mean of a volatility-weighted mean and a harmonic mean of per-move accuracy. The harmonic term keeps a few bad moves from being hidden by a long tail of quiet ones. When only a sample of positions is evaluated, accuracy and ACPL are estimates rather than exact full-game values.

Rating and time-control baselines are interpolated from anchor tables in `src/lib/analysis.ts`. The output includes:

- a 0–100 signal score and a verdict band (`Low signal` … `Very high signal`);
- a confidence value driven by game count, analysed moves, and engine coverage;
- the individual components with their z-scores;
- plain-English reasons for the strongest signals;
- per-game metrics and a move-by-move review.

### Calibration

The bundled demos are the calibration reference:

- real GM classical games: **22 / Low signal**;
- synthetic engine-assisted blitz: **89 / Very high signal**.

The client-side analysis port is checked against the Python implementation with:

```powershell
npm run verify
```

It parses the first eight games of `tests/fixtures/broadcast_round.pgn`, runs the TypeScript metrics/scoring pipeline, and asserts score **22**, **441** analysed moves, ACPL **16.7**, accuracy **93.6%**, and fast accuracy **98.6%**. It also checks that the HTML export contains the verdict, disclaimer, and critical moments, and that the suspect demo still scores **89** with ranked critical finds.

### What it cannot do

- Prove cheating.
- Detect pre-move or outside assistance directly.
- Judge openings or psychology.
- Compensate fully for sandbagging, new accounts, or mixed time controls.
- Replace a human review of the actual games.

Treat it as a triage tool: it ranks games and highlights patterns worth a closer look.

---

## Project layout

```
index.html                 single-page dashboard (Vite entry)
src/
  styles.css               dark theme
  ui/                      typed UI modules
    main.ts                bootstrap and event wiring
    state.ts               shared UI state and job manager
    els.ts / dom.ts        cached element refs and DOM helpers
    scan.ts                Lichess, Chess.com, PGN, and demo entry points
    progress.ts            progress panel, polling, cancel/new scan
    report.ts              report orchestration (gauge, metrics, reasons)
    games.ts               sortable/filterable game table
    modal.ts               game review modal and move stepping
    board.ts               chess.js replay and board rendering
    chart.ts               game, evaluation, and timing charts
    critical.ts            critical-moments shortlists
    timing.ts              think-time vs tension analysis
    library.ts             saved reports and report comparison
    share.ts               JSON/CSV/HTML export and JSON import
    engine-status.ts       engine pill and warm-up
    notify.ts              error banner and toast
    view-types.ts          report-move view types
  lib/
    analysis.ts            parsing, metrics, scoring, reasons
    chess-utils.ts         SAN/UCI helpers, eval/clock parsing, statistics
    highlights.ts          critical-moment ranking and tension heuristics
    engine.ts              Stockfish WASM worker wrapper and pool
    lichess.ts             Lichess profile/export client and cloud evaluator
    chesscom.ts            Chess.com public API client
    jobs.ts                client-side job manager and progress
    storage.ts             IndexedDB report storage
    export.ts              JSON/CSV/HTML export
    types.ts               shared interfaces
public/
  engine/                  Stockfish 19 Lite WASM + GPL license
  demo_clean.json          precomputed clean report
  demo_suspect.json        precomputed synthetic report
scripts/
  verify-analysis.ts       offline calibration check (npm run verify)
  make_demo.py             legacy demo builder (Python)
  calibrate_players.py     legacy real-player calibration run (Python)
tests/fixtures/
  broadcast_round.pgn      real GM games used for calibration
  synthetic_cheater.ndjson legacy synthetic fixture
app/                       legacy FastAPI implementation (reference only)
```

The legacy FastAPI app in `app/`, `static/`, and `run.ps1`/`run.bat` is kept for reference and Python calibration. The deployed Vite app does not import or call it.

---

## Troubleshooting

**A Lichess scan is rate-limited** — anonymous exports stream at 20 games per second. Wait a minute and retry, or scan fewer games.

**The engine pill says WebAssembly is unavailable** — use a current version of Chrome, Edge, Firefox, or Safari. The WASM assets must be served from the same origin.

**A scan is slow** — reduce depth, reduce positions per game, or scan fewer games. The browser uses all available CPU cores except one, so other tabs and applications will compete for the same CPU.

**A scan reports low confidence** — the sample is small, few moves had engine evaluations, or clock data was missing. Scan more games or raise the sample size.

**PGN import skips games** — only standard chess is scored. Variants, games without moves, and games where the chosen player does not appear are skipped.

**Chess.com says no games were found** — the account may have no public standard games in the last 12 months, the chosen time control may be empty, or unrated games may be excluded. Try **All standard**, tick **Include unrated games**, or raise the game count.

**Chess.com returns HTTP 429** — the public API is rate-limiting you. Wait a minute and retry, or scan fewer games.

**A saved report is missing** — reports live in this browser profile's IndexedDB. Clearing site data, using a private window, or switching browsers removes them.

**Cloud eval is slow** — Lichess cloud eval only covers popular positions and is throttled to about one request per second. Use local Stockfish for large scans.

---

## License and attribution

KnightWatch is built on the public [Lichess API](https://lichess.org/api), the [Chess.com public API](https://www.chess.com/news/view/published-data-api), and [Stockfish](https://stockfishchess.org/). Stockfish is GPLv3; the license text is bundled at `public/engine/Copying.txt`. The app is not affiliated with or endorsed by Lichess or Chess.com. Use it responsibly and respect their terms of service and rate limits.
