# Duckycut Audit Remediation Design

**Date:** 2026-08-25  
**Status:** Approved for implementation planning  
**Source:** Technical audit supplied for the current `main` branch  
**Target platform:** Windows and Adobe Premiere Pro with CEP/QE DOM

## Objective

Turn the audit findings into five incremental, mergeable releases that first protect the user's timeline, then make long-form analysis practical, unify time math, redesign the review flow, and finish Windows distribution. The current QE-based cutter will be stabilized in this program. Its contracts must leave room for a later FCPXML implementation, but FCPXML generation is not part of this scope.

## Delivery principles

- Each phase must leave the product usable, tested, and independently mergeable.
- Timeline safety takes precedence over speed and interface work.
- Frames are the canonical unit at subsystem boundaries; conversion for QE happens only in the host.
- The original Premiere sequence is never the mutation target by default.
- Production responses remain small; detailed diagnostics are opt-in.
- Unsupported or ambiguous timeline state fails before mutation instead of using silent fallbacks.
- Windows is the only supported release platform in this program.

## Architecture

The panel owns an explicit analysis session:

`sequence + tracks + range + preset -> cache key -> WAV -> VAD worker -> speech/silence intervals -> frame zones -> visual review -> apply`

The client orchestrates state and user interaction. Pure modules calculate cache identities, frame ranges, cut zones, and target plans. The external worker performs VAD and reports structured progress. The host is the only layer that reads or mutates Premiere state and the only layer that converts frames to QE-compatible timecode.

### Component boundaries

#### Panel orchestration

`client/js/main.js` coordinates screens, progress, cancellation, analysis-session lifetime, and host/worker calls. It must not contain a second implementation of cut-zone math, cache identity, or time conversion.

#### Cut-zone math

`client/js/cutZones.js` becomes the single production implementation for generating, offsetting, intersecting, merging, and frame-snapping cut zones. Inputs and outputs use integer frames plus explicit frame-rate metadata.

#### Analysis session and mixdown cache

A focused client module owns the session key derived from sequence identity, selected tracks, analysis range, and export preset. A valid WAV survives navigation and parameter changes. Entries expire by age or panel shutdown. Pending mute state is persisted before export and restored on panel startup when necessary.

#### VAD execution

`server/vadWorker.js` is the default execution path. It owns a reusable ONNX session and writes newline-delimited JSON events for start, progress, result, cancellation, and failure. `server/vadDetector.js` validates the WAV header, reads PCM in bounded chunks, applies a conservative RMS gate, reuses inference buffers where supported, and never holds the complete recording as both `Buffer` and `Float32Array`.

#### Pure apply planning

A new pure JavaScript module accepts cached clip geometry and frame zones. It returns either a complete removal plan or typed validation errors. It covers asymmetric tracks, empty tracks, boundary-crossing clips, locked tracks, and missing post-razor segments without touching Premiere APIs.

#### Premiere host

`host/index.jsx` performs preflight, duplicates the active sequence, executes every required razor in one pass, performs one post-razor refresh/read, builds and validates the complete removal plan, and removes targets from the end toward the start. It must not sleep or rescan the full timeline inside a per-zone loop.

#### Waveform review

The panel renders a downsampled waveform representation of the cached WAV, a threshold guide, and the proposed removal zones. Slider changes recalculate zones from cached analysis results and redraw without re-exporting or rerunning ONNX unless an input represented by the cache key changes.

## Phase 1: Timeline safety and linear apply

This phase covers `IT-01`, `IT-02`, `IT-03`, `PF-01`, and `PF-02`, plus the preflight portion of `IT-09`.

- Duplicate the active sequence by default and mutate only the duplicate.
- Preflight frame rate, active-sequence identity, locked tracks, supported timeline structures, range bounds, and transition intersections.
- Calculate all razor boundaries before mutation and apply them in one pass.
- Replace per-zone polling and `$.sleep` with one post-razor state read and explicit validation.
- Cache clip geometry once and calculate all removal targets before the first removal.
- Require each target track to have the expected segment for every zone; reject the plan before removal if the geometry is incomplete.
- Reduce boundary matching to exact frames, with at most one frame of explicitly tested QE normalization tolerance.
- Remove from latest to earliest so earlier coordinates remain stable.
- Use a disk sentinel for cancellation at safe stage boundaries.
- Return typed results with sequence identity, applied count, skipped count, failure stage, and recovery guidance.

The duplicated sequence is the authoritative rollback mechanism. A short Premiere spike will verify whether one-step undo grouping is dependable in the supported host versions. Undo grouping may be added only as an extra convenience; it cannot replace duplication.

## Phase 2: Long-form performance

This phase covers `PF-03` through `PF-10`, with `PF-08` and `PF-09` integrated into the analysis-session boundary.

- Always launch VAD in the external Node worker.
- Cache the ONNX session for the worker lifetime and reuse inference state and buffers.
- Stream or chunk PCM input and apply a conservative RMS gate before inference.
- Emit progress from processed samples/windows instead of fabricated milestones.
- Replace the full-sequence clip scan with selected-track `clipCount` validation.
- Hide `_diag`, `_zoneDiag`, candidate clips, and synchronous per-chunk logs behind a debug flag that defaults off.
- Cache mixdowns by stable analysis inputs and clean them by age or panel shutdown.
- Treat render timeout as inactivity: continued file growth resets the deadline.
- Remove the five-second polling loop and retain focus/visibility refresh events.

Performance acceptance includes bounded memory on a three-hour mono WAV and real progress throughout VAD. The end-to-end apply target remains under 60 seconds for the audit's 60-minute acceptance sequence.

## Phase 3: Canonical frame math and tested production algorithms

This phase covers `QC-01`, `QC-02`, `QC-03`, `IT-04`, `IT-05`, `IT-06`, `IT-07`, `IT-10`, and `IT-11`.

- Make integer frames the panel-to-host cut-zone contract.
- Represent frame-rate metadata explicitly using timebase ticks and nominal/display properties rather than inferred float tolerances.
- Keep the only QE timecode conversion helper inside the host.
- Fail if the Premiere timebase or display format cannot be read reliably.
- Include known NTSC timebases such as 23.976, 29.97, 47.952, 59.94, and 119.88 through exact tick matching.
- Use the analyzed file/range duration, verified within one frame, instead of overwriting it with sequence duration.
- Replace host `eval` input parsing with a compatible `JSON.parse` implementation.
- Establish and test one unconditional zero-point convention for Premiere In/Out values.
- Move the production `computeCleanCutZones` behavior into the pure cut-zone module and remove the unused competing algorithm.
- Fail panel initialization when required modules are unavailable rather than entering inline fallback implementations.

## Phase 4: Review-first UX

This phase covers `UX-01` through `UX-11`.

- `Analyze` completes export and detection, then opens a visible results/review state.
- `Apply` consumes already reviewed frame zones and performs no hidden detection.
- The waveform displays audio energy, the effective threshold, and removal zones.
- Aggressiveness maps to a conservative useful range and uses editing-language labels.
- Back navigation preserves a valid analysis session.
- Settings persist in an extension-owned JSON file.
- Initial presets cover podcast, vlog, and tutorial while remaining editable.
- All visible strings come from a locale dictionary; the first supported locale is Brazilian Portuguese.
- Worker and host stage progress replace fabricated percentages.
- Short actionable errors remain in the panel; structured detail goes to the debug log.
- The panel receives a wider responsive layout suitable for waveform review while preserving a clear analyze-review-apply progression.

## Phase 5: Windows distribution and cleanup

This phase covers `QC-04`, `QC-05`, and `PL-01` through `PL-04` within the approved Windows-only boundary.

- Declare Windows support explicitly in the manifest and README.
- Remove unreachable preset discovery, unused host entry points, and unreferenced detector paths after coverage proves they are dead.
- Extend tests around pure apply planning and keep contract tests for the CEP/ExtendScript boundaries.
- Package the required minimal FFmpeg and external Node runtime in the installer.
- Replace `PlayerDebugMode` distribution with a signed ZXP release procedure using `ZXPSignCmd`; signing secrets remain external to Git.
- Record CEP/QE dependence as an accepted risk and define the stable frame-zone/removal-plan seam for a later FCPXML adapter.

## Error handling and recovery

All cross-boundary results use structured success, cancellation, validation-error, and execution-error variants. User-facing messages identify the failed stage and next action. Debug logs include technical context without being marshalled on every successful production call.

Cancellation behavior is stage-specific:

- Render: stop waiting, restore track mutes, and invalidate only the incomplete artifact.
- VAD: terminate the worker and retain a valid cached WAV.
- Pre-removal apply: stop without deleting segments.
- Removal: finish only the current safe unit and report the duplicate sequence's exact state.

If the panel or Premiere exits while track mutes are temporarily changed, persisted mute state is restored on the next panel initialization and the user is notified.

## Validation strategy

### Automated tests

- Pure Node tests cover frame math, timebase lookup, zero point, cache identity, cache expiry, progress parsing, cancellation, cut-zone behavior, and apply planning.
- Contract tests inspect CEP/ExtendScript entry points for structured parsing, compact production output, absence of per-zone sleeps, and correct stage ordering.
- Worker tests use generated PCM fixtures to verify streaming boundaries, RMS gating, session reuse, cancellation, and bounded-memory behavior.
- Existing tests that encode obsolete behavior are replaced in the same phase as the behavior, never simply deleted without successor coverage.

### Premiere smoke tests

Each phase adds a documented manual matrix for supported Premiere versions. The final acceptance sequence is 60 minutes, 29.97 drop-frame, zero point `01:00:00:00`, two audio tracks, two video tracks with overlays, asymmetric clip coverage, and transitions near candidate zones.

Acceptance requires:

- The original sequence remains unchanged.
- No track loses synchronization.
- Cancellation returns a consistent duplicate sequence and restores mute state.
- A supported one-step undo reverses the apply if the undo spike succeeds; otherwise the UI makes sequence deletion the explicit recovery path.
- Analysis shows continuous real progress and remains responsive.
- Apply completes in under 60 seconds on the agreed reference machine.
- Results are visible and reviewable before apply.

## Audit coverage map

| Phase | Findings |
|---|---|
| 1 | PF-01, PF-02, IT-01, IT-02, IT-03, part of IT-09 |
| 2 | PF-03, PF-04, PF-05, PF-06, PF-07, PF-08, PF-09, PF-10 |
| 3 | QC-01, QC-02, QC-03, IT-04, IT-05, IT-06, IT-07, IT-10, IT-11 |
| 4 | UX-01, UX-02, UX-03, UX-04, UX-05, UX-06, UX-07, UX-08, UX-09, UX-10, UX-11 |
| 5 | QC-04, QC-05, PL-01, PL-02, PL-03, PL-04 |

`IT-08` is delivered with the analysis-session persistence work spanning Phases 2 and 4. The remainder of `IT-09` is handled by Phase 1 preflight and expanded through the manual Premiere matrix.

## Out of scope

- macOS packaging or validation.
- Replacing CEP with UXP.
- Implementing FCPXML or AAF generation in this program.
- Cloud processing, collaboration, telemetry, or account systems.
- Unrelated visual redesign beyond the review-first workflow and waveform requirements.

## Merge strategy

All planning work begins on `codex/audit-remediation-plan` in the isolated worktree. Implementation should use one feature branch or stacked worktree per phase, rebased from the accepted plan branch as appropriate. Each phase has its own green-test checkpoint and can be reviewed independently. The final integration merges only after automated tests and the corresponding Premiere smoke matrix pass.
