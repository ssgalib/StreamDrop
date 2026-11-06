# Recovery commits and crash tests

This describes the local implementation work following `plan_4.md`. Wire v2/min1 is unchanged; see [protocol.md](protocol.md).

## Ordering

| Operation | Commit order |
|---|---|
| Receive checkpoint | Write bytes → sync data file → write private JSON temporary file → sync JSON → atomic JSON replacement → sync parent directory |
| Publish completed receive | Sync full data → commit intended final name → create a hard link without replacing any existing name → sync destination directory → commit published state → apply download marking → remove staging link → sync staging directory |
| Acknowledge completion | Publish sink → commit completion outcome ledger → commit transfer journal → send `saved` |
| Cancel | Stop new source/frame delivery → commit cancellation outcome ledger and journal → send `cancel` → settle queued writes and any finalizer → delete partial → sync staging directory |
| Keep unfinished | Stop streaming → settle writes → checkpoint resumable sinks → commit held queue and authentication reference → send ordinary goodbye → close connection |
| Restore app | Prepare every source/sink and merge committed outcomes → restore the whole engine snapshot with intermediate writes suppressed → commit the complete snapshot on connection selection → reconnect/authenticate if not explicitly held |

The outcome ledger may be newer than the transfer journal after a crash. Cancellation wins over an active journal. Completion prevents another output file. Cancellation cleanup is retried at startup even when the journal was subsequently cleared. Missing/offline volumes may defer that cleanup.

A missing source retains its original path in the journal. A missing receive volume is not replaced by newly created directories on the system disk. Recovery failures leave the journal available for another attempt.

## Finalization limitations

Publication uses hard links on the same filesystem as the staging file. This removes the prior empty-reservation/rename window and never overwrites a collision. Filesystems without hard-link support need a safe platform-specific fallback; the current client reports an error rather than silently using an unsafe replacement. Test NTFS/APFS and removable filesystems before claiming those paths work.

Lexical path checks and existing-link checks do not eliminate a hostile local process racing directory replacement. Windows directory fsync remains unsupported by this Node implementation. Neither outside security review nor power-loss verification has occurred.

## Tests

`npm --prefix desktop test` includes child processes stopped with real SIGKILL at JSON writes/sync/replacement, initial part creation, receive checkpoints, publication intent/link/directory sync, completion recording, and staging removal. A fresh sink reopens each result, checks the exact durable offset and verifies the completed SHA-256. Collision cases ensure a pre-existing file remains unchanged and only one new output appears.

These are process-death tests with the OS filesystem cache still present. They verify application ordering and recovery, not storage hardware behaviour after power loss.

Engine regressions cover failed cancellation commits, cancellation during finalization, pending cancellation waits, terminal outcomes after clearing history, repeated completed offers and restoring a queue in one snapshot. Electron scenarios cover kept transfers across restarts, one-device saved-call resumption, temporary connection resumption, offline Discard and a newer cancellation ledger with an older active journal. The last case constructs the crash disk state through the real record bridge and a test-only journal rollback; it does not claim to kill Electron at that exact commit instruction.

Freeze source edits while Playwright runs against the Vite dev server. Hot reload otherwise changes the pages being tested.
