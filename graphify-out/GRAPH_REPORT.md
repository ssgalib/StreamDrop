# Graph Report - StreamDrop  (2026-11-06)

## Corpus Check
- Corpus is ~20,121 words - fits in a single context window. You may not need a graph.

## Summary
- 281 nodes · 546 edges · 14 communities (9 shown, 5 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 49 edges (avg confidence: 0.86)
- Token cost: 81,463 input · 0 output

## Community Hubs (Navigation)
- Web App Page Logic
- Project Plans and Protocols
- Relay Budget and Server Startup
- Hub and Signaling Server
- Server Tests
- Web Tooling and E2E Test
- File Transfer and Storage Sinks
- TypeScript Config
- Relay Tests and Budget
- Deploy Script
- Install Script
- TURN Install Script
- Hub Design Notes
- Go Module

## God Nodes (most connected - your core abstractions)
1. `newHandler()` - 22 edges
2. `Hub` - 21 edges
3. `Budget` - 20 edges
4. `compilerOptions` - 16 edges
5. `NewHub()` - 12 edges
6. `newTestHub()` - 12 edges
7. `onControl()` - 12 edges
8. `Peer` - 11 edges
9. `handle()` - 11 edges
10. `dial()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `Incoming file Accept/Decline prompt` --conceptually_related_to--> `File transfer DataChannel protocol (meta/accept/ack/done/saved)`  [INFERRED]
  web/index.html → project-plan.md
- `Transfer progress and cancel UI` --conceptually_related_to--> `transfer.ts (sender and receiver)`  [INFERRED]
  web/index.html → project-plan.md
- `Invite link, token and QR section` --implements--> `QR code invite (qr.ts)`  [INFERRED]
  web/index.html → track.md
- `main()` --calls--> `newBudget()`  [INFERRED]
  server/main.go → server/budget.go
- `main()` --calls--> `NewHub()`  [INFERRED]
  server/main.go → server/hub.go

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **File transfer pipeline (protocol, sender/receiver, sinks)** — project_plan_datachannel_protocol, project_plan_transfer_ts, project_plan_sinks, project_plan_flow_control [INFERRED 0.85]
- **Relay with budget control** — readme_turn_relay, readme_relay_budget, track_relay_budget_decision, project_plan_turn_fallback [INFERRED 0.85]

## Communities (14 total, 5 thin omitted)

### Community 0 - "Web App Page Logic"
Cohesion: 0.07
Nodes (41): abortTransfer(), connect(), copyBtn, endTransfer(), errorEl, errorText, events, fail() (+33 more)

### Community 1 - "Project Plans and Protocols"
Cohesion: 0.07
Nodes (33): Milestone 1 Implementation Plan, RTCDataChannel, Signaling message protocol (no chat type), WebSocket signaling, validateSignal, WebRTC peer (peer.ts), StreamDrop Full Project Plan, Final architecture (signaling, TURN, browsers) (+25 more)

### Community 2 - "Relay Budget and Server Startup"
Cohesion: 0.11
Nodes (9): msg, Budget, budgetState, dial(), main(), pair(), recv(), send() (+1 more)

### Community 3 - "Hub and Signaling Server"
Cohesion: 0.14
Nodes (16): Hub, other(), ICEServer, ipLimiter, main(), Message, Peer, Room (+8 more)

### Community 4 - "Server Tests"
Cohesion: 0.19
Nodes (25): client, NewHub(), newTestHub(), TestAlreadyInRoom(), TestConcurrentJoin(), TestJoin(), TestLeave(), TestServerBusy() (+17 more)

### Community 5 - "Web Tooling and E2E Test"
Cohesion: 0.08
Nodes (26): @playwright/test, qrcode-generator, typescript, vite, Engine, engines, launchOptions, pairs (+18 more)

### Community 6 - "File Transfer and Storage Sinks"
Cohesion: 0.14
Nodes (19): chooseSink(), cleanOpfs(), downloadBlob(), memorySink(), opfsSink(), pickerSink(), ACK_EVERY, Channel (+11 more)

### Community 7 - "TypeScript Config"
Cohesion: 0.11
Nodes (18): compilerOptions, allowArbitraryExtensions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection, moduleResolution (+10 more)

### Community 8 - "Relay Tests and Budget"
Cohesion: 0.22
Nodes (6): newBudget(), logLine(), TestBudgetCountsSessionUsage(), TestBudgetResetsEachMonth(), TestTurnServersCredential(), TestTurnServersDisabled()

## Knowledge Gaps
- **8 isolated node(s):** `streamdrop`, `StreamDrop (browser-to-browser file transfer)`, `Hub (rooms, tokens, expiry)`, `RTCDataChannel`, `Docker/Caddy deployment (superseded)` (+3 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 96 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `qrcode-generator` connect `Web Tooling and E2E Test` to `Web App Page Logic`?**
  _High betweenness centrality (0.056) - this node is a cross-community bridge._
- **Are the 12 inferred relationships involving `newHandler()` (e.g. with `main()` and `.Leave()`) actually correct?**
  _`newHandler()` has 12 INFERRED edges - model-reasoned connections that need verification._
- **What connects `streamdrop`, `StreamDrop (browser-to-browser file transfer)`, `Hub (rooms, tokens, expiry)` to the rest of the system?**
  _8 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Web App Page Logic` be split into smaller, more focused modules?**
  _Cohesion score 0.06753006475485661 - nodes in this community are weakly interconnected._
- **Why does `Budget` connect `Relay Budget and Server Startup` to `Relay Tests and Budget`, `Hub and Signaling Server`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Should `Project Plans and Protocols` be split into smaller, more focused modules?**
  _Cohesion score 0.06685633001422475 - nodes in this community are weakly interconnected._
- **Should `Relay Budget and Server Startup` be split into smaller, more focused modules?**
  _Cohesion score 0.11051693404634581 - nodes in this community are weakly interconnected._