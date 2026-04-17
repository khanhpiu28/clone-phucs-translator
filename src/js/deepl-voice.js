/**
 * DeepL Voice API client (real-time speech transcription + translation).
 * Uses two-step flow:
 *  1) POST /v3/voice/realtime to get streaming_url + token
 *  2) WebSocket streaming to send audio and receive transcript updates
 *
 * We only use transcript updates and leave "speaking" to the app's TTS providers.
 */
export class DeepLVoiceClient {
    constructor() {
        this.apiKey = '';
        this.ws = null;
        this.sessionEnded = false;
        this._sourceQueue = [];
        this._targetQueue = [];

        this.onStatusChange = null; // (status) => {}
        this.onError = null; // (message) => {}
        this.onSegment = null; // ({ sourceText, targetText, sourceLanguage }) => {}
        this._sourceLanguageForConfig = null;
        this._targetLanguageForConfig = null;
    }

    configure({ apiKey }) {
        this.apiKey = apiKey || '';
    }

    async start({ sourceLanguage = 'auto', targetLanguage = 'vi', sourceLanguageMode = 'auto' } = {}) {
        if (!this.apiKey) throw new Error('DeepL Voice API key is missing');
        if (this.ws) this.disconnect();

        this.sessionEnded = false;
        this._sourceQueue = [];
        this._targetQueue = [];

        this._setStatus('connecting');

        // Pick placeholders for source_language; when using auto mode, DeepL uses the mode for detection.
        const sourceLangForConfig = sourceLanguage === 'auto' ? 'en' : sourceLanguage;

        const res = await fetch('https://api.deepl.com/v3/voice/realtime', {
            method: 'POST',
            headers: {
                'Authorization': `DeepL-Auth-Key ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message_format: 'json',
                source_media_content_type: 'audio/pcm; encoding=s16le; rate=16000',
                source_language: sourceLangForConfig,
                source_language_mode: sourceLanguageMode,
                target_languages: [targetLanguage],
                // Target media fields intentionally omitted: we only need transcripts.
            }),
        });

        if (!res.ok) {
            let detail = '';
            try {
                const errData = await res.json();
                detail = errData?.message || errData?.error?.message || '';
            } catch {
                // ignore
            }
            throw new Error(detail || `DeepL Voice request failed (${res.status})`);
        }

        const data = await res.json();
        const streamingUrl = data?.streaming_url;
        const token = data?.token;
        if (!streamingUrl || !token) {
            throw new Error('DeepL Voice session did not return streaming_url/token');
        }

        const wsUrl = `${streamingUrl}?token=${encodeURIComponent(token)}`;
        this._sourceLanguageForConfig = sourceLanguage;
        this._targetLanguageForConfig = targetLanguage;

        // Connect websocket
        const ws = new WebSocket(wsUrl);
        this.ws = ws;

        ws.onopen = () => {
            if (this.sessionEnded) return;
            this._setStatus('connected');
        };

        ws.onerror = () => {
            this._setStatus('error');
            this.onError?.('DeepL Voice WebSocket error');
        };

        ws.onmessage = (event) => {
            if (this.sessionEnded) return;
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch (e) {
                // Ignore non-JSON frames
                return;
            }

            if (msg?.error) {
                this._setStatus('error');
                const reason = msg?.error?.error_message || msg?.error?.reason_code || 'Unknown error';
                this.onError?.(`DeepL Voice error: ${reason}`);
                return;
            }

            if (msg?.source_transcript_update) {
                const update = msg.source_transcript_update;
                const concluded = update?.concluded || [];
                for (const seg of concluded) {
                    if (seg?.text && seg.text.trim()) {
                        this._sourceQueue.push({
                            sourceText: seg.text.trim(),
                            sourceLanguage: seg.language || null,
                        });
                    }
                }
                // Tentative updates could be shown as provisional, but we keep it simple for now.
                this._tryEmitSegments();
            }

            if (msg?.target_transcript_update) {
                const update = msg.target_transcript_update;
                // The message schema supports multiple target languages; we merge all concluded text.
                const languages = update?.concluded || update?.concluded_languages || update?.concluded_by_language;
                // The exact structure depends on DeepL's payload; we use a best-effort:
                const concludedSegments = update?.concluded_segments || update?.concluded || [];
                // If it's already an array of segments:
                const segs = Array.isArray(concludedSegments) ? concludedSegments : [];
                for (const seg of segs) {
                    if (seg?.text && seg.text.trim()) {
                        this._targetQueue.push({ targetText: seg.text.trim() });
                    }
                }

                // Another fallback: if update has `concluded` as an object with language keys.
                if (this._targetQueue.length === 0 && update?.concluded && typeof update.concluded === 'object' && !Array.isArray(update.concluded)) {
                    const values = Object.values(update.concluded).flat();
                    for (const seg of values) {
                        if (seg?.text && seg.text.trim()) this._targetQueue.push({ targetText: seg.text.trim() });
                    }
                }

                this._tryEmitSegments();
            }

            if (msg?.end_of_stream !== undefined) {
                this._setStatus('disconnected');
                this.sessionEnded = true;
            }
        };
    }

    sendAudio(pcmBytes) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!pcmBytes || pcmBytes.byteLength === 0) return;

        // DeepL expects base64 audio data for JSON message_format.
        const base64 = this._bytesToBase64(pcmBytes);
        const payload = {
            source_media_chunk: { data: base64 },
        };
        this.ws.send(JSON.stringify(payload));
    }

    end() {
        this.sessionEnded = true;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ end_of_source_media: {} }));
            } catch {
                // ignore
            }
        }
        this.disconnect();
    }

    disconnect() {
        if (this.ws) {
            try {
                this.ws.close(1000, 'Client disconnect');
            } catch {
                // ignore
            }
        }
        this.ws = null;
    }

    _tryEmitSegments() {
        while (this._sourceQueue.length > 0 && this._targetQueue.length > 0) {
            const source = this._sourceQueue.shift();
            const target = this._targetQueue.shift();
            if (source?.sourceText && target?.targetText) {
                this.onSegment?.({
                    sourceText: source.sourceText,
                    targetText: target.targetText,
                    sourceLanguage: source.sourceLanguage,
                });
            }
        }
    }

    _setStatus(status) {
        this.onStatusChange?.(status);
    }

    _bytesToBase64(bytes) {
        const chunkSize = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const sub = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, sub);
        }
        return btoa(binary);
    }
}

export const deepLVoiceClient = new DeepLVoiceClient();

