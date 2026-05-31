# AI Auto Trader

Production-grade AI trading system: users describe strategies in plain English, Claude executes them against Binance (crypto) and Interactive Brokers (stocks), with paper/live modes, risk limits, and a Flutter dashboard.

**App name:** AI Auto Trader  
**Bundle ID:** `com.incredi.ai.auto.trader`

Built from the spec documents (`01`–`10` in this repo), including all nine new features from `10-new-features.md`.

## Stack

| Layer | Technology |
|-------|------------|
| Frontend | Flutter (Android + Web) |
| Backend | Firebase Cloud Functions v2 (Node.js 20) |
| Database | Cloud Firestore |
| Auth | Firebase Auth (email/password) |
| AI | Anthropic Claude (`claude-haiku-4-5`) |
| Secrets | Google Cloud Secret Manager |

## Project structure

```
autoTrader/
├── functions/          Cloud Functions backend (35 exported functions)
├── flutter_app/      Flutter client (Android + Web)
├── firestore.rules
├── firestore.indexes.json
├── firebase.json
└── 01-*.md … 10-*.md  Product & implementation specs
```

## Setup

### 1. Firebase project

1. Create a Firebase project (Blaze plan required for external API calls).
2. Enable Firestore (native mode, e.g. `europe-west1`), Auth (email/password), Cloud Functions, Cloud Scheduler, FCM, Secret Manager.
3. Run `firebase login` and `firebase use --add`.

### 2. Secrets (Google Cloud Secret Manager)

| Secret | Purpose |
|--------|---------|
| `anthropic_api_key` | Claude API |
| `newsdata_api_key` | News headlines |
| `fmp_api_key` | Earnings + macro calendar |
| `ibkr_client_id` / `ibkr_client_secret` | IBKR OAuth |
| `binance_apikey_{userId}` / `binance_apisecret_{userId}` | Per-user Binance keys |

For local emulator development, set env vars instead (see `functions/src/utils/secrets.js`).

### 3. Deploy backend

```bash
cd functions && npm install
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only functions
```

Configure Firestore TTL policies on `expireAt` fields (cycles, paper trades, idempotency keys, etc.) in GCP Console.

### 4. Flutter app

```bash
cd flutter_app
flutterfire configure   # generates firebase_options.dart
flutter pub get
flutter run             # Android
flutter run -d chrome   # Web
```

**Google Sign-In setup (required for launch):**
1. Firebase Console → Authentication → Sign-in method → enable **Google** and **Email/Password**
2. Copy the **Web client ID** (ends in `.apps.googleusercontent.com`) into `flutter_app/lib/constants/google_sign_in_config.dart`
3. Android: add your debug/release SHA-1 in Project settings → Your apps → Android app
4. Web: register a Web app in Firebase Console and run `flutterfire configure` for web `firebase_options.dart`

Web charts: `flutter build web --web-renderer canvaskit`

## Cloud Functions

**Scheduled:** `tradeLoopScheduled` (15 min), `priceMonitor`, `ibkrFillPoller`, `computeDailyStats`, `sendDailySummaries`, `cleanupExpiredData`, `autopilotAnalysis`, `refreshEarningsCalendar`, `refreshMacroCalendar`

**Triggers:** `tradeLoopOnPriceEvent`, `postMortemProcessor`

**Callables:** strategy setup, broker connect, emergency sell, manual cycle, analytics export, autopilot, Monte Carlo, replay, conflict resolution, admin actions, and more.

**HTTP:** `healthCheck` — uptime monitoring endpoint.

## New features (from spec 10)

1. **Strategy Performance Autopilot** — weekly Claude review with apply/reject proposals
2. **Natural Language Post-Mortems** — auto-generated trade analysis after significant wins/losses
3. **Multi-Strategy Conflict Detection** — detects opposing signals on same asset
4. **Shadow Mode** — A/B test strategy variants alongside live
5. **Monte Carlo Risk Simulation** — 1,000-path outcome distribution before going live
6. **Live Signals** — real-time indicator proximity gauges
7. **Replay Mode** — historical playback of strategy decisions
8. **Earnings Calendar** — IBKR earnings blackout + Claude warnings
9. **Macro Calendar** — high-impact economic events + blackout windows

## Local development

```bash
firebase emulators:start --only functions,firestore,auth
cd functions && npm run serve
```

Set emulator env vars: `ANTHROPIC_API_KEY`, `NEWSDATA_API_KEY`, `FMP_API_KEY`.

## Pre-live checklist

See `09-implementation-order.md` Phase 11. Minimum: 72 hours paper trading, idempotency verified, emergency sell tested, all Firestore indexes built.
