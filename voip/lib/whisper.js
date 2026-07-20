// Voicemail transcription via OpenAI Whisper (needs OPENAI_API_KEY).
// audioBuffer: Buffer, filename hint helps the API pick a decoder.

async function transcribe(audioBuffer, filename = "voicemail.mp3") {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");

  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), filename);
  form.append("model", "whisper-1");
  form.append("language", "en");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    throw new Error(`Whisper failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json();
  return (json.text || "").trim();
}

module.exports = { transcribe };
