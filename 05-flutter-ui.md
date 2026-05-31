# Flutter UI Spec
## Version: Production-Ready Spec v2

---

## Architecture Overview

```
Flutter App
├── Targets: Android (minSdk 23) + Web (Chrome, Safari, Firefox)
├── State management: Riverpod 2.x (AsyncNotifier + StreamProvider)
├── Navigation: go_router 14.x with nested routes and route guards
├── Theme: Material 3, dark mode default, light mode supported
├── Data layer: Repository pattern wrapping Firestore streams and
│             Cloud Functions HTTPS callable
└── No direct API calls — all via Firebase SDK only
```

**Critical constraint:** The Flutter client NEVER calls the Claude API, Binance API,
or IBKR API directly. It only reads Firestore documents and calls Cloud Functions
via `FirebaseFunctions.instance.httpsCallable()`. API keys never exist on the client.

---

## Package Dependencies

```yaml
dependencies:
  flutter:
    sdk: flutter

  # Firebase
  firebase_core: ^3.0.0
  firebase_auth: ^5.0.0
  cloud_firestore: ^5.0.0
  cloud_functions: ^5.0.0
  firebase_messaging: ^15.0.0

  # State management
  flutter_riverpod: ^2.5.0
  riverpod_annotation: ^2.3.0

  # Navigation
  go_router: ^14.0.0

  # Charts
  fl_chart: ^0.68.0

  # UI
  shimmer: ^3.0.0
  timeago: ^3.6.0
  intl: ^0.19.0
  cached_network_image: ^3.3.0
  flutter_svg: ^2.0.0

  # UX utilities
  haptic_feedback: ^0.1.0
  share_plus: ^9.0.0

dev_dependencies:
  build_runner: ^2.4.0
  riverpod_generator: ^2.4.0
  flutter_lints: ^4.0.0
```

---

## Navigation Structure

```dart
// Route definitions
GoRouter(
  initialLocation: '/auth',
  redirect: (context, state) {
    final isAuth = ref.read(authStateProvider).hasValue;
    final isAdmin = ref.read(userProvider).value?.role == 'admin';
    if (!isAuth && state.location != '/auth') return '/auth';
    if (state.location == '/auth' && isAuth) return '/dashboard';
    return null;
  },
  routes: [
    GoRoute(path: '/auth', builder: AuthScreen),

    ShellRoute(
      builder: UserShell,
      routes: [
        GoRoute(path: '/dashboard', builder: StrategiesOverviewScreen,
          routes: [
            GoRoute(path: 'strategy/:id', builder: StrategyDetailScreen,
              routes: [
                GoRoute(path: 'cycle/:cycleId', builder: CycleDetailScreen),
                GoRoute(path: 'trade/:tradeId', builder: TradeDetailScreen),
              ]
            ),
            GoRoute(path: 'new-strategy', builder: NewStrategyFlow),
          ]
        ),
        GoRoute(path: '/analytics', builder: AnalyticsDashboardScreen),
        GoRoute(path: '/notifications', builder: NotificationHistoryScreen),
        GoRoute(path: '/settings', builder: SettingsScreen,
          routes: [
            GoRoute(path: 'brokers', builder: BrokerConnectionsScreen),
            GoRoute(path: 'notifications', builder: NotificationSettingsScreen),
            GoRoute(path: 'account', builder: AccountSettingsScreen),
          ]
        ),
      ],
    ),

    // Admin routes (role guard in redirect)
    ShellRoute(
      builder: AdminShell,
      routes: [
        GoRoute(path: '/admin', builder: AdminOverviewScreen),
        GoRoute(path: '/admin/users', builder: AdminUsersScreen,
          routes: [
            GoRoute(path: ':userId', builder: AdminUserDetailScreen),
          ]
        ),
        GoRoute(path: '/admin/transactions', builder: AdminTransactionsScreen),
        GoRoute(path: '/admin/errors', builder: AdminErrorLogScreen),
        GoRoute(path: '/admin/audit', builder: AdminAuditLogScreen),
      ],
    ),
  ],
)
```

---

## State Management — Providers

```dart
// Authentication
final authStateProvider = StreamProvider<User?>((ref) =>
  FirebaseAuth.instance.authStateChanges());

final userProvider = StreamProvider<UserModel?>((ref) {
  final auth = ref.watch(authStateProvider).value;
  if (auth == null) return Stream.value(null);
  return FirebaseFirestore.instance
    .doc('users/${auth.uid}')
    .snapshots()
    .map((s) => s.exists ? UserModel.fromDoc(s) : null);
});

// Strategies
final strategiesProvider = StreamProvider<List<StrategyModel>>((ref) {
  final user = ref.watch(userProvider).value;
  if (user == null) return Stream.value([]);
  return FirebaseFirestore.instance
    .collection('users/${user.uid}/strategies')
    .where('status', whereNotIn: ['archived'])
    .orderBy('createdAt', descending: true)
    .snapshots()
    .map((s) => s.docs.map(StrategyModel.fromDoc).toList());
});

final strategyProvider = StreamProvider.family<StrategyModel?, String>((ref, id) {
  final user = ref.watch(userProvider).value;
  if (user == null) return Stream.value(null);
  return FirebaseFirestore.instance
    .doc('users/${user.uid}/strategies/$id')
    .snapshots()
    .map((s) => s.exists ? StrategyModel.fromDoc(s) : null);
});

// Cycles feed (paginated — first 50, load more on scroll)
final cyclesFeedProvider = StreamProvider.family<List<CycleModel>, String>((ref, strategyId) {
  final user = ref.watch(userProvider).value;
  if (user == null) return Stream.value([]);
  return FirebaseFirestore.instance
    .collection('users/${user.uid}/strategies/$strategyId/cycles')
    .orderBy('startedAt', descending: true)
    .limit(50)
    .snapshots()
    .map((s) => s.docs.map(CycleModel.fromDoc).toList());
});

// Trades feed
final tradesFeedProvider = StreamProvider.family<List<TradeModel>, TradeQuery>((ref, query) {
  final user = ref.watch(userProvider).value;
  if (user == null) return Stream.value([]);
  var q = FirebaseFirestore.instance
    .collection('users/${user.uid}/strategies/${query.strategyId}/trades')
    .orderBy('executedAt', descending: true);
  if (query.mode != null) q = q.where('mode', isEqualTo: query.mode);
  return q.limit(query.limit ?? 50).snapshots()
    .map((s) => s.docs.map(TradeModel.fromDoc).toList());
});

// Analytics data
final analyticsProvider = FutureProvider.family<AnalyticsData, AnalyticsQuery>((ref, query) async {
  final fn = FirebaseFunctions.instance.httpsCallable('getAnalytics');
  final result = await fn.call(query.toJson());
  return AnalyticsData.fromJson(result.data);
});

// Admin
final systemMetricsProvider = StreamProvider<SystemMetrics>((ref) =>
  FirebaseFirestore.instance
    .doc('systemMetrics/current')
    .snapshots()
    .map(SystemMetrics.fromDoc));

final adminUsersProvider = StreamProvider<List<UserModel>>((ref) =>
  FirebaseFirestore.instance
    .collection('users')
    .orderBy('createdAt', descending: true)
    .snapshots()
    .map((s) => s.docs.map(UserModel.fromDoc).toList()));
```

---

## Screen Specs

---

### AuthScreen

Single screen handles login and registration with tab switching.

**Login tab:**
- Email field (keyboard: emailAddress, textInputAction: next)
- Password field (obscured, textInputAction: done)
- "Sign in" button → `FirebaseAuth.signInWithEmailAndPassword`
- "Forgot password?" → dialog with email field → `sendPasswordResetEmail`
- Error handling: show `SnackBar` with user-friendly message
  - `user-not-found` → "No account with this email"
  - `wrong-password` → "Incorrect password"
  - `too-many-requests` → "Too many attempts. Try again in a few minutes."

**Register tab:**
- Display name, email, password, confirm password
- Password strength indicator (weak / fair / strong)
- "Create account" → `createUserWithEmailAndPassword` → create Firestore user doc
  via `createUserProfile` Cloud Function → navigate to onboarding
- Validation: all fields required, passwords must match, min 8 chars

**Shared:**
- Biometric login option on Android (if device supports it, after first login)
- No social login at this time (avoids Sign in with Apple requirement for iOS)
- Loading overlay during auth calls (prevent double-submit)

---

### OnboardingFlow

Multi-step flow shown after registration. Cannot be skipped.

**Step 1: Welcome**
- App name, brief description
- "Let's get started" CTA

**Step 2: Connect a Broker**
- Two cards: Binance and Interactive Brokers
- Must connect at least one to proceed
- Each card: tap → broker connection bottom sheet (see BrokerConnectionsScreen)
- Progress: "1 of 2 required" / "Connected ✓"

**Step 3: Create Your First Strategy**
- Brief explanation of what strategies are
- "Create Strategy" CTA → navigates to NewStrategyFlow
- "Skip for now" (allowed here — user can create strategy later)

**Step 4: Paper Mode Explained**
- Explains paper vs live mode
- "All strategies start in Paper mode. You need 24 hours of paper history before going live."
- "Got it" → complete onboarding, navigate to dashboard

---

### StrategiesOverviewScreen

**Header:** "My Strategies" + FAB (+ icon, navigates to NewStrategyFlow)

**Strategy card component:**
```
┌─────────────────────────────────────────────────────┐
│ 🟢  BTC RSI Scalper                    [PAPER] [AUTO]│
│ Binance · 3 assets: BTC, ETH, SOL                   │
│                                                      │
│  $20.43  portfolio value                             │
│  +$0.87  (+4.4%) all-time P&L                       │
│                                                      │
│ Last: HOLD · "RSI 48.2, no signal" · 4 min ago      │
│ Next check: 11 min ━━━━━━━━━━░░░ (73%)              │
└─────────────────────────────────────────────────────┘
```

- Status dot: green = active, amber = paused, red = auto_paused, grey = archived
- Mode badge: [PAPER] (grey) or [LIVE] (green)
- Decision mode badge: [RULE] or [AUTO]
- P&L shown in red if negative
- Progress bar shows time until next cycle
- Tap → StrategyDetailScreen
- Long-press → bottom sheet: Pause/Resume, Edit, Switch Mode, Clone, Archive

**Empty state:**
```
[illustration]
No strategies yet
Your first strategy is one conversation away.
[Create Strategy →]
```

**Broker connection warning banner:**
If no broker is connected, show persistent `MaterialBanner`:
"Connect a broker to start trading. [Connect →]"

**Pull-to-refresh:** triggers manual portfolio value refresh from broker

---

### NewStrategyFlow

Full-screen multi-step flow. Back navigation at each step (except step 1 back = close).
Progress indicator at top: "Step 2 of 5"

**Step 1: Name & Mode**
```
Strategy name: [_________________________]
               Max 50 characters

Decision mode:
┌─────────────────────┐  ┌─────────────────────┐
│ 📋 Rule Interpreter │  │ 🤖 Autonomous        │
│                     │  │                     │
│ You define rules.   │  │ Claude reasons       │
│ Claude follows      │  │ freely each cycle.  │
│ them exactly.       │  │ More flexible.      │
│                     │  │                     │
│ ✓ Predictable       │  │ ✓ Adaptive          │
│ ✓ Cheaper           │  │ ✗ Costs more        │
│ ✗ Less flexible     │  │ ✗ Harder to debug   │
└─────────────────────┘  └─────────────────────┘

[Next →]
```

**Step 2: Describe Your Strategy (Claude Chat)**

Chat interface:
```
┌─────────────────────────────────────────────────────┐
│ 💬 Strategy Setup                                   │
├─────────────────────────────────────────────────────┤
│                                                     │
│  [Claude bubble]                                    │
│  Hi! Tell me about your trading strategy.           │
│  What do you want to trade, and under what          │
│  conditions should I buy and sell?                  │
│                                                     │
│  [User bubble]                                      │
│  Buy BTC when RSI drops below 30...                 │
│                                                     │
│  [Claude bubble]                                    │
│  Got it! A few questions to make sure I             │
│  understand correctly:                              │
│  1. How much cash should I use per trade?           │
│                                                     │
│              [typing indicator...]                   │
│                                                     │
├─────────────────────────────────────────────────────┤
│  [_______________________________] [Send ↑]         │
└─────────────────────────────────────────────────────┘
```

- Each user message calls `strategySetup` Cloud Function
- Claude responses stream in word-by-word (Cloud Function returns complete response,
  but Flutter animates character-by-character for perceived streaming)
- When Claude returns `needsClarification: false`: show summary card

**Summary card (shown when Claude is satisfied):**
```
┌─────────────────────────────────────────────────────┐
│ ✅ Claude understood your strategy                  │
│                                                     │
│ "Buy ETH when oversold (RSI < 30) and in an        │
│  uptrend (above EMA200). Use 20% cash per trade.   │
│  Sell when RSI > 60 or down 5%."                   │
│                                                     │
│ Suggested assets: ETH                               │
│ Broker: Binance                                     │
│                                                     │
│ ⚠️ Risk notes:                                      │
│ • Won't trigger in bear markets below EMA200        │
│ • Single-asset — no diversification                │
│                                                     │
│  [✏️ Change something]   [Looks good →]            │
└─────────────────────────────────────────────────────┘
```

- "Change something" → re-opens chat for another turn (max 5 turns)
- "Looks good" → advance to Step 3

**Step 3: Risk Settings**

```
Max loss per trade
How much of your portfolio to risk on each trade.
[●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━] 5%
  1%                              50%

Max portfolio drawdown
Auto-pause if portfolio drops this much from peak.
[━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━] 20%
  5%                              50%

Max position size per asset
[━━━━━━━━━━━━━━●━━━━━━━━━━━━━━━] 25%
  5%                              100%

Max simultaneous open positions
[1] [2] [3] [4] [5] [6] [7] [8] [9] [10]

Stop-loss per trade (optional)
Auto-sell if a position drops this much.
[Toggle: OFF] → slider appears if ON: [━━━●] 5%

Take-profit per trade (optional)
Auto-sell if a position gains this much.
[Toggle: OFF] → slider appears if ON: [━━━━━━━━━●] 10%

Min confidence to trade (autonomous mode only)
Skip trade if Claude's confidence is below this.
[Toggle: OFF] → if ON: [━━━━━●] 0.6
```

**Step 4: Assets & Schedule**

```
Assets to watch
(Claude suggested: ETH)

[+ Add asset]  [ETHUSDT ✕]  [BTCUSDT ✕]

Broker: [Binance ▼] (IBKR if assets are stocks)

Check every: [15 min ▼]  Options: 5 / 15 / 30 / 60

Active hours
[Toggle: 24/7] → if OFF:
  From [09:30] to [16:00]  Timezone [America/New_York ▼]
  Days: [M] [T] [W] [T] [F] [S] [S]
```

**Step 5: Notifications**

```
Get notified when:
[✓] A trade is executed
[ ] Every 15-min cycle check  (verbose — not recommended)
[✓] Important events (auto-pause, errors, suggestions)
[✓] Asset suggestion from Claude
[✓] Daily summary  at [08:00 UTC ▼]
[ ] Weekly performance summary
```

**Step 6: Review & Launch**

Summary of all settings. Large "Start in Paper Mode" button.
- 24h paper minimum shown as info chip: "ℹ️ You can switch to live after 24 hours"
- Confirmation creates strategy via Cloud Function
- Success → navigate to StrategyDetailScreen for the new strategy

---

### StrategyDetailScreen

**App bar:** Strategy name + status dot + overflow menu (Edit, Clone, Archive)

**Mode & status bar:**
```
[● PAPER]  [RULE INTERPRETER]  [⏸ Paused]  [▶ Resume]
```
Tapping PAPER → switch to live modal (with hold-to-confirm)
Tapping RULE INTERPRETER → mode switch bottom sheet

**Emergency sell button:** Red, only visible in LIVE mode with open positions.
```
[⚠️ Emergency Sell — hold to execute]
```
Uses `HoldToConfirmButton` widget (2s hold, shows progress ring, requires release then re-hold).

**3 tabs:**

#### Tab 1: Portfolio

Current positions fetched from Firestore (updated each cycle from broker).

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Portfolio Value    $20.43  +$0.87 (+4.4%) all-time
Cash available     $5.21   (25.5%)

Open positions
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ETH    0.0042    avg $3,180    now $3,224    +$0.18 (+1.4%)
       ████████████████████████░░░░  80% of position limit
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BTC    0.00018   avg $61,100   now $63,400   +$0.41 (+0.7%)
       ████████████████░░░░░░░░░░░░  60% of position limit
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Bot status
Last cycle:  HOLD — "RSI 48.2, no signal" — 4 min ago
Next cycle:  In 11 min  [▶ Run now]
Strategy:    Watching RSI < 30 on ETH (current: 44.1)
```

"Run now" → `manualCycleTrigger` Cloud Function (rate limited: 3/min)

**Sparkline chart:** 7-day portfolio value (small, thumbnail size)

**Broker health:** green dot if last cycle succeeded, red if consecutive failures > 0

#### Tab 2: Reasoning Feed

```
Filters: [All ▼] [Date range]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔵 HOLD  ·  09:30 UTC  ·  Rule mode  ·  conf: —
"RSI at 48.2, above the 35 threshold. No rules
 triggered. EMA20 above EMA50, trend healthy."
BTC $63,400  RSI 48.2  F&G 41                ▸
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 BUY   ·  08:00 UTC  ·  Rule mode  ·  conf: 0.79
"RSI at 28.4, Fear & Greed at 23 (Extreme Fear).
 Rule rsi_oversold_buy triggered. Bought 0.0042
 ETH at $3,180."
ETH $3,180  RSI 28.4  F&G 23            [Trade →]▸
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 SELL  ·  06:15 UTC  ·  Auto: Stop-loss
"Stop-loss triggered: ETH down 5.2%, limit 5.0%"
ETH $3,012  P&L: -$0.74             [Trade →]▸
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟠 ERROR ·  05:45 UTC
"Claude API timeout after 30s — cycle skipped"
                                     [Details →]▸
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Tap any row → CycleDetailScreen

**Load more** at bottom of list (cursor-based pagination)

#### Tab 3: Trades

```
Filters: [All ▼] [Live/Paper] [Asset] [Date range]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▲ BUY  ETH   0.0042 @ $3,180   $13.36   PAPER
  14 Dec 08:00  ·  fee: $0.00  ·  [Details →]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
▼ SELL ETH   0.0042 @ $3,312   stop-loss
  14 Dec 06:15  ·  P&L: -$0.74 (-5.5%)  ·  [→]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Export CSV]
```

---

### CycleDetailScreen

Full detail of a single cycle execution.

**Header:** Action badge + timestamp + duration

**Sections (expandable):**

1. **Decision**
   - Action, symbol, size, reasoning (full text)
   - Confidence score with visual bar
   - Rules triggered (rule mode only)
   - Validation notes (if any overrides applied)

2. **Market Snapshot**
   - Table: Symbol | Price | 24h% | RSI | MACD | EMA20 | EMA50
   - Fear & Greed chip
   - News headlines (if present)
   - Data freshness indicator

3. **Portfolio at this moment**
   - Total value, cash, open positions (as they were at cycle time)

4. **Drawdown check**
   - Peak value, current value, drawdown %, limit %

5. **Execution**
   - Trade ID (if trade executed) with link to TradeDetailScreen
   - Skipped reason (if no trade)

6. **Stop/Take-profit checks**
   - Table per position checked

7. **Timing breakdown**
   - Phase | Duration: market data Xms | Claude Xms | execution Xms...

8. **Claude raw response** (expandable, for power users)
   - Full JSON response from Claude

---

### AnalyticsDashboardScreen

**Time range selector:** [7D] [30D] [90D] [All]
**Strategy filter:** [All strategies ▼]
**Mode filter:** [All] [Live only] [Paper only]

**Metric cards row (scrollable horizontally):**
```
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│ Total P&L  │ │  Win Rate  │ │  Sharpe    │ │ Max DD     │ │ AI Cost    │
│  +$34.21   │ │  61%       │ │   1.42     │ │  -8.3%     │ │  $0.47/mo  │
│ +4.4% all  │ │  (23/38)   │ │  (annual)  │ │  (3d ago)  │ │            │
└────────────┘ └────────────┘ └────────────┘ └────────────┘ └────────────┘
```

**Charts (using fl_chart):**

1. **Equity curve** — LineChart, portfolio value over time
   - Multiple lines if multiple strategies selected
   - Tooltip on hover/tap: date, value, P&L from start

2. **Drawdown** — LineChart with filled area below zero
   - Shows % drawdown from peak at each point
   - Red fill for negative values

3. **P&L by asset** — HorizontalBarChart
   - Sorted by total P&L descending
   - Green bars for profit, red for loss

4. **Trade distribution** — BarChart
   - X: P&L buckets (-20%, -15%, ..., 0, ..., +15%, +20%+)
   - Y: trade count
   - Visualises win/loss distribution

5. **Trade frequency** — BarChart
   - Trades per day for selected period

6. **Claude cost per day** — LineChart
   - Budget alert line overlay if configured

**Strategy comparison table:**
```
Strategy        Trades  Win%  P&L      Sharpe  Max DD  Cost
BTC RSI Scalper   23    61%  +$34.21   1.42   -8.3%  $0.31
ETH Momentum       8    50%   -$2.10   0.21  -12.1%  $0.09
```

---

### Admin Screens

All admin screens are accessible at `/admin/*`. Only users with `role == 'admin'` can
access them — the router redirect checks this. A non-admin hitting an admin route is
redirected to `/dashboard`.

#### AdminOverviewScreen

**System health banner:**
```
[🟢 All systems operational]
or
[🔴 High error rate: 23% in last hour — 12 errors]
```

**Real-time metric grid (2×3 on mobile, 3×2 on wide):**
```
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ Users       │ │ Active Strat │ │ Trades today│
│ 142 total   │ │ 87 (61 live)│ │ 234 live    │
│ 12 new/week │ │ 26 paused   │ │ 89 paper    │
└─────────────┘ └─────────────┘ └─────────────┘
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ Claude cost │ │ Error rate  │ │ Uptime      │
│ $0.87 today │ │ 1.2% / 24h  │ │ 99.8%       │
│ $14.2 / mo  │ │ 2 critical  │ │             │
└─────────────┘ └─────────────┘ └─────────────┘
```

**Charts:**
- New users per day — 30-day bar chart
- Trades per day — 30-day bar chart (live vs paper stacked)
- Claude cost per day — 30-day line
- Error rate trend — 30-day line

**Recent errors feed** (last 5, with link to full error log)

#### AdminUsersScreen

DataTable with sorting and search:
```
[Search by email or name...]

Name        Email          Joined    Last active  Strategies  P&L      Status
Itsik Bar   itsik@...    Jan 2026   2 min ago    3 (2 live)  +$34.21  Active [→]
```

Sort: by any column. Filter: active / suspended / admin. Paginated: 50 per page.

#### AdminUserDetailScreen

- Profile card with all stats
- Tabs: Strategies | Trades | Errors | Admin actions
- Admin action buttons: Suspend / Reactivate / Promote to admin / Remove admin
- All admin actions go through a Cloud Function and are logged to `adminAuditLog`

#### AdminTransactionsScreen

Filterable data table. Server-side filtering via Cloud Function for performance.

Export button → calls `generateTradeExport` Cloud Function → returns signed GCS URL
for CSV download (file generated server-side, stored temporarily in Cloud Storage).

#### AdminErrorLogScreen

Real-time feed from `errorLogs` collection.

```
[🔴 CRITICAL]  broker_ibkr   user: itsik@...   5 min ago
IBKR token expired — strategy auto-paused
[Resolve ↓]   [View context →]
```

Bulk actions: Mark all resolved, Filter by unresolved.

Email alert threshold: if `errorRatePctToday > 5`, send email to admin.
(Implemented via Cloud Function that monitors `systemMetrics/current` on write.)

---

## Reusable Widget Library

```dart
// Status dot
StatusDot({ required String status })
// green=active, amber=paused, red=auto_paused, grey=archived

// Hold-to-confirm button (2s press required)
HoldToConfirmButton({
  required String label,
  required VoidCallback onConfirmed,
  Color color = Colors.red,
  Duration holdDuration = const Duration(seconds: 2),
})

// P&L display with colour and sign
PnlText({ required double pnl, bool showPercent = false, double? pct })

// Mode badge chip
ModeBadge({ required String mode })  // 'paper' → grey, 'live' → green

// Decision mode chip
DecisionModeBadge({ required String mode })  // 'rule' or 'auto'

// Metric card
MetricCard({
  required String label,
  required String value,
  String? subtitle,
  IconData? icon,
  Color? valueColor,
})

// Cycle entry card (reasoning feed)
CycleEntryCard({
  required CycleModel cycle,
  VoidCallback? onTap,
})

// Confidence indicator bar
ConfidenceBar({ required double confidence })
// 0-0.4 red, 0.4-0.6 amber, 0.6+ green

// Loading skeleton (shimmer)
SkeletonCard({ double height = 80 })
SkeletonList({ int count = 5 })

// Broker connectivity chip
BrokerChip({ required String broker, required bool connected })

// Empty state
EmptyState({
  required String title,
  required String subtitle,
  String? ctaLabel,
  VoidCallback? onCta,
  String? illustrationPath,
})

// Error state (for AsyncValue.error)
ErrorState({
  required Object error,
  VoidCallback? onRetry,
})
```

---

## Error Handling Patterns

```dart
// All async Riverpod providers use AsyncValue
// In UI, always handle all 3 states:
ref.watch(strategiesProvider).when(
  data: (strategies) => StrategiesListView(strategies: strategies),
  loading: () => const SkeletonList(),
  error: (err, stack) => ErrorState(
    error: err,
    onRetry: () => ref.invalidate(strategiesProvider),
  ),
);

// Cloud Function calls — wrap in try/catch, show SnackBar
Future<void> callCloudFunction() async {
  try {
    final fn = FirebaseFunctions.instance.httpsCallable('strategySetup');
    await fn.call(data);
  } on FirebaseFunctionsException catch (e) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(_friendlyErrorMessage(e.code, e.message)),
      backgroundColor: Theme.of(context).colorScheme.error,
    ));
  }
}

String _friendlyErrorMessage(String code, String? message) {
  return switch (code) {
    'unauthenticated' => 'Please log in again.',
    'resource-exhausted' => 'Too many requests. Please wait a moment.',
    'unavailable' => 'Service temporarily unavailable. Try again in a minute.',
    'invalid-argument' => 'Invalid input: ${message ?? ""}',
    _ => 'Something went wrong. Please try again.',
  };
}
```

---

## Responsive Layout

```dart
// Breakpoints
const int kMobileBreakpoint = 600;
const int kTabletBreakpoint = 900;

// Usage
LayoutBuilder(builder: (context, constraints) {
  if (constraints.maxWidth >= kTabletBreakpoint) {
    return WideLayout(child: child);
  } else {
    return NarrowLayout(child: child);
  }
})
```

- **Mobile (< 600px):** BottomNavigationBar, single column, full-screen charts
- **Tablet / Web (600–900px):** NavigationRail (left side), two-column layouts
- **Wide web (> 900px):** NavigationDrawer always visible, multi-column data tables,
  charts with more detail, admin screens show full table columns

---

## Performance Optimisations

1. **Pagination everywhere.** Cycles and trades use cursor-based pagination (Firestore
   `startAfterDocument`). Never load all documents at once.

2. **ListView.builder** for all lists — never ListView with children array.

3. **const constructors** on all stateless widgets wherever possible.

4. **Image caching** via `cached_network_image` — no repeated network fetches.

5. **Deferred loading** for admin screens — don't load admin providers until the admin
   route is actually visited.

6. **Chart data computed server-side.** Analytics charts are computed by Cloud Function,
   not by iterating Firestore documents in Flutter. Flutter just receives a data array.

7. **Firestore offline persistence** enabled on mobile (Firebase default). Web uses
   session-only cache. Allows app to show last-known data while reconnecting.

8. **Selective stream listening.** Strategies detail screen only listens to the single
   strategy document + its cycles feed — not all strategies.

9. **Debounce search inputs** in admin screens (300ms debounce before querying).

10. **Web: use `canvaskit` renderer** for charts. Default auto renderer may use HTML
    renderer on web which has poor chart performance.
    Add `--web-renderer canvaskit` to build command.

---

## FCM Push Notification Handling

```dart
// In main.dart after Firebase.initializeApp()
await FirebaseMessaging.instance.requestPermission(
  alert: true, badge: true, sound: true,
);

// Foreground messages
FirebaseMessaging.onMessage.listen((message) {
  // Show in-app notification banner (not system notification)
  showInAppNotificationBanner(message);
});

// Background/terminated: tap navigates to relevant screen
FirebaseMessaging.onMessageOpenedApp.listen((message) {
  final data = message.data;
  switch (data['type']) {
    case 'trade_executed':
      context.go('/dashboard/strategy/${data['strategyId']}/trade/${data['tradeId']}');
    case 'cycle_complete':
      context.go('/dashboard/strategy/${data['strategyId']}');
    case 'drawdown_limit_hit':
      context.go('/dashboard/strategy/${data['strategyId']}');
    default:
      context.go('/notifications');
  }
});

// Token refresh
FirebaseMessaging.instance.onTokenRefresh.listen((token) {
  // Update token in Firestore via Cloud Function
  FirebaseFunctions.instance.httpsCallable('updateFcmToken').call({'token': token});
});
```

---

## Theme Configuration

```dart
ThemeData buildTheme(Brightness brightness) => ThemeData(
  useMaterial3: true,
  colorScheme: ColorScheme.fromSeed(
    seedColor: const Color(0xFF1A56DB),  // Brand blue
    brightness: brightness,
  ),
  // Card styling
  cardTheme: const CardTheme(
    elevation: 0,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.all(Radius.circular(12)),
    ),
  ),
  // Typography
  textTheme: GoogleFonts.interTextTheme(
    brightness == Brightness.dark
      ? ThemeData.dark().textTheme
      : ThemeData.light().textTheme,
  ),
  // Component overrides
  elevatedButtonTheme: ElevatedButtonThemeData(
    style: ElevatedButton.styleFrom(
      minimumSize: const Size.fromHeight(52),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
    ),
  ),
);
```

**Semantic colours (used via extension):**
- `AppColors.pnlPositive` = green shade
- `AppColors.pnlNegative` = red shade
- `AppColors.paper` = grey (paper mode)
- `AppColors.live` = green (live mode)
- `AppColors.critical` = deep red (errors, emergency)
- `AppColors.warning` = amber (auto-paused, warnings)
