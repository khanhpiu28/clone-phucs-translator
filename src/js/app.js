/**
 * App — main application controller
 * Wires together: settings, UI, Soniox client, and audio capture
 */

import { settingsManager } from './settings.js';
import { TranscriptUI } from './ui.js';
import { sonioxClient } from './soniox.js';
import { elevenLabsTTS } from './elevenlabs-tts.js';
import { googleTTS } from './google-tts.js';
import { googleTranslateClient } from './google-translate.js';
import { deepLTranslateClient } from './deepl-translate.js';
import { googleSttClient } from './google-stt.js';
import { deepLVoiceClient } from './deepl-voice.js';
import { edgeTTSRust } from './edge-tts.js';
import { audioPlayer } from './audio-player.js';
import { updater } from './updater.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

class App {
    constructor() {
        this.isRunning = false;
        this.isStarting = false; // Guard against re-entry
        this.currentSource = 'system'; // 'system' | 'microphone' | 'both'
        this.translationMode = 'soniox'; // 'soniox' | 'soniox_google' | 'soniox_deepl' | 'local'
        this.transcriptUI = null;
        this.appWindow = getCurrentWindow();
        this.localPipelineChannel = null;
        this.localPipelineReady = false;
        this.recordingStartTime = null;
        this.ttsEnabled = false;  // TTS runtime toggle
        this.isPinned = true;     // Always-on-top state
        this.isCompact = false;   // Compact mode (hide control bar)
        this.transparentSubtitleMode = false;
        this.googleTranslateQueue = Promise.resolve();
        this.deepLTranslateQueue = Promise.resolve();
        this.googleSttQueue = Promise.resolve();
        this.googleSttAudioBuffer = [];
        this.googleSttSilenceTimer = null;
        this.googleSttSegmentTimer = null;
        this.lastWindowFocusAt = 0;
        this.windowFocusTapThresholdMs = 550;
    }

    async init() {
        // Load settings
        await settingsManager.load();

        // Init transcript UI
        const transcriptContainer = document.getElementById('transcript-content');
        this.transcriptUI = new TranscriptUI(transcriptContainer);

        // Check platform — hide Local MLX on non-Apple-Silicon
        await this._checkPlatformSupport();

        // Apply saved settings to UI
        this._applySettings(settingsManager.get());

        // Bind event listeners
        this._bindEvents();

        // Bind keyboard shortcuts
        this._bindKeyboardShortcuts();
        this._bindWindowFocusRecovery();

        // Subscribe to settings changes
        settingsManager.onChange((settings) => this._applySettings(settings));

        // Init audio player for TTS
        audioPlayer.init();

        // Wire TTS audio callbacks for providers that use audioPlayer
        for (const tts of [elevenLabsTTS, edgeTTSRust, googleTTS]) {
            tts.onAudioChunk = (base64Audio, isFinal) => {
                audioPlayer.enqueue(base64Audio);
            };
        }
        for (const tts of [elevenLabsTTS, edgeTTSRust, googleTTS]) {
            tts.onError = (error) => {
                console.error('[TTS]', error);
                this._showToast(error, 'error');
            };
        }

        // Window position restore disabled — causes issues on Retina displays
        // await this._restoreWindowPosition();

        // Check for updates (non-blocking)
        this._initAboutTab();
        this._checkForUpdates();

        console.log('🌐 My Translator v0.5.0 initialized');
    }

    async _checkPlatformSupport() {
        try {
            // Check if we're on macOS Apple Silicon
            const arch = await invoke('get_platform_info');
            const info = JSON.parse(arch);
            this.isAppleSilicon = (info.os === 'macos' && info.arch === 'aarch64');
        } catch {
            // Fallback: check via navigator
            this.isAppleSilicon = navigator.platform === 'MacIntel' &&
                navigator.userAgent.includes('Mac OS X');
        }

        if (!this.isAppleSilicon) {
            // Hide Local MLX option
            const select = document.getElementById('select-translation-mode');
            const localOption = select?.querySelector('option[value="local"]');
            if (localOption) localOption.remove();

            // Force soniox mode if user had local selected
            const settings = settingsManager.get();
            if (settings.translation_mode === 'local') {
                settings.translation_mode = 'soniox';
                settingsManager.save(settings);
            }
        }
    }

    // ─── Event Binding ──────────────────────────────────────

    _bindEvents() {
        // Settings button
        document.getElementById('btn-settings').addEventListener('click', () => {
            this._showView('settings');
        });

        // Back from settings
        document.getElementById('btn-back').addEventListener('click', () => {
            this._showView('overlay');
        });

        // Close button (overlay)
        document.getElementById('btn-close').addEventListener('click', async () => {
            if (this.transcriptUI.hasSegments()) {
                await this._saveTranscriptFile();
            }
            await this._saveWindowPosition();
            await this.stop();
            await this.appWindow.close();
        });

        // Minimize button
        document.getElementById('btn-minimize').addEventListener('click', async () => {
            await this._saveWindowPosition();
            await this.appWindow.minimize();
        });

        // Pin/Unpin button
        document.getElementById('btn-pin').addEventListener('click', () => {
            this._togglePin();
        });

        // Compact mode button
        document.getElementById('btn-compact').addEventListener('click', () => {
            this._toggleCompact();
        });

        // View mode toggle (dual panel)
        document.getElementById('btn-view-mode').addEventListener('click', () => {
            this._toggleViewMode();
        });
        document.getElementById('btn-transparent-mode')?.addEventListener('click', () => {
            this._toggleTransparentSubtitleMode();
        });

        // Font size quick controls
        document.getElementById('btn-font-up').addEventListener('click', () => this._adjustFontSize(4));
        document.getElementById('btn-font-down').addEventListener('click', () => this._adjustFontSize(-4));

        // Color dot controls
        document.querySelectorAll('.color-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
                dot.classList.add('active');
                const color = dot.dataset.color;
                this.transcriptUI.configure({ fontColor: color });
            });
        });

        // Start/Stop button
        document.getElementById('btn-start').addEventListener('click', async () => {
            if (this.isStarting) return; // Prevent re-entry
            try {
                if (this.isRunning) {
                    await this.stop();
                } else {
                    this.isStarting = true;
                    await this.start();
                }
            } catch (err) {
                console.error('[App] Start/Stop error:', err);
                this._showToast(`Error: ${err}`, 'error');
                this.isRunning = false;
                this._updateStartButton();
                this._updateStatus('error');
                this.transcriptUI.clear();
                this.transcriptUI.showPlaceholder();
            } finally {
                this.isStarting = false;
            }
        });

        // Source buttons
        document.getElementById('btn-source-system').addEventListener('click', () => {
            this._setSource('system');
        });

        document.getElementById('btn-source-mic').addEventListener('click', () => {
            this._setSource('microphone');
        });
        document.getElementById('btn-source-both').addEventListener('click', () => {
            this._setSource('both');
        });

        // Clear button — save transcript file then clear
        document.getElementById('btn-clear').addEventListener('click', async () => {
            if (this.transcriptUI.hasSegments()) {
                await this._saveTranscriptFile();
            }
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            this.recordingStartTime = null;
        });

        // Copy transcript button
        document.getElementById('btn-copy').addEventListener('click', async () => {
            const text = this.transcriptUI.getPlainText();
            if (text) {
                await navigator.clipboard.writeText(text);
                this._showToast('Copied to clipboard', 'success');
            } else {
                this._showToast('Nothing to copy', 'info');
            }
        });

        // Open saved transcripts folder
        document.getElementById('btn-open-transcripts').addEventListener('click', async () => {
            try {
                await invoke('open_transcript_dir');
            } catch (err) {
                this._showToast('Failed to open folder: ' + err, 'error');
            }
        });

        // Settings form elements
        this._bindSettingsForm();

        // Manual drag for settings view
        // data-tauri-drag-region doesn't work well when parent contains buttons
        // Using Tauri's recommended appWindow.startDragging() approach instead
        document.getElementById('settings-view')?.addEventListener('mousedown', (e) => {
            const interactive = e.target.closest('button, input, select, label, a, textarea, .settings-section, .settings-actions');
            if (!interactive && e.buttons === 1) {
                e.preventDefault();
                this.appWindow.startDragging();
            }
        });

        // Toggle API key visibility
        document.getElementById('btn-toggle-key').addEventListener('click', () => {
            const input = document.getElementById('input-api-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });
        document.getElementById('btn-toggle-google-translate-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-google-translate-key');
            if (!input) return;
            input.type = input.type === 'password' ? 'text' : 'password';
        });
        document.getElementById('btn-toggle-google-stt-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-google-stt-key');
            if (!input) return;
            input.type = input.type === 'password' ? 'text' : 'password';
        });
        document.getElementById('btn-toggle-deepl-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-deepl-key');
            if (!input) return;
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Translation mode toggle
        document.getElementById('select-translation-mode').addEventListener('change', (e) => {
            this._updateModeUI(e.target.value);
        });

        // Translation type toggle (one-way / two-way)
        document.getElementById('select-translation-type')?.addEventListener('change', (e) => {
            this._updateTranslationTypeUI(e.target.value);
        });

        // Soniox link
        document.getElementById('link-soniox').addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://console.soniox.com/signup/');
        });

        // ElevenLabs link
        document.getElementById('link-elevenlabs')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://elevenlabs.io/app/sign-up');
        });

        // Save settings — both top and bottom buttons
        document.getElementById('btn-save-settings').addEventListener('click', () => {
            this._saveSettingsFromForm();
        });
        document.getElementById('btn-save-settings-top')?.addEventListener('click', () => {
            this._saveSettingsFromForm();
        });

        // Slider live updates
        document.getElementById('range-opacity').addEventListener('input', (e) => {
            document.getElementById('opacity-value').textContent = `${e.target.value}%`;
        });

        document.getElementById('range-font-size').addEventListener('input', (e) => {
            document.getElementById('font-size-value').textContent = `${e.target.value}px`;
        });

        document.getElementById('range-max-lines').addEventListener('input', (e) => {
            document.getElementById('max-lines-value').textContent = e.target.value;
        });
        document.getElementById('check-transparent-subtitle')?.addEventListener('change', (e) => {
            this._setTransparentSubtitleMode(e.target.checked, { persist: false });
        });

        document.getElementById('range-endpoint-delay')?.addEventListener('input', (e) => {
            document.getElementById('endpoint-delay-value').textContent = `${(e.target.value / 1000).toFixed(1)}s`;
        });

        // Toggle ElevenLabs API key visibility
        document.getElementById('btn-toggle-elevenlabs-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-elevenlabs-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('btn-toggle-google-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-google-tts-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Settings tab switching
        document.querySelectorAll('.settings-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab)?.classList.add('active');
            });
        });

        // TTS enable/disable toggle in settings — show/hide detail
        document.getElementById('check-tts-enabled')?.addEventListener('change', (e) => {
            const detail = document.getElementById('tts-settings-detail');
            if (detail) detail.style.display = e.target.checked ? '' : 'none';
        });

        // TTS provider toggle — show/hide relevant settings panels
        document.getElementById('select-tts-provider')?.addEventListener('change', (e) => {
            this._updateTTSProviderUI(e.target.value);
        });

        // TTS speed slider — show value
        document.getElementById('range-tts-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('tts-speed-value');
            if (label) label.textContent = e.target.value + 'x';
        });

        // Edge TTS speed slider
        document.getElementById('range-edge-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('edge-speed-value');
            const v = parseInt(e.target.value);
            if (label) label.textContent = (v >= 0 ? '+' : '') + v + '%';
        });

        document.getElementById('range-google-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('google-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });

        // Add translation term row
        document.getElementById('btn-add-term')?.addEventListener('click', () => {
            this._addTermRow('', '');
        });

        // Add general context row
        document.getElementById('btn-add-general')?.addEventListener('click', () => {
            this._addGeneralRow('', '');
        });

        // TTS toggle button in overlay
        document.getElementById('btn-tts').addEventListener('click', () => {
            this._toggleTTS();
        });

        // Wire Soniox callbacks
        sonioxClient.onOriginal = (text, speaker, language) => {
            this.transcriptUI.addOriginal(text, speaker, language);
            if (this.translationMode === 'soniox_google') {
                this._enqueueGoogleTranslation(text);
            } else if (this.translationMode === 'google_soniox') {
                this._enqueueGoogleTranslation(text);
            } else if (this.translationMode === 'soniox_deepl') {
                this._enqueueDeepLTranslation(text);
            } else if (this.translationMode === 'deepl_soniox') {
                this._enqueueDeepLTranslation(text);
            } else if (this.translationMode === 'soniox_google_deepl') {
                this._enqueueGoogleThenDeepLTranslation(text);
            } else if (this.translationMode === 'google_deepl') {
                this._enqueueGoogleThenDeepLTranslation(text);
            } else if (this.translationMode === 'soniox_deepl_google') {
                this._enqueueDeepLThenGoogleTranslation(text);
            }
        };

        sonioxClient.onTranslation = (text) => {
            if (
                this.translationMode === 'soniox_google'
                || this.translationMode === 'google_soniox'
                || this.translationMode === 'soniox_deepl'
                || this.translationMode === 'deepl_soniox'
                || this.translationMode === 'soniox_google_deepl'
                || this.translationMode === 'google_deepl'
                || this.translationMode === 'soniox_deepl_google'
            ) return;
            this.transcriptUI.addTranslation(text);
            this._speakIfEnabled(text);
        };

        sonioxClient.onProvisional = (text, speaker, language) => {
            if (text) {
                this.transcriptUI.setProvisional(text, speaker, language);
            } else {
                this.transcriptUI.clearProvisional();
            }
        };

        sonioxClient.onStatusChange = (status) => {
            this._updateStatus(status);
        };

        sonioxClient.onError = (error) => {
            this._showToast(error, 'error');
        };

        sonioxClient.onConfidence = (avgConfidence) => {
            this.transcriptUI.setConfidence(avgConfidence);
        };
    }

    _bindSettingsForm() {
        // These are handled in _populateSettingsForm and _saveSettingsFromForm
    }

    // ─── Keyboard Shortcuts ─────────────────────────────────

    _bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ignore when typing in input fields
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

            // Cmd/Ctrl + Enter: Start/Stop
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (this.isStarting) return;
                (async () => {
                    try {
                        if (this.isRunning) {
                            await this.stop();
                        } else {
                            this.isStarting = true;
                            await this.start();
                        }
                    } catch (err) {
                        console.error('[App] Keyboard start/stop error:', err);
                        this._showToast(`Error: ${err}`, 'error');
                        this.isRunning = false;
                        this._updateStartButton();
                        this._updateStatus('error');
                    } finally {
                        this.isStarting = false;
                    }
                })();
            }

            // Escape: Go back to overlay / close settings
            if (e.key === 'Escape') {
                e.preventDefault();
                const settingsVisible = document.getElementById('settings-view').classList.contains('active');
                if (settingsVisible) {
                    this._showView('overlay');
                }
            }

            // Cmd/Ctrl + ,: Open settings
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                e.preventDefault();
                this._showView('settings');
            }

            // Cmd/Ctrl + 1: Switch to System Audio
            if ((e.metaKey || e.ctrlKey) && e.key === '1') {
                e.preventDefault();
                this._setSource('system');
            }

            // Cmd/Ctrl + 2: Switch to Microphone
            if ((e.metaKey || e.ctrlKey) && e.key === '2') {
                e.preventDefault();
                this._setSource('microphone');
            }

            // Cmd/Ctrl + 3: Switch to Both
            if ((e.metaKey || e.ctrlKey) && e.key === '3') {
                e.preventDefault();
                this._setSource('both');
            }

            // Cmd/Ctrl + T: Toggle TTS
            if ((e.metaKey || e.ctrlKey) && e.key === 't') {
                e.preventDefault();
                this._toggleTTS();
            }

            // Cmd/Ctrl + M: Minimize
            if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
                e.preventDefault();
                this._saveWindowPosition();
                this.appWindow.minimize();
            }

            // Cmd/Ctrl + P: Toggle Pin
            if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
                e.preventDefault();
                this._togglePin();
            }

            // Cmd/Ctrl + D: Toggle Compact
            if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
                e.preventDefault();
                this._toggleCompact();
            }
        });
    }

    // ─── Views ──────────────────────────────────────────────

    _showView(view) {
        document.getElementById('overlay-view').classList.toggle('active', view === 'overlay');
        document.getElementById('settings-view').classList.toggle('active', view === 'settings');

        if (view === 'settings') {
            this._populateSettingsForm();
        }
    }

    // ─── Settings Form ─────────────────────────────────────

    _populateSettingsForm() {
        const s = settingsManager.get();

        document.getElementById('input-api-key').value = s.soniox_api_key || '';
        const googleSttKeyInput = document.getElementById('input-google-stt-key');
        if (googleSttKeyInput) googleSttKeyInput.value = s.google_stt_api_key || '';
        const googleTranslateKeyInput = document.getElementById('input-google-translate-key');
        if (googleTranslateKeyInput) googleTranslateKeyInput.value = s.google_translate_api_key || '';
        const deepLKeyInput = document.getElementById('input-deepl-key');
        if (deepLKeyInput) deepLKeyInput.value = s.deepl_api_key || '';
        document.getElementById('select-source-lang').value = s.source_language || 'auto';
        document.getElementById('select-target-lang').value = s.target_language || 'vi';
        document.getElementById('select-translation-mode').value = s.translation_mode || 'soniox';
        this._updateModeUI(s.translation_mode || 'soniox');

        // Translation type (one-way / two-way)
        const translationType = s.translation_type || 'one_way';
        document.getElementById('select-translation-type').value = translationType;
        this._updateTranslationTypeUI(translationType);

        // Two-way language selects
        document.getElementById('select-lang-a').value = s.language_a || 'ja';
        document.getElementById('select-lang-b').value = s.language_b || 'vi';

        // Strict language detection
        document.getElementById('check-strict-lang').checked = s.language_hints_strict || false;

        // Endpoint delay
        const endpointDelay = s.endpoint_delay || 3000;
        const delaySlider = document.getElementById('range-endpoint-delay');
        if (delaySlider) delaySlider.value = endpointDelay;
        const delayValue = document.getElementById('endpoint-delay-value');
        if (delayValue) delayValue.textContent = `${(endpointDelay / 1000).toFixed(1)}s`;

        // Audio source radio
        const radioValue = s.audio_source || 'system';
        const radio = document.querySelector(`input[name="audio-source"][value="${radioValue}"]`);
        if (radio) radio.checked = true;

        // Display
        const opacityPercent = Math.round((s.overlay_opacity || 0.85) * 100);
        document.getElementById('range-opacity').value = opacityPercent;
        document.getElementById('opacity-value').textContent = `${opacityPercent}%`;

        document.getElementById('range-font-size').value = s.font_size || 16;
        document.getElementById('font-size-value').textContent = `${s.font_size || 16}px`;

        document.getElementById('range-max-lines').value = s.max_lines || 5;
        document.getElementById('max-lines-value').textContent = s.max_lines || 5;

        document.getElementById('check-show-original').checked = s.show_original !== false;
        document.getElementById('check-transparent-subtitle').checked = !!s.transparent_subtitle_mode;

        // Custom context (rich format)
        const ctx = s.custom_context;
        // General context rows
        const generalList = document.getElementById('context-general-list');
        if (generalList) {
            generalList.innerHTML = '';
            const generalPairs = ctx?.general || [];
            generalPairs.forEach(g => this._addGeneralRow(g.key, g.value));
        }
        // Transcription terms
        const termsInput = document.getElementById('input-context-terms');
        if (termsInput) {
            termsInput.value = (ctx?.terms || []).join('\n');
        }
        // Background text
        const textInput = document.getElementById('input-context-text');
        if (textInput) {
            textInput.value = ctx?.text || '';
        }
        // Load translation terms as rows
        const termsList = document.getElementById('translation-terms-list');
        if (termsList) {
            termsList.innerHTML = '';
            const terms = ctx?.translation_terms || [];
            terms.forEach(t => this._addTermRow(t.source, t.target));
        }

        // TTS settings
        document.getElementById('input-elevenlabs-key').value = s.elevenlabs_api_key || '';
        document.getElementById('select-tts-voice').value = s.tts_voice_id || '21m00Tcm4TlvDq8ikWAM';
        // Edge TTS settings
        const edgeVoiceSelect = document.getElementById('select-edge-voice');
        if (edgeVoiceSelect) edgeVoiceSelect.value = s.edge_tts_voice || 'vi-VN-HoaiMyNeural';
        const edgeSpeedSlider = document.getElementById('range-edge-speed');
        const edgeSpeedLabel = document.getElementById('edge-speed-value');
        const edgeSpeed = s.edge_tts_speed !== undefined ? s.edge_tts_speed : 20;
        if (edgeSpeedSlider) edgeSpeedSlider.value = edgeSpeed;
        if (edgeSpeedLabel) edgeSpeedLabel.textContent = (edgeSpeed >= 0 ? '+' : '') + edgeSpeed + '%';

        // Google TTS settings
        const googleKeyInput = document.getElementById('input-google-tts-key');
        if (googleKeyInput) googleKeyInput.value = s.google_tts_api_key || '';
        const googleVoiceSelect = document.getElementById('select-google-voice');
        if (googleVoiceSelect) googleVoiceSelect.value = s.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
        const googleSpeedSlider = document.getElementById('range-google-speed');
        const googleSpeedLabel = document.getElementById('google-speed-value');
        const googleSpeed = s.google_tts_speed || 1.0;
        if (googleSpeedSlider) googleSpeedSlider.value = googleSpeed;
        if (googleSpeedLabel) googleSpeedLabel.textContent = googleSpeed + 'x';

        // TTS provider
        const providerSelect = document.getElementById('select-tts-provider');
        if (providerSelect) {
            providerSelect.value = s.tts_provider || 'edge';
            this._updateTTSProviderUI(providerSelect.value);
        }
    }

    async _saveSettingsFromForm() {
        const settings = {
            soniox_api_key: document.getElementById('input-api-key').value.trim(),
            google_stt_api_key: document.getElementById('input-google-stt-key')?.value.trim() || '',
            google_translate_api_key: document.getElementById('input-google-translate-key')?.value.trim() || '',
            deepl_api_key: document.getElementById('input-deepl-key')?.value.trim() || '',
            source_language: document.getElementById('select-source-lang').value,
            target_language: document.getElementById('select-target-lang').value,
            translation_mode: document.getElementById('select-translation-mode').value,
            translation_type: document.getElementById('select-translation-type')?.value || 'one_way',
            language_a: document.getElementById('select-lang-a')?.value || 'ja',
            language_b: document.getElementById('select-lang-b')?.value || 'vi',
            language_hints_strict: document.getElementById('check-strict-lang')?.checked || false,
            endpoint_delay: parseInt(document.getElementById('range-endpoint-delay')?.value || 3000),
            audio_source: document.querySelector('input[name="audio-source"]:checked')?.value || 'system',
            overlay_opacity: parseInt(document.getElementById('range-opacity').value) / 100,
            font_size: parseInt(document.getElementById('range-font-size').value),
            max_lines: parseInt(document.getElementById('range-max-lines').value),
            show_original: document.getElementById('check-show-original').checked,
            transparent_subtitle_mode: document.getElementById('check-transparent-subtitle')?.checked || false,
            custom_context: null,
        };

        // Parse custom context (rich format)
        // General key-value pairs
        const generalPairs = [];
        document.querySelectorAll('#context-general-list .general-row').forEach(row => {
            const key = row.querySelector('.general-key')?.value.trim();
            const value = row.querySelector('.general-value')?.value.trim();
            if (key && value) generalPairs.push({ key, value });
        });

        // Transcription terms
        const termsRaw = document.getElementById('input-context-terms')?.value.trim() || '';
        const terms = termsRaw ? termsRaw.split('\n').map(t => t.trim()).filter(t => t) : [];

        // Background text
        const contextText = document.getElementById('input-context-text')?.value.trim() || '';

        // Translation terms
        const translationTerms = [];
        document.querySelectorAll('#translation-terms-list .term-row').forEach(row => {
            const source = row.querySelector('.term-source')?.value.trim();
            const target = row.querySelector('.term-target')?.value.trim();
            if (source && target) translationTerms.push({ source, target });
        });

        if (generalPairs.length > 0 || terms.length > 0 || contextText || translationTerms.length > 0) {
            settings.custom_context = {
                general: generalPairs,
                terms: terms,
                text: contextText || null,
                translation_terms: translationTerms,
            };
        }

        // TTS settings
        settings.tts_provider = document.getElementById('select-tts-provider')?.value || 'edge';
        settings.elevenlabs_api_key = document.getElementById('input-elevenlabs-key').value.trim();
        settings.tts_voice_id = document.getElementById('select-tts-voice').value;
        settings.edge_tts_voice = document.getElementById('select-edge-voice')?.value || 'vi-VN-HoaiMyNeural';
        settings.edge_tts_speed = parseInt(document.getElementById('range-edge-speed')?.value || 20);
        settings.tts_speed = parseFloat(document.getElementById('range-tts-speed')?.value || 1.2);
        settings.google_tts_api_key = document.getElementById('input-google-tts-key')?.value.trim() || '';
        settings.google_tts_voice = document.getElementById('select-google-voice')?.value || 'vi-VN-Chirp3-HD-Aoede';
        settings.google_tts_speed = parseFloat(document.getElementById('range-google-speed')?.value || 1.0);
        settings.tts_enabled = false;

        try {
            await settingsManager.save(settings);
            this._showToast('Settings saved', 'success');
            this._showView('overlay');
        } catch (err) {
            this._showToast(`Failed to save: ${err}`, 'error');
        }
    }

    // ─── Apply Settings ────────────────────────────────────

    _applySettings(settings) {
        // Update overlay opacity
        const overlayView = document.getElementById('overlay-view');
        overlayView.style.opacity = settings.overlay_opacity || 0.85;

        // Update transcript UI
        if (this.transcriptUI) {
            this.transcriptUI.configure({
                maxLines: settings.max_lines || 5,
                showOriginal: settings.show_original !== false,
                fontSize: settings.font_size || 16,
            });
        }

        this._setTransparentSubtitleMode(!!settings.transparent_subtitle_mode, { persist: false });

        // Update current source button states
        this.currentSource = settings.audio_source || 'system';
        this._updateSourceButtons();

        // TTS is always OFF on app start — user must toggle on each session
        this.ttsEnabled = false;
        this._updateTTSButton();
    }

    // ─── TTS Control ──────────────────────────────────────

    _toggleTTS() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';

        // Block TTS in two-way mode to prevent audio feedback loop
        const translationType = document.getElementById('select-translation-type')?.value;
        if (translationType === 'two_way') {
            this._showToast('TTS is disabled in two-way mode to prevent audio loop', 'error');
            return;
        }

        // Check API key for premium providers
        if (provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            this._showToast('Add ElevenLabs API key in Settings → TTS', 'error');
            this._showView('settings');
            return;
        }
        if (provider === 'google' && !settings.google_tts_api_key) {
            this._showToast('Add Google TTS API key in Settings → TTS', 'error');
            this._showView('settings');
            return;
        }

        this.ttsEnabled = !this.ttsEnabled;
        this._updateTTSButton();

        const tts = this._getActiveTTS();

        if (this.ttsEnabled) {
            this._configureTTS(tts, settings);
            if (this.isRunning) {
                tts.connect();
                audioPlayer.resume();
            }
            const label = { edge: 'Edge TTS (Free)', google: 'Google Chirp 3 HD', elevenlabs: 'ElevenLabs' }[provider] || provider;
            this._showToast(`TTS narration ON 🔊 (${label})`, 'success');
        } else {
            tts.disconnect();
            audioPlayer.stop();
            this._showToast('TTS narration OFF 🔇', 'success');
        }
    }

    _getActiveTTS() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';
        if (provider === 'elevenlabs') return elevenLabsTTS;
        if (provider === 'google') return googleTTS;
        return edgeTTSRust;
    }

    _configureTTS(tts, settings) {
        const provider = settings.tts_provider || 'edge';
        if (provider === 'elevenlabs') {
            tts.configure({
                apiKey: settings.elevenlabs_api_key,
                voiceId: settings.tts_voice_id || '21m00Tcm4TlvDq8ikWAM',
            });
        } else if (provider === 'google') {
            const voice = settings.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
            const langCode = voice.replace(/-Chirp3.*/, '');
            tts.configure({
                apiKey: settings.google_tts_api_key,
                voice: voice,
                languageCode: langCode,
                speakingRate: settings.google_tts_speed || 1.0,
            });
        } else {
            tts.configure({
                voice: settings.edge_tts_voice || 'vi-VN-HoaiMyNeural',
                speed: settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20,
            });
        }
    }

    _addTermRow(source = '', target = '') {
        const list = document.getElementById('translation-terms-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'term-row';
        row.innerHTML = `<input type="text" class="term-source" value="${source}" placeholder="Source" />` +
            `<input type="text" class="term-target" value="${target}" placeholder="Target" />` +
            `<button type="button" class="btn-remove-term" title="Remove">×</button>`;
        row.querySelector('.btn-remove-term').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    _addGeneralRow(key = '', value = '') {
        const list = document.getElementById('context-general-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'general-row';
        row.innerHTML = `<input type="text" class="general-key" value="${this._escAttr(key)}" placeholder="Key (e.g. domain)" />` +
            `<input type="text" class="general-value" value="${this._escAttr(value)}" placeholder="Value (e.g. Medical)" />` +
            `<button type="button" class="btn-remove-general" title="Remove">×</button>`;
        row.querySelector('.btn-remove-general').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    _escAttr(str) {
        return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    _updateTTSProviderUI(provider) {
        const ed = document.getElementById('tts-edge-settings');
        const go = document.getElementById('tts-google-settings');
        const el = document.getElementById('tts-elevenlabs-settings');
        if (ed) ed.style.display = provider === 'edge' ? '' : 'none';
        if (go) go.style.display = provider === 'google' ? '' : 'none';
        if (el) el.style.display = provider === 'elevenlabs' ? '' : 'none';
        // Update hint text
        const hint = document.getElementById('tts-provider-hint');
        if (hint) {
            const hints = {
                edge: 'Free, natural voices — no API key needed',
                google: 'Near-human quality — requires Google Cloud API key (1M chars/month free)',
                elevenlabs: 'Premium quality — requires ElevenLabs API key',
            };
            hint.textContent = hints[provider] || '';
        }
    }

    _updateTranslationTypeUI(type) {
        const oneway = document.getElementById('section-oneway-langs');
        const twoway = document.getElementById('section-twoway-langs');
        const hintTwoway = document.getElementById('hint-twoway');
        const strictLang = document.getElementById('section-strict-lang');

        if (type === 'two_way') {
            if (oneway) oneway.style.display = 'none';
            if (twoway) twoway.style.display = 'flex';
            if (hintTwoway) hintTwoway.style.display = 'block';
            // Hide strict lang in two-way mode (both languages are specified)
            if (strictLang) strictLang.style.display = 'none';
            // Force-disable TTS in two-way mode to prevent audio feedback loop
            if (this.ttsEnabled) {
                this.ttsEnabled = false;
                this._getActiveTTS().disconnect();
                audioPlayer.stop();
            }
            this._updateTTSButton();
        } else {
            if (oneway) oneway.style.display = 'flex';
            if (twoway) twoway.style.display = 'none';
            if (hintTwoway) hintTwoway.style.display = 'none';
            if (strictLang) strictLang.style.display = 'flex';
            this._updateTTSButton();
        }
    }

    _updateTTSButton() {
        const btn = document.getElementById('btn-tts');
        const iconOff = document.getElementById('icon-tts-off');
        const iconOn = document.getElementById('icon-tts-on');
        const isTwoWay = document.getElementById('select-translation-type')?.value === 'two_way';

        if (btn) {
            btn.classList.toggle('active', this.ttsEnabled);
            btn.classList.toggle('disabled', isTwoWay);
            btn.title = isTwoWay ? 'TTS disabled in two-way mode' : 'Toggle TTS (Ctrl+T)';
        }
        if (iconOff) iconOff.style.display = this.ttsEnabled ? 'none' : 'block';
        if (iconOn) iconOn.style.display = this.ttsEnabled ? 'block' : 'none';
    }

    _speakIfEnabled(text) {
        if (this.ttsEnabled && text?.trim()) {
            this._getActiveTTS().speak(text);
        }
    }

    // ─── Source Control ────────────────────────────────────

    _setSource(source) {
        const wasRunning = this.isRunning;
        const labels = { system: 'System Audio', microphone: 'Microphone', both: 'System + Mic' };
        const label = labels[source] || source;

        // If currently running, restart with new source
        if (wasRunning) {
            this.stop().then(() => {
                this.currentSource = source;
                this._updateSourceButtons();
                this._showToast(`Switched to ${label}`, 'success');
                this.start();
            });
        } else {
            this.currentSource = source;
            this._updateSourceButtons();
            this._showToast(`Source: ${label}`, 'success');
        }
    }

    _updateSourceButtons() {
        document.getElementById('btn-source-system').classList.toggle('active',
            this.currentSource === 'system');
        document.getElementById('btn-source-mic').classList.toggle('active',
            this.currentSource === 'microphone');
        document.getElementById('btn-source-both').classList.toggle('active',
            this.currentSource === 'both');
    }

    _updateModeUI(mode) {
        const isSoniox = mode === 'soniox';
        const isSonioxGoogle = mode === 'soniox_google';
        const isSonioxDeepL = mode === 'soniox_deepl';
        const isSonioxGoogleDeepL = mode === 'soniox_google_deepl';
        const isSonioxDeepLGoogle = mode === 'soniox_deepl_google';
        const isGoogleSoniox = mode === 'google_soniox';
        const isDeeplSoniox = mode === 'deepl_soniox';
        const isGoogleDeepl = mode === 'google_deepl';
        const isGoogleSttGoogleTranslate = mode === 'google_stt_google_translate';
        const isDeeplVoice = mode === 'deepl_voice';
        const isLocal = mode === 'local';

        // Toggle hints
        const hintSoniox = document.getElementById('hint-mode-soniox');
        const hintSonioxGoogle = document.getElementById('hint-mode-soniox-google');
        const hintSonioxDeepL = document.getElementById('hint-mode-soniox-deepl');
        const hintSonioxGoogleDeepL = document.getElementById('hint-mode-soniox-google-deepl');
        const hintSonioxDeepLGoogle = document.getElementById('hint-mode-soniox-deepl-google');
        const hintGoogleStt = document.getElementById('hint-mode-google-stt');
        const hintDeeplVoice = document.getElementById('hint-mode-deepl-voice');
        const hintLocal = document.getElementById('hint-mode-local');
        if (hintSoniox) hintSoniox.style.display = isSoniox ? '' : 'none';
        if (hintSonioxGoogle) hintSonioxGoogle.style.display = (isSonioxGoogle || isGoogleSoniox) ? '' : 'none';
        if (hintSonioxDeepL) hintSonioxDeepL.style.display = (isSonioxDeepL || isDeeplSoniox) ? '' : 'none';
        if (hintSonioxGoogleDeepL) hintSonioxGoogleDeepL.style.display = (isSonioxGoogleDeepL || isGoogleDeepl) ? '' : 'none';
        if (hintSonioxDeepLGoogle) hintSonioxDeepLGoogle.style.display = isSonioxDeepLGoogle ? '' : 'none';
        if (hintGoogleStt) hintGoogleStt.style.display = isGoogleSttGoogleTranslate ? '' : 'none';
        if (hintDeeplVoice) hintDeeplVoice.style.display = isDeeplVoice ? '' : 'none';
        if (hintLocal) hintLocal.style.display = isLocal ? '' : 'none';

        // Toggle provider-specific sections
        const sectionApiKey = document.getElementById('section-api-key');
        const sectionGoogleSttKey = document.getElementById('section-google-stt-key');
        const sectionGoogleTranslateKey = document.getElementById('section-google-translate-key');
        const sectionDeepLKey = document.getElementById('section-deepl-key');
        const sectionContext = document.getElementById('section-soniox-context');
        const isSonioxAny = isSoniox || isSonioxGoogle || isSonioxDeepL || isSonioxGoogleDeepL || isSonioxDeepLGoogle || isGoogleSoniox || isDeeplSoniox || isGoogleDeepl;
        const isGoogleAny = isSonioxGoogle || isSonioxGoogleDeepL || isSonioxDeepLGoogle || isGoogleSttGoogleTranslate || isGoogleSoniox || isGoogleDeepl;
        const isDeepLAny = isSonioxDeepL || isSonioxGoogleDeepL || isSonioxDeepLGoogle || isDeeplVoice || isDeeplSoniox || isGoogleDeepl;

        if (sectionApiKey) sectionApiKey.style.display = isSonioxAny ? '' : 'none';
        if (sectionGoogleSttKey) sectionGoogleSttKey.style.display = isGoogleSttGoogleTranslate ? '' : 'none';
        if (sectionGoogleTranslateKey) sectionGoogleTranslateKey.style.display = (isGoogleAny) ? '' : 'none';
        if (sectionDeepLKey) sectionDeepLKey.style.display = (isDeepLAny) ? '' : 'none';
        if (sectionContext) sectionContext.style.display = isSonioxAny ? '' : 'none';
    }

    // ─── Start/Stop ────────────────────────────────────────

    async start() {
        const settings = settingsManager.get();
        this.translationMode = settings.translation_mode || 'soniox';
        console.log('[App] start() called, translation_mode:', this.translationMode, 'settings:', JSON.stringify(settings));

        // Check API keys for active modes
        // - Soniox is required only for Soniox-based STT modes.
        if (
            (
                this.translationMode === 'soniox'
                || this.translationMode === 'soniox_google'
                || this.translationMode === 'soniox_deepl'
                || this.translationMode === 'soniox_google_deepl'
                || this.translationMode === 'soniox_deepl_google'
                || this.translationMode === 'google_soniox'
                || this.translationMode === 'deepl_soniox'
                || this.translationMode === 'google_deepl'
            ) && !settings.soniox_api_key
        ) {
            this._showToast('Soniox API key is required. Add it in Settings.', 'error');
            this._showView('settings');
            return;
        }
        if (
            (
                this.translationMode === 'soniox_google'
                || this.translationMode === 'soniox_google_deepl'
                || this.translationMode === 'soniox_deepl_google'
                || this.translationMode === 'google_soniox'
                || this.translationMode === 'google_deepl'
                || this.translationMode === 'google_stt_google_translate'
            ) && !settings.google_translate_api_key
        ) {
            this._showToast('Google Translate API key is required for this mode.', 'error');
            this._showView('settings');
            return;
        }
        if (
            (
                this.translationMode === 'soniox_deepl'
                || this.translationMode === 'soniox_google_deepl'
                || this.translationMode === 'soniox_deepl_google'
                || this.translationMode === 'deepl_soniox'
                || this.translationMode === 'google_deepl'
                || this.translationMode === 'deepl_voice'
            ) && !settings.deepl_api_key
        ) {
            this._showToast('DeepL API key is required for this mode.', 'error');
            this._showView('settings');
            return;
        }
        if (
            (
                this.translationMode === 'soniox_google'
                || this.translationMode === 'soniox_google_deepl'
                || this.translationMode === 'soniox_deepl_google'
                || this.translationMode === 'soniox_deepl'
                || this.translationMode === 'google_soniox'
                || this.translationMode === 'deepl_soniox'
                || this.translationMode === 'google_deepl'
            )
            && (settings.translation_type || 'one_way') !== 'one_way'
        ) {
            this._showToast('Soniox + Google mode currently supports one-way translation only.', 'error');
            this._showView('settings');
            return;
        }
        if (this.translationMode === 'deepl_voice' && (settings.translation_type || 'one_way') !== 'one_way') {
            this._showToast('DeepL Voice mode currently supports one-way translation only.', 'error');
            this._showView('settings');
            return;
        }
        if (this.translationMode === 'google_stt_google_translate' && (settings.translation_type || 'one_way') !== 'one_way') {
            this._showToast('Google STT + Translate mode currently supports one-way translation only.', 'error');
            this._showView('settings');
            return;
        }
        if (this.translationMode === 'google_stt_google_translate' && !settings.google_stt_api_key) {
            this._showToast('Google Speech-to-Text API key is required for this mode.', 'error');
            this._showView('settings');
            return;
        }

        // Check ElevenLabs key only if TTS is enabled AND provider is elevenlabs
        if (this.ttsEnabled && settings.tts_provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            this._showToast('TTS is ON but ElevenLabs API key is missing. Add it in Settings or disable TTS.', 'error');
            this._showView('settings');
            return;
        }

        this.isRunning = true;
        this._updateStartButton();
        if (!this.recordingStartTime) this.recordingStartTime = Date.now();

        // Clear transcript only if nothing is showing
        if (!this.transcriptUI.hasContent()) {
            this.transcriptUI.showListening();
        } else {
            this.transcriptUI.clearProvisional();
        }

        if (this.translationMode === 'local') {
            await this._startLocalMode(settings);
        } else if (this.translationMode === 'google_stt_google_translate') {
            await this._startGoogleSttTranslateMode(settings);
        } else if (this.translationMode === 'deepl_voice') {
            await this._startDeepLVoiceMode(settings);
        } else {
            await this._startSonioxMode(settings);
        }

        // Start TTS if enabled
        if (this.ttsEnabled) {
            const tts = this._getActiveTTS();
            this._configureTTS(tts, settings);
            tts.connect();
            audioPlayer.resume();
        }
    }

    async _startSonioxMode(settings) {
        // Connect to Soniox
        console.log('[App] Connecting to Soniox...');
        this._updateStatus('connecting');
        const useExternalTranslator = (
            this.translationMode === 'soniox_google'
            || this.translationMode === 'soniox_deepl'
            || this.translationMode === 'soniox_google_deepl'
            || this.translationMode === 'soniox_deepl_google'
            || this.translationMode === 'google_soniox'
            || this.translationMode === 'deepl_soniox'
            || this.translationMode === 'google_deepl'
        );
        this.googleTranslateQueue = Promise.resolve();
        this.deepLTranslateQueue = Promise.resolve();
        googleTranslateClient.configure({
            apiKey: settings.google_translate_api_key || '',
        });
        deepLTranslateClient.configure({
            apiKey: settings.deepl_api_key || '',
        });
        sonioxClient.connect({
            apiKey: settings.soniox_api_key,
            sourceLanguage: settings.source_language,
            targetLanguage: useExternalTranslator ? null : settings.target_language,
            customContext: settings.custom_context,
            translationType: settings.translation_type || 'one_way',
            languageA: settings.language_a,
            languageB: settings.language_b,
            languageHintsStrict: settings.language_hints_strict || false,
            endpointDelay: settings.endpoint_delay || 3000,
        });

        // Start audio capture — Rust batches audio every 200ms, JS just forwards
        try {
            let audioChunkCount = 0;

            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (pcmData) => {
                audioChunkCount++;
                if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
                    console.log(`[Audio] Batch #${audioChunkCount}, size:`, pcmData?.length || 0);
                }
                // Forward batched audio to Soniox
                const bytes = new Uint8Array(pcmData);
                sonioxClient.sendAudio(bytes.buffer);
            };

            console.log('[App] Starting audio capture, source:', this.currentSource);
            await invoke('start_capture', {
                source: this.currentSource,
                channel: channel,
            });
            console.log('[App] Audio capture started successfully');
        } catch (err) {
            console.error('Failed to start audio capture:', err);
            this._showToast(`Audio error: ${err}`, 'error');
            await this.stop();
        }
    }

    async _startGoogleSttTranslateMode(settings) {
        console.log('[App] Starting Google STT + Translate mode...');
        this._updateStatus('connecting');

        googleSttClient.configure({ apiKey: settings.google_stt_api_key || '' });
        googleTranslateClient.configure({ apiKey: settings.google_translate_api_key || '' });

        this.googleSttQueue = Promise.resolve();
        this.googleSttAudioBuffer = [];
        this.googleSttSilenceTimer = null;
        this.googleSttSegmentTimer = null;

        const endpointDelay = settings.endpoint_delay || 3000;
        const maxSegmentMs = Math.max(endpointDelay * 4, 6000);

        this.transcriptUI.showListening();

        const flushSegment = async () => {
            if (!this.isRunning) return;
            if (this.googleSttAudioBuffer.length === 0) return;

            // Snapshot current buffer, clear it immediately so capture can continue.
            const chunks = this.googleSttAudioBuffer;
            this.googleSttAudioBuffer = [];

            if (this.googleSttSilenceTimer) {
                clearTimeout(this.googleSttSilenceTimer);
                this.googleSttSilenceTimer = null;
            }
            if (this.googleSttSegmentTimer) {
                clearTimeout(this.googleSttSegmentTimer);
                this.googleSttSegmentTimer = null;
            }

            // Concatenate into one Uint8Array.
            const totalLen = chunks.reduce((sum, c) => sum + c.byteLength, 0);
            const merged = new Uint8Array(totalLen);
            let offset = 0;
            for (const c of chunks) {
                merged.set(c, offset);
                offset += c.byteLength;
            }

            const srcLangCode = googleSttClient.buildLanguageCode(settings.source_language);
            let text = '';
            try {
                text = await googleSttClient.recognizePcm16kLinear16(merged, { languageCode: srcLangCode });
            } catch (err) {
                this._showToast(`STT error: ${err.message || err}`, 'error');
                return;
            }

            if (!text || !text.trim()) {
                return;
            }

            this.transcriptUI.addOriginal(text, null, settings.source_language === 'auto' ? null : settings.source_language);

            let translated = '';
            try {
                translated = await googleTranslateClient.translateText(text, {
                    sourceLanguage: settings.source_language || 'auto',
                    targetLanguage: settings.target_language || 'vi',
                });
            } catch (err) {
                this._showToast(`Translate error: ${err.message || err}`, 'error');
                return;
            }

            if (translated && translated.trim()) {
                this.transcriptUI.addTranslation(translated);
                this._speakIfEnabled(translated);
            }
        };

        try {
            let segmentStartAt = null;

            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (pcmData) => {
                if (!this.isRunning) return;
                const bytes = new Uint8Array(pcmData);
                // Copy bytes because pcmData buffer may be reused.
                this.googleSttAudioBuffer.push(bytes.slice());

                // Debounce: if no new audio arrives for endpointDelay -> flush.
                if (this.googleSttSilenceTimer) clearTimeout(this.googleSttSilenceTimer);
                this.googleSttSilenceTimer = setTimeout(() => {
                    segmentStartAt = null;
                    this.googleSttQueue = this.googleSttQueue.then(() => flushSegment());
                }, endpointDelay);

                if (!segmentStartAt) {
                    segmentStartAt = Date.now();
                    this.googleSttSegmentTimer = setTimeout(() => {
                        segmentStartAt = null;
                        this.googleSttQueue = this.googleSttQueue.then(() => flushSegment());
                    }, maxSegmentMs);
                }
            };

            await invoke('start_capture', {
                source: this.currentSource,
                channel,
            });

            console.log('[App] Google STT capture started');
            this._updateStatus('connected');
        } catch (err) {
            console.error('[App] Google STT mode failed:', err);
            this._showToast(`Google STT error: ${err}`, 'error');
            await this.stop();
        }
    }

    async _startDeepLVoiceMode(settings) {
        console.log('[App] Starting DeepL Voice mode...');
        this._updateStatus('connecting');

        deepLVoiceClient.configure({ apiKey: settings.deepl_api_key || '' });
        deepLVoiceClient.onStatusChange = (st) => this._updateStatus(st === 'connected' ? 'connected' : st === 'error' ? 'error' : st);
        deepLVoiceClient.onError = (msg) => this._showToast(msg, 'error');
        deepLVoiceClient.onSegment = ({ sourceText, targetText, sourceLanguage }) => {
            if (sourceText && sourceText.trim()) {
                this.transcriptUI.addOriginal(sourceText, null, sourceLanguage || null);
            }
            if (targetText && targetText.trim()) {
                this.transcriptUI.addTranslation(targetText);
                this._speakIfEnabled(targetText);
            }
        };

        try {
            this.transcriptUI.showListening();
            await deepLVoiceClient.start({
                sourceLanguage: settings.source_language || 'auto',
                targetLanguage: settings.target_language || 'vi',
                sourceLanguageMode: (settings.source_language || 'auto') === 'auto' ? 'auto' : 'fixed',
            });

            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (pcmData) => {
                const bytes = new Uint8Array(pcmData);
                deepLVoiceClient.sendAudio(bytes);
            };

            await invoke('start_capture', {
                source: this.currentSource,
                channel,
            });

            console.log('[App] DeepL Voice capture started');
        } catch (err) {
            console.error('[App] DeepL Voice mode failed:', err);
            this._showToast(`DeepL Voice error: ${err.message || err}`, 'error');
            await this.stop();
        }
    }

    async _startLocalMode(settings) {
        console.log('[App] Starting Local mode (MLX models)...');
        this._updateStatus('connecting');

        // Step 0: Check audio permission FIRST (before loading models)
        try {
            await invoke('start_capture', {
                source: this.currentSource,
                channel: new window.__TAURI__.core.Channel(), // dummy channel for permission check
            });
            await invoke('stop_capture');
        } catch (err) {
            console.error('[App] Audio permission check failed:', err);
            this._showToast(`Audio permission required: ${err}`, 'error');
            this.isRunning = false;
            this._updateStartButton();
            this._updateStatus('error');
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            return;
        }

        // Step 1: Check if MLX setup is complete
        try {
            const checkResult = await invoke('check_mlx_setup');
            const status = JSON.parse(checkResult);
            if (!status.ready) {
                this._showToast('Setting up MLX models (one-time, ~5GB)...', 'success');
                this.transcriptUI.showStatusMessage('Downloading MLX models (one-time setup)...');
                await this._runMlxSetup();
            }
        } catch (err) {
            console.warn('[App] MLX check failed (proceeding anyway):', err);
        }

        console.log('[App] MLX check passed, starting pipeline...');

        // Step 1: Start pipeline FIRST (independent of audio)
        try {
            this._showToast('Starting local pipeline...', 'success');

            this.localPipelineChannel = new window.__TAURI__.core.Channel();
            this.localPipelineReady = false;

            this.localPipelineChannel.onmessage = (msg) => {
                let data;
                try {
                    data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
                } catch (e) {
                    console.warn('[Local] JSON parse failed:', typeof msg, msg);
                    return;
                }
                try {
                    this._handleLocalPipelineResult(data);
                } catch (e) {
                    console.error('[Local] Handler error for type:', data?.type, e);
                }
            };

            const sourceLangMap = {
                'auto': 'auto', 'ja': 'Japanese', 'en': 'English',
                'zh': 'Chinese', 'ko': 'Korean', 'vi': 'Vietnamese',
            };
            const sourceLang = sourceLangMap[settings.source_language] || 'Japanese';

            await invoke('start_local_pipeline', {
                sourceLang: sourceLang,
                targetLang: settings.target_language || 'vi',
                channel: this.localPipelineChannel,
            });
            console.log('[App] Local pipeline spawned');
        } catch (err) {
            console.error('Failed to start pipeline:', err);
            this._showToast(`Pipeline error: ${err}`, 'error');
            await this.stop();
            return;
        }

        // Step 2: Start audio capture
        try {
            const audioChannel = new window.__TAURI__.core.Channel();
            let audioChunkCount = 0;

            audioChannel.onmessage = async (pcmData) => {
                audioChunkCount++;
                if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
                    console.log(`[Local] Audio batch #${audioChunkCount}, size:`, pcmData?.length || 0);
                }
                try {
                    await invoke('send_audio_to_pipeline', { data: Array.from(new Uint8Array(pcmData)) });
                } catch (e) {
                    // Pipeline may not be ready yet
                }
            };

            await invoke('start_capture', {
                source: this.currentSource,
                channel: audioChannel,
            });
            console.log('[App] Audio capture started');
        } catch (err) {
            console.error('Audio capture failed (pipeline still running):', err);
            this._showToast(`Audio: ${err}. Pipeline still loading...`, 'error');
        }
    }

    _handleLocalPipelineResult(data) {
        switch (data.type) {
            case 'ready':
                this.localPipelineReady = true;
                this._updateStatus('connected');
                this.transcriptUI.removeStatusMessage();
                this.transcriptUI.showListening();
                this._showToast('Local models ready!', 'success');
                break;
            case 'result':
                // Chase effect: show original first (gray), then translation (white)
                if (data.original) {
                    this.transcriptUI.addOriginal(data.original);
                }
                // Small delay for visual "chase" effect
                setTimeout(() => {
                if (data.translated) {
                    this.transcriptUI.addTranslation(data.translated);
                    this._speakIfEnabled(data.translated);
                }
                }, 80);
                break;
            case 'status':
                const msg = data.message || 'Loading...';
                // Status bar: show compact message (strip [pipeline] prefix)
                const statusText = document.getElementById('status-text');
                if (statusText) {
                    const compact = msg.replace(/^\[pipeline\]\s*/, '');
                    statusText.textContent = compact;
                }
                // Transcript area: only show loading/starting messages, not debug logs
                if (!msg.startsWith('[pipeline]')) {
                    this.transcriptUI.showStatusMessage(msg);
                }
                break;
            case 'done':
                this._updateStatus('disconnected');
                break;
        }
    }

    async _runMlxSetup() {
        const modal = document.getElementById('setup-modal');
        const progressFill = document.getElementById('setup-progress-fill');
        const progressPct = document.getElementById('setup-progress-pct');
        const statusText = document.getElementById('setup-status-text');
        const cancelBtn = document.getElementById('btn-cancel-setup');

        // Step mapping: step name → total progress weight
        const stepWeights = { check: 5, venv: 10, packages: 35, models: 50 };
        let totalProgress = 0;

        const updateStep = (stepName, icon, isActive) => {
            const stepEl = document.getElementById(`step-${stepName}`);
            if (!stepEl) return;
            stepEl.querySelector('.step-icon').textContent = icon;
            stepEl.classList.toggle('active', isActive);
            stepEl.classList.toggle('done', icon === '✅');
        };

        const updateProgress = (pct) => {
            totalProgress = Math.min(100, pct);
            progressFill.style.width = totalProgress + '%';
            progressPct.textContent = Math.round(totalProgress) + '%';
        };

        // Show modal
        modal.style.display = 'flex';

        return new Promise((resolve, reject) => {
            const channel = new window.__TAURI__.core.Channel();

            // Cancel handler
            const onCancel = () => {
                modal.style.display = 'none';
                reject(new Error('Setup cancelled'));
            };
            cancelBtn.addEventListener('click', onCancel, { once: true });

            channel.onmessage = (msg) => {
                let data;
                try {
                    data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
                } catch (e) {
                    return;
                }

                switch (data.type) {
                    case 'progress':
                        statusText.textContent = data.message || 'Working...';

                        // Update step indicators
                        if (data.step) {
                            // Mark previous steps as done
                            const steps = ['check', 'venv', 'packages', 'models'];
                            const currentIdx = steps.indexOf(data.step);
                            steps.forEach((s, i) => {
                                if (i < currentIdx) updateStep(s, '✅', false);
                                else if (i === currentIdx) updateStep(s, '🔄', true);
                            });

                            if (data.done) {
                                updateStep(data.step, '✅', false);
                            }

                            // Calculate overall progress
                            let pct = 0;
                            steps.forEach((s, i) => {
                                if (i < currentIdx) pct += stepWeights[s];
                                else if (i === currentIdx) {
                                    pct += (data.progress || 0) / 100 * stepWeights[s];
                                }
                            });
                            updateProgress(pct);
                        }
                        break;

                    case 'complete':
                        updateProgress(100);
                        statusText.textContent = '✅ ' + (data.message || 'Setup complete!');
                        ['check', 'venv', 'packages', 'models'].forEach(s => updateStep(s, '✅', false));

                        // Close modal after brief delay
                        setTimeout(() => {
                            modal.style.display = 'none';
                            resolve();
                        }, 1000);
                        break;

                    case 'error':
                        statusText.textContent = '❌ ' + (data.message || 'Setup failed');
                        cancelBtn.textContent = 'Close';
                        cancelBtn.removeEventListener('click', onCancel);
                        cancelBtn.addEventListener('click', () => {
                            modal.style.display = 'none';
                            reject(new Error(data.message));
                        }, { once: true });
                        break;

                    case 'log':
                        console.log('[MLX Setup]', data.message);
                        break;
                }
            };

            invoke('run_mlx_setup', { channel })
                .catch(err => {
                    statusText.textContent = '❌ ' + err;
                    modal.style.display = 'none';
                    reject(err);
                });
        });
    }

    async stop() {
        this.isRunning = false;
        this._updateStartButton();

        // Stop audio capture
        try {
            await invoke('stop_capture');
        } catch (err) {
            console.error('Failed to stop audio capture:', err);
        }

        if (this.translationMode === 'local') {
            // Stop local pipeline
            try {
                await invoke('stop_local_pipeline');
            } catch (err) {
                console.error('Failed to stop local pipeline:', err);
            }
            this.localPipelineReady = false;
            this.transcriptUI.removeStatusMessage();
            this._updateStatus('disconnected');
        } else if (this.translationMode === 'google_stt_google_translate') {
            // Stop Google STT timers/buffers
            if (this.googleSttSilenceTimer) {
                clearTimeout(this.googleSttSilenceTimer);
                this.googleSttSilenceTimer = null;
            }
            if (this.googleSttSegmentTimer) {
                clearTimeout(this.googleSttSegmentTimer);
                this.googleSttSegmentTimer = null;
            }
            this.googleSttAudioBuffer = [];
            this._updateStatus('disconnected');
        } else if (this.translationMode === 'deepl_voice') {
            // Signal end-of-media to finalize DeepL Voice transcripts.
            try {
                deepLVoiceClient.end();
            } catch (err) {
                console.error('Failed to end DeepL Voice session:', err);
            }
            this._updateStatus('disconnected');
        } else {
            // Disconnect Soniox
            sonioxClient.disconnect();
        }

        // Keep transcript visible — don't clear
        this.transcriptUI.clearProvisional();

        // Stop TTS
        elevenLabsTTS.disconnect();
        edgeTTSRust.disconnect();
        googleTTS.disconnect();

        audioPlayer.stop();

        // Auto-save on stop (safety net)
        if (this.transcriptUI.hasSegments()) {
            await this._saveTranscriptFile();
        }
    }

    _updateStartButton() {
        const btn = document.getElementById('btn-start');
        const iconPlay = document.getElementById('icon-play');
        const iconStop = document.getElementById('icon-stop');

        btn.classList.toggle('recording', this.isRunning);
        iconPlay.style.display = this.isRunning ? 'none' : 'block';
        iconStop.style.display = this.isRunning ? 'block' : 'none';
    }

    // ─── Transcript Persistence ───────────────────────────────

    _formatDuration(ms) {
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${min}m ${sec}s`;
    }

    async _saveTranscriptFile() {
        const duration = this.recordingStartTime
            ? this._formatDuration(Date.now() - this.recordingStartTime)
            : 'unknown';

        const sourceLang = document.getElementById('select-source-lang')?.value || 'auto';
        const targetLang = document.getElementById('select-target-lang')?.value || 'vi';

        const content = this.transcriptUI.getFormattedContent({
            model: this.translationMode === 'local'
                ? 'Local MLX Whisper'
                : (this.translationMode === 'google_stt_google_translate'
                    ? 'Google Speech-to-Text + Google Translate'
                    : (this.translationMode === 'deepl_voice'
                        ? 'DeepL Voice API (STT + Translate)'
                        : (this.translationMode === 'soniox'
                            ? 'Soniox (STT + Translate)'
                            : (this.translationMode === 'soniox_google' || this.translationMode === 'google_soniox'
                                ? 'Google + Soniox (chỉ Google)'
                                : (this.translationMode === 'soniox_deepl' || this.translationMode === 'deepl_soniox'
                                    ? 'DeepL + Soniox (chỉ DeepL)'
                                    : (this.translationMode === 'soniox_google_deepl' || this.translationMode === 'google_deepl'
                                        ? 'Google + DeepL'
                                        : (this.translationMode === 'soniox_deepl_google'
                                            ? 'DeepL + Google'
                                            : 'Soniox (STT + Translate)'))))))),
            sourceLang,
            targetLang,
            duration,
            audioSource: this.currentSource,
        });

        if (!content) return;

        try {
            const path = await invoke('save_transcript', { content });
            const filename = path.split('/').pop();
            this._showToast(`Saved: ${filename}`, 'success');
        } catch (err) {
            console.error('Failed to save transcript:', err);
            this._showToast('Failed to save transcript', 'error');
        }
    }

    _enqueueGoogleTranslation(text) {
        if (!text || !text.trim()) return;

        const settings = settingsManager.get();
        const payload = {
            sourceLanguage: settings.source_language || 'auto',
            targetLanguage: settings.target_language || 'vi',
        };

        this.googleTranslateQueue = this.googleTranslateQueue
            .then(async () => {
                const translated = await googleTranslateClient.translateText(text, payload);
                if (!translated || !translated.trim()) return;
                this.transcriptUI.addTranslation(translated);
                this._speakIfEnabled(translated);
            })
            .catch((err) => {
                console.error('[Google Translate]', err);
                this._showToast(`Google Translate error: ${err.message || err}`, 'error');
            });
    }

    _enqueueDeepLTranslation(text) {
        if (!text || !text.trim()) return;

        const settings = settingsManager.get();
        const payload = {
            sourceLanguage: settings.source_language || 'auto',
            targetLanguage: settings.target_language || 'vi',
        };

        this.deepLTranslateQueue = this.deepLTranslateQueue
            .then(async () => {
                const translated = await deepLTranslateClient.translateText(text, payload);
                if (!translated || !translated.trim()) return;
                this.transcriptUI.addTranslation(translated);
                this._speakIfEnabled(translated);
            })
            .catch((err) => {
                console.error('[DeepL Translate]', err);
                this._showToast(`DeepL Translate error: ${err.message || err}`, 'error');
            });
    }

    // ─── Status ────────────────────────────────────────────

    _updateStatus(status) {
        const dot = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');

        dot.className = 'status-dot';

        switch (status) {
            case 'connecting':
                dot.classList.add('connecting');
                text.textContent = 'Connecting...';
                break;
            case 'connected':
                dot.classList.add('connected');
                text.textContent = 'Listening';
                break;
            case 'disconnected':
                dot.classList.add('disconnected');
                text.textContent = 'Ready';
                break;
            case 'error':
                dot.classList.add('error');
                text.textContent = 'Error';
                break;
        }
    }

    // ─── Window Position ───────────────────────────────────

    async _saveWindowPosition() {
        try {
            const factor = await this.appWindow.scaleFactor();
            const pos = await this.appWindow.outerPosition();
            const size = await this.appWindow.innerSize();
            // Save logical coordinates (physical / scaleFactor)
            localStorage.setItem('window_state', JSON.stringify({
                x: Math.round(pos.x / factor),
                y: Math.round(pos.y / factor),
                width: Math.round(size.width / factor),
                height: Math.round(size.height / factor),
            }));
        } catch (err) {
            console.error('Failed to save window position:', err);
        }
    }

    async _restoreWindowPosition() {
        try {
            const saved = localStorage.getItem('window_state');
            if (!saved) return;

            const state = JSON.parse(saved);
            const { LogicalPosition, LogicalSize } = window.__TAURI__.window;

            // Validate — don't restore if position seems off-screen
            if (state.x < -100 || state.y < -100 || state.x > 5000 || state.y > 3000) {
                console.warn('Saved window position looks off-screen, skipping restore');
                localStorage.removeItem('window_state');
                return;
            }

            if (state.width && state.height && state.width >= 300 && state.height >= 100) {
                await this.appWindow.setSize(new LogicalSize(state.width, state.height));
            }
            if (state.x !== undefined && state.y !== undefined) {
                await this.appWindow.setPosition(new LogicalPosition(state.x, state.y));
            }
        } catch (err) {
            console.error('Failed to restore window position:', err);
            localStorage.removeItem('window_state');
        }
    }

    // ─── Pin / Unpin (Always on Top) ────────────────────

    async _togglePin() {
        this.isPinned = !this.isPinned;
        await this.appWindow.setAlwaysOnTop(this.isPinned);
        const btn = document.getElementById('btn-pin');
        if (btn) btn.classList.toggle('active', this.isPinned);
        this._showToast(this.isPinned ? 'Pinned on top' : 'Unpinned — window can go behind other apps', 'success');
    }

    // ─── Compact Mode ───────────────────────────────

    _toggleCompact() {
        this.isCompact = !this.isCompact;
        const dragRegion = document.getElementById('drag-region');
        const overlay = document.getElementById('overlay-view');

        if (this.isCompact) {
            dragRegion.classList.add('compact-hidden');
            overlay.classList.add('compact-mode');
        } else {
            dragRegion.classList.remove('compact-hidden');
            overlay.classList.remove('compact-mode');
        }
    }

    _toggleViewMode() {
        const isDual = this.transcriptUI.viewMode === 'dual';
        const newMode = isDual ? 'single' : 'dual';
        this.transcriptUI.configure({ viewMode: newMode });
        const btn = document.getElementById('btn-view-mode');
        if (btn) btn.classList.toggle('active', newMode === 'dual');
    }

    async _toggleTransparentSubtitleMode() {
        const next = !this.transparentSubtitleMode;
        this._setTransparentSubtitleMode(next, { persist: false });
        try {
            await settingsManager.save({ transparent_subtitle_mode: next });
        } catch (err) {
            this._showToast(`Failed to save display mode: ${err}`, 'error');
        }
    }

    _setTransparentSubtitleMode(enabled, { persist } = { persist: false }) {
        this.transparentSubtitleMode = !!enabled;

        const overlay = document.getElementById('overlay-view');
        if (overlay) {
            overlay.classList.toggle('transparent-subtitle-mode', this.transparentSubtitleMode);
        }

        const quickToggle = document.getElementById('btn-transparent-mode');
        if (quickToggle) {
            quickToggle.classList.toggle('active', this.transparentSubtitleMode);
            quickToggle.title = this.transparentSubtitleMode
                ? 'Transparent subtitle mode ON'
                : 'Transparent subtitle mode OFF';
        }

        const settingCheckbox = document.getElementById('check-transparent-subtitle');
        if (settingCheckbox && settingCheckbox.checked !== this.transparentSubtitleMode) {
            settingCheckbox.checked = this.transparentSubtitleMode;
        }

        if (this.transcriptUI) {
            this.transcriptUI.configure({
                latestOnlyMode: this.transparentSubtitleMode,
                fontColor: this.transparentSubtitleMode ? '#ffe66d' : undefined,
            });
        }

        if (persist) {
            settingsManager.save({ transparent_subtitle_mode: this.transparentSubtitleMode })
                .catch((err) => this._showToast(`Failed to save display mode: ${err}`, 'error'));
        }
    }

    _bindWindowFocusRecovery() {
        this.appWindow.onFocusChanged(({ payload: focused }) => {
            if (!focused) return;
            const now = Date.now();
            if (now - this.lastWindowFocusAt <= this.windowFocusTapThresholdMs) {
                this._restoreNormalOverlayMode();
            }
            this.lastWindowFocusAt = now;
        });
    }

    _restoreNormalOverlayMode() {
        // Double-focus from taskbar returns to normal visual mode.
        this._showView('overlay');
        if (this.transparentSubtitleMode) {
            this._setTransparentSubtitleMode(false, { persist: true });
        }
        if (this.isCompact) {
            this._toggleCompact();
        }
    }

    _adjustFontSize(delta) {
        const current = this.transcriptUI.fontSize || 16;
        const newSize = Math.max(12, Math.min(140, current + delta));
        this.transcriptUI.configure({ fontSize: newSize });

        // Update display
        const display = document.getElementById('font-size-display');
        if (display) display.textContent = newSize;

        // Sync with settings slider
        const slider = document.getElementById('range-font-size');
        if (slider) slider.value = newSize;
        const sliderVal = document.getElementById('font-size-value');
        if (sliderVal) sliderVal.textContent = `${newSize}px`;
    }

    // ─── Toast ─────────────────────────────────────────────

    async _checkForUpdates() {
        updater.onUpdateFound = (version, notes) => {
            this._onUpdateAvailable(version, notes);
        };
        updater.onError = (err) => {
            const statusText = document.getElementById('update-status-text');
            if (statusText) statusText.textContent = `⚠️ Check failed: ${err.message || err}`;
        };
        updater.onCheckComplete = (hasUpdate) => {
            const checkBtn = document.getElementById('btn-check-update');
            if (checkBtn) checkBtn.classList.remove('spinning');
            if (!hasUpdate && !this._pendingUpdateVersion) {
                const statusText = document.getElementById('update-status-text');
                if (statusText) statusText.textContent = '✅ App is up to date';
            }
        };
        // Delay check slightly so app finishes loading first
        setTimeout(() => {
            const statusText = document.getElementById('update-status-text');
            const checkBtn = document.getElementById('btn-check-update');
            if (statusText) statusText.textContent = 'Checking for updates...';
            if (checkBtn) checkBtn.classList.add('spinning');
            updater.checkForUpdates();
        }, 3000);
    }

    _triggerUpdateCheck() {
        const statusText = document.getElementById('update-status-text');
        const checkBtn = document.getElementById('btn-check-update');
        if (statusText) statusText.textContent = 'Checking for updates...';
        if (checkBtn) checkBtn.classList.add('spinning');
        updater.checkForUpdates();
    }

    _onUpdateAvailable(version, notes) {
        this._pendingUpdateVersion = version;

        // 1. Show badge on settings gear
        const badge = document.getElementById('settings-badge');
        if (badge) badge.style.display = '';

        // 2. Update About tab status
        const statusEl = document.getElementById('update-status');
        const statusText = document.getElementById('update-status-text');
        const actions = document.getElementById('update-actions');
        if (statusEl) statusEl.classList.add('has-update');
        if (statusText) statusText.textContent = `🆕 Update v${version} available`;
        if (actions) actions.style.display = '';
    }

    _initAboutTab() {
        // GitHub links
        document.getElementById('link-github')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__?.opener?.openUrl('https://github.com/phuc-nt/my-translator');
        });
        document.getElementById('link-issues')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__?.opener?.openUrl('https://github.com/phuc-nt/my-translator/issues');
        });

        // Check for Updates button
        document.getElementById('btn-check-update')?.addEventListener('click', () => {
            this._triggerUpdateCheck();
        });

        // Download & Install button
        document.getElementById('btn-do-update')?.addEventListener('click', async () => {
            const btnText = document.getElementById('update-btn-text');
            const btn = document.getElementById('btn-do-update');
            const progressDiv = document.getElementById('update-progress');
            const progressFill = document.getElementById('update-progress-fill');
            const progressPct = document.getElementById('update-progress-pct');

            if (btn) btn.disabled = true;
            if (btnText) btnText.textContent = 'Downloading...';
            if (progressDiv) progressDiv.style.display = '';

            try {
                await updater.downloadAndInstall((downloaded, total) => {
                    if (total > 0) {
                        const pct = Math.round((downloaded / total) * 100);
                        if (progressFill) progressFill.style.width = `${pct}%`;
                        if (progressPct) progressPct.textContent = `${pct}%`;
                        if (btnText) btnText.textContent = `Downloading ${pct}%...`;
                    }
                });
                // Install succeeded! Try to restart
                if (btnText) btnText.textContent = 'Restarting...';
                try {
                    const relaunch = window.__TAURI__?.process?.relaunch;
                    if (relaunch) {
                        await relaunch();
                    } else {
                        const invoke = window.__TAURI__?.core?.invoke;
                        if (invoke) await invoke('plugin:process|restart');
                    }
                } catch (restartErr) {
                    // Restart failed (e.g. process plugin not available) but update IS installed
                    console.warn('[Update] Restart failed, update is installed:', restartErr);
                    if (btnText) btnText.textContent = '✅ Updated! Restart app';
                    const statusText = document.getElementById('update-status-text');
                    if (statusText) statusText.textContent = '✅ Update installed — close and reopen the app';
                    if (btn) btn.disabled = true;
                }
            } catch (err) {
                const errMsg = err?.message || String(err);
                if (btnText) btnText.textContent = 'Failed — try again';
                const statusText = document.getElementById('update-status-text');
                if (statusText) statusText.textContent = `⚠️ Install error: ${errMsg}`;
                if (btn) btn.disabled = false;
                console.error('[Update]', err);
            }
        });
    }

    _showToast(message, type = 'success') {
        // Remove existing toast
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // Auto-remove (longer for errors)
        const duration = type === 'error' ? 5000 : 3000;
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
