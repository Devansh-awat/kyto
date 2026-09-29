---
name: voice
description: Speech and audio work — speak text aloud, transcribe a voice message or audio/video file, convert or trim audio. Use for "say this", "transcribe this", "what does this voice memo say", "convert to mp3".
---

> Adapted from coolton's `voice` skill, itself from gorkie's ([techwithanirudh/gorkie](https://github.com/techwithanirudh/gorkie), AGPL-3.0).

# Voice

## Text to speech
Use the `textToSpeech` tool — it posts the audio itself. Only fall back to the sandbox (`pip install gTTS`, then `gTTS(text=…, lang="en").save(path)` and `uploadFile`) if that tool is unavailable or the person wants a file with specific settings.

## Speech to text
1. Get the audio into the sandbox: `getFile` with the Slack file.
2. Convert it to mono 16 kHz WAV: `ffmpeg -y -i in.m4a -ac 1 -ar 16000 out.wav`.
3. Transcribe. Prefer a local model so the audio stays in the sandbox: `pip install -q faster-whisper`, then

```bash
python3 - <<'PY'
from faster_whisper import WhisperModel
model = WhisperModel("base", compute_type="int8")
segments, info = model.transcribe("out.wav")
print(info.language)
print(" ".join(s.text.strip() for s in segments))
PY
```

   Use `small` for accents or noisy audio if `base` struggles.

## Conversion
ffmpeg covers conversion, trimming (`-ss 00:01:00 -t 30`), sample rate and diagnostics (`ffprobe`). Send results back with `uploadFile`; Slack plays mp3 and m4a inline.

## Notes
- If transcription fails, say whether it was the conversion, silence/noise, or the model.
- These are tools used to produce an answer, not software being built — fine to run.
