# Classroom UI and IT-classroom tone revision

## Changes

- Entry name card: prominent amber reminder before input, approved placeholder “例：ぽむ、もふ、ぴよたろう”, first-time/returning instructions and note/screenshot reminder below. Removed redundant real-name disclaimer. Identity, name recovery, consent, login and session routing behavior unchanged.
- Pre-class audio check: explicitly labelled start and stop buttons side by side; stop is always visible and enabled during permission wait, five-second capture and transcription. Existing cancellation and stale-result handling retained. Lecture capture controls remain separate.
- App footer: explicit “アプリを完全終了” button through validated control-window IPC. Native confirmation defaults to cancel and explains that only this PC's app/capture/projection/QR stop; server classroom completion is a separate explicit action. Confirming stops local processes and exits; cancelling changes no class state. No new Ctrl+Q binding.
- Completed/not-running session snapshots no longer arm a future local deadline merely because a class has a start time. This fixes pre-check refusal after a manually completed class before its original 120-minute deadline. Actual in-progress current classes still retain their deadline.
- Lecture bridge prompt: ambiguous short posts should not be labelled input mistakes, malfunction or “broken” participants. Use light student language with a clear IT-learning/classroom direction, not phone/input-assist chatter alone. Real technical questions and available lecture concepts keep priority. Ten generic bridge fallback texts now explicitly reference IT/information technology learning. Existing cross-worker rotation retained; empathy and neutral text pools unchanged. Model, five-second deadline, single JSON reply, keyword selection, speech-first/PDF timing and no-meta safeguards unchanged. Prompt metadata becomes reaction-v16-it-classroom-tone / reaction-fallback-v16.
- Desktop package version 0.1.1; output is SupporTalk-0.1.1-portable.exe. No new dependencies, database migrations or environment variables.

## Verification

39 local scripts pass including the actual entry React render, actual control listeners, validated Electron quit/cancel/cleanup with no server mutation, completed-snapshot deadline clearing, capture cancellation regressions, ten fallback candidates and durable rotation, temporal lecture/PDF guards, participant identity and 150-client local rehearsal. TypeScript, ESLint and production Next build pass.

These tests replace hardware/network/model boundaries where noted. They do not establish actual Windows portable app/Teams/microphone/projector behavior or real generated reply quality. Test the rebuilt 0.1.1 app after deployment: check stop during capture and recognition, confirmed/cancelled app exit, QR/post/projection, lecture audio, then two-PC Teams screen sharing. Professor app should run on the professor-role PC only during this rehearsal.

## Apply and publish

Use Update-ClassroomUIAndControls.ps1 at project root. It validates all previous text hashes before writing, backs up outside the project and rolls back on a write error. No Git mutations or remote changes in the script.
After applying: run node tests/classroom-ui-v2.mjs and npm run build; explicitly stage the listed patch files, commit and push reaction-ai-prototype; wait for the matching supportalk production deployment Ready. Completely exit existing desktop copies, run npm run overlay:dist, and launch the new 0.1.1 executable on the test PC before giving it to the professor. Preserve the Vercel origin and teacher credentials in existing local saved configuration; do not distribute the project, .env files or local user-data directory.
