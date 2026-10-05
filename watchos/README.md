# MemoryCast Apple Watch Walkman

This folder is intentionally isolated from the existing web app and AI/quiz modules.

It implements only the Apple Watch Walkman experience:

- loads the existing `GET /api/walkman` queue
- requests MP3 audio from the existing `POST /api/tts/timed`
- plays audio with native `AVAudioPlayer`
- follows the existing TTS timing metadata for subtitle scrolling
- automatically advances to the next card
- offers previous / next and playback-rate controls

The existing web app, quizzes, notes, review flow, and desktop/iPhone behavior are not changed by this module.

## Build

1. Install Xcode 16+ and XcodeGen on a Mac.
2. In this folder run:

   ```bash
   xcodegen generate
   open MemoryCastWatch.xcodeproj
   ```

3. Select your Apple Developer Team under Signing & Capabilities.
4. Select your paired Apple Watch as the run destination.
5. Build and run.

The default API endpoint is configured in:

```
Sources/AppConfig.swift
```

Current default:

```
https://goudan.dpdns.org/api
```

No server-side changes are required for this Watch client because the current MemoryCast API already exposes the Walkman queue and timed TTS endpoint.
