/**
 * Google Cloud Translate v2 client
 * Uses API key authentication for simple text translation.
 */
export class GoogleTranslateClient {
    constructor() {
        this.apiKey = '';
    }

    configure({ apiKey }) {
        this.apiKey = apiKey || '';
    }

    async translateText(text, { sourceLanguage = 'auto', targetLanguage = 'vi' } = {}) {
        if (!this.apiKey) {
            throw new Error('Google Translate API key is missing');
        }
        if (!text || !text.trim()) {
            return '';
        }

        const body = {
            q: text,
            target: targetLanguage || 'vi',
            format: 'text',
        };

        if (sourceLanguage && sourceLanguage !== 'auto') {
            body.source = sourceLanguage;
        }

        const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(this.apiKey)}`, {
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
                // Ignore parse error and use status text fallback below
            }
            throw new Error(detail || `Google Translate request failed (${res.status})`);
        }

        const data = await res.json();
        const translated = data?.data?.translations?.[0]?.translatedText || '';
        return translated;
    }
}

export const googleTranslateClient = new GoogleTranslateClient();
