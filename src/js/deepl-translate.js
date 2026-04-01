/**
 * DeepL Translate client
 * Supports both Free and Pro endpoints based on auth key format.
 */
export class DeepLTranslateClient {
    constructor() {
        this.apiKey = '';
    }

    configure({ apiKey }) {
        this.apiKey = apiKey || '';
    }

    _getEndpoint() {
        // DeepL Free keys usually end with ":fx"
        if (this.apiKey.endsWith(':fx')) {
            return 'https://api-free.deepl.com/v2/translate';
        }
        return 'https://api.deepl.com/v2/translate';
    }

    _toDeepLTarget(code) {
        const c = (code || 'EN').toUpperCase();
        if (c === 'EN') return 'EN-US';
        if (c === 'PT') return 'PT-BR';
        if (c === 'ZH') return 'ZH';
        return c;
    }

    async translateText(text, { sourceLanguage = 'auto', targetLanguage = 'vi' } = {}) {
        if (!this.apiKey) {
            throw new Error('DeepL API key is missing');
        }
        if (!text || !text.trim()) {
            return '';
        }

        const params = new URLSearchParams();
        params.append('text', text);
        params.append('target_lang', this._toDeepLTarget(targetLanguage));

        if (sourceLanguage && sourceLanguage !== 'auto') {
            params.append('source_lang', sourceLanguage.toUpperCase());
        }

        const res = await fetch(this._getEndpoint(), {
            method: 'POST',
            headers: {
                'Authorization': `DeepL-Auth-Key ${this.apiKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
        });

        if (!res.ok) {
            let detail = '';
            try {
                const errData = await res.json();
                detail = errData?.message || '';
            } catch {
                // Ignore parse error and fallback to status below.
            }
            throw new Error(detail || `DeepL request failed (${res.status})`);
        }

        const data = await res.json();
        return data?.translations?.[0]?.text || '';
    }
}

export const deepLTranslateClient = new DeepLTranslateClient();
