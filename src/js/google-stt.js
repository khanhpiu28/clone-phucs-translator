/**
 * Google Cloud Speech-to-Text (recognize) client for PCM linear16 16kHz.
 * We use the synchronous recognize endpoint on short segments triggered by
 * silence/timeout to approximate near-real-time translation.
 */
export class GoogleSttClient {
    constructor() {
        this.apiKey = '';
    }

    configure({ apiKey }) {
        this.apiKey = apiKey || '';
    }

    _bytesToBase64(bytes) {
        // Convert Uint8Array to base64 in safe chunks.
        const chunkSize = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
            const sub = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, sub);
        }
        return btoa(binary);
    }

    _languageCodeFromIso(isoCode) {
        const code = (isoCode || '').toLowerCase();
        if (!code || code === 'auto') return 'und';
        if (code === 'vi') return 'vi-VN';
        if (code === 'en') return 'en-US';
        if (code === 'ja') return 'ja-JP';
        if (code === 'ko') return 'ko-KR';
        if (code === 'zh') return 'zh-CN';
        // Best-effort guess for ISO639-1 -> region-less language tags.
        return code;
    }

    async recognizePcm16kLinear16(pcmBytes, { languageCode = 'und' } = {}) {
        if (!this.apiKey) throw new Error('Google STT API key is missing');
        if (!pcmBytes || pcmBytes.byteLength === 0) return '';

        const url = `https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(this.apiKey)}`;
        const contentBase64 = this._bytesToBase64(pcmBytes);

        const body = {
            config: {
                encoding: 'LINEAR16',
                sampleRateHertz: 16000,
                languageCode,
                // Faster "short" utterances.
                model: 'short',
            },
            audio: { content: contentBase64 },
        };

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            let detail = '';
            try {
                const errData = await res.json();
                detail = errData?.error?.message || '';
            } catch {
                // ignore
            }
            throw new Error(detail || `Google STT request failed (${res.status})`);
        }

        const data = await res.json();
        const transcripts = (data?.results || [])
            .flatMap(r => r?.alternatives || [])
            .map(a => a?.transcript)
            .filter(Boolean);

        return transcripts.join(' ').trim();
    }

    buildLanguageCode(sourceLanguage) {
        return this._languageCodeFromIso(sourceLanguage);
    }
}

export const googleSttClient = new GoogleSttClient();

