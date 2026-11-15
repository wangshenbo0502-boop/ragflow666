# Local chat media

Start from the repository root in PowerShell:

```powershell
.\tools\scripts\start-local-project.ps1
```

Open `http://localhost/`. In a saved chat, type `@` and choose a tool, then enter the content and send:

```text
@生图 一列高铁穿过青山，写实摄影
@语音 高铁和动车有什么区别？
@语音 用温柔的台湾女生口吻，开心地说一句晚安
@语音 唱一段 20 秒的中文甜美女声晚安歌
@生图 横版 2K 高铁旅行海报，标题“向山而行”
@生图 把上一张改成夕阳，列车和标题保持不变
```

Images and audio remain in the conversation after refresh. The speaker button on a text reply reads the reply using the configured default Qwen3-TTS model.

`@语音` sends the question to the selected chat model with the current knowledge bases and conversation history, then synthesizes the answer. The reply retains its text, citations, and a playable audio attachment. The command does not change the chat model.

Speech uses Qwen3-TTS 1.7B CustomVoice Q6_K with Serena. Before each song, the backend synthesizes a fixed Serena speech sample and sends it to ACE-Step as multipart `ref_audio`, alongside the requested lyrics and musical style. This conditions the singing model on Serena's actual timbre in addition to the female vocal description. If reference synthesis fails, song generation stops with an error instead of generating an unrelated voice. The engines are different, so their timbres cannot be guaranteed to match exactly; this does not reproduce a real person's voice or guarantee a Taiwanese accent. Reply playback uses the same Serena style and preserves sentence punctuation.

Explicit singing requests use the local native ACE-Step engine with generated lyrics and music instructions, producing a short WAV song. Song duration is limited to 10–45 seconds.

Image generation and editing exclusively use `gpt-image-2.5-sunburst`, with high quality and native 2K dimensions by default. There is no fallback to another image model. Explicit 4K requests use a supported size up to 3840 pixels on the long edge. The selected chat model assembles the creative instruction in a dedicated planning flow, independent of the chat's QA persona, retrieval, and agent routing. The image model receives both the plan and the latest original request to preserve counts, spatial relationships, exact text, exclusions, and edit boundaries.

Creative plans are saved with generated replies and reused during follow-up planning. Edits retain the previous dimensions unless a new size is requested. When an edit uses both the last generated image and new attachments, the previous image is reference 1 and attachments follow in upload order. New creations use only the supplied attachments. These instructions improve fidelity but cannot guarantee that every generated detail will be exact.

Stop the project and its local speech process:

```powershell
.\tools\scripts\stop-local-project.ps1
```

The speech and music supervisor also exits when `docker-ragflow-cpu-1` stops. It does not register a Windows startup task or service. Music models load only during generation and unload between stages; the music server starts with no model weights on the GPU.

The composer accepts multiple files, pasted screenshots, and dropped images. Uploading does not lock the text field. Failed uploads can be retried or removed, and sending waits until every remaining attachment is ready. Sending only attachments asks the selected model to analyze them. Image understanding requires a vision-capable model.

With `@生图`, attached PNG, JPEG, or WebP images are sent as references to the image editing endpoint along with the written request. Without attachments, the command uses text-to-image generation.

The startup script detects proxy Fake-IP DNS results for the configured local model hosts and writes a fresh public-address compose override under `.run/`. This keeps the Go network checks enabled.

Local prerequisites: Docker Desktop, the built Go binary in `bin/`, the built frontend in `web/dist/`, the speech executable and model files under `.run/qwen3tts/`, and `.cache/compose.local-startup.yml`. Private media configuration lives in the ignored `.run/chat-media.env`. Keep its image API key out of version control.

Speech logs: `.run/qwen3tts/server.stderr.log` and `.run/qwen3tts/watch.stderr.log`.
