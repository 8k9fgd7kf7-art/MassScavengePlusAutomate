// MassScavengePlusAutomate v1.3.6
(function(){
'use strict';

    const __mspUrl = new URL(window.location.href);
    const __mspIsMassScavenge =
        __mspUrl.searchParams.get('screen') === 'place' &&
        __mspUrl.searchParams.get('mode') === 'scavenge_mass';

    if (!__mspIsMassScavenge) {
        return;
    }

    if (window.__MASS_SCAVENGE_PLUS_RUNNING__) {
        try {
            const existing = document.getElementById('mass-scavenge-plus');
            if (existing) existing.scrollIntoView({ block: 'nearest' });
        } catch {}
        return;
    }
    window.__MASS_SCAVENGE_PLUS_RUNNING__ = true;


/* =========================================================
   Mass Scavenge+ v2.9.8
   GitHub / Schnellleisten Build
   Hauptversion
   ========================================================= */
/*
 * Mass Scavenge+ v2.9.8-beta
 * Modernisierte Fassung auf Basis von "Mass scavenging by Sophie / Shinko to Kuma".
 *
 * Ziele dieser V2:
 * - saubere Zustandsverwaltung (keine alten Requests bei Neuberechnung)
 * - moderne, deutschsprachige UI
 * - Profile + Import/Export
 * - Vorschau vor dem Versand
 * - Fortschrittsanzeige und bessere Fehler
 * - eindeutige DOM-IDs
 * - keine leeren Requests für deaktivierte/belegte Kategorien
 * - bewährte Verteilungslogik möglichst nah am Original belassen
 */

(() => {
    'use strict';

    // Zentrale Versionsnummer: alle sichtbaren Versionsanzeigen nutzen APP.version.
    const APP = {
        id: 'massScavengePlusV2',
        styleId: 'massScavengePlusV2Style',
        modalId: 'massScavengePlusV2Modal',
        version: '1.3.6',
        storageKey: 'massScavengePlusV2.config',
        villageTypeStorageKey: 'massScavengePlusV2.villageTypes',
        sessionStorageKey: 'massScavengePlusV2.sessions',
        uiStorageKey: 'massScavengePlusV2.ui',
        requestDelayMs: 220,
        maxSquadsPerGroup: 200,
        debug: false
    };

    const MIN_SCAVENGE_FARM_SPACE = 10;

    const UNIT_META = {
        spear:   { label: 'Speer',     carry: 25, type: 'def' },
        sword:   { label: 'Schwert',   carry: 15, type: 'def' },
        axe:     { label: 'Axt',       carry: 10, type: 'off' },
        archer:  { label: 'Bogen',     carry: 10, type: 'def' },
        light:   { label: 'LKav',      carry: 80, type: 'off' },
        marcher: { label: 'BB',        carry: 50, type: 'off' },
        heavy:   { label: 'SKav',      carry: 50, type: 'def' },
        knight:  { label: 'Paladin',   carry: 100, type: 'def' }
    };

    const EXCLUDED_UNITS = new Set(['militia', 'snob', 'ram', 'catapult', 'spy', 'knight']);

    let config;
    let serverDateMs = Date.now();
    let categoryNames = ['Kategorie 1', 'Kategorie 2', 'Kategorie 3', 'Kategorie 4'];

    let durationFactor = 0;
    let durationExponent = 0;
    let durationInitialSeconds = 0;

    let currentScavengeInfo = [];
    let squadRequests = [];
    let squadRequestsPremium = [];
    let squadGroups = [];
    let squadGroupsPremium = [];
    let currentPreview = null;
    let villageSelection = new Set();
    let villageSelectionInitialized = false;
    let villageTypeOverrides = loadVillageTypeOverrides();
    let sessionHistory = loadSessionHistory();
    let sessionTicker = null;
    let currentRunId = null;
    let uiState = loadUiState();
    let lastAnalysis = null;
    let activeQuickRecommendation = null;

    function log(...args) {
        if (APP.debug) console.log('[MassScavenge+]', ...args);
    }

    function notifySuccess(message) {
        if (window.UI?.SuccessMessage) UI.SuccessMessage(message);
        else alert(message);
    }

    function notifyError(message) {
        if (window.UI?.ErrorMessage) UI.ErrorMessage(message);
        else alert(message);
    }

    function notifyInfo(message) {
        if (window.UI?.InfoMessage) UI.InfoMessage(message);
        else console.info('[MassScavenge+]', message);
    }

    function ensurePage() {
        // Das Userscript darf zwar auf game.php geladen werden, greift aber ausschließlich
        // auf der Seite "Versammlungsplatz > Massenraubzug" ein. Auf allen anderen
        // Stämme-Seiten beendet es sich still und führt KEINE Weiterleitung aus.
        const params = new URLSearchParams(window.location.search);
        const isMassScavengePage =
            params.get('screen') === 'place' &&
            params.get('mode') === 'scavenge_mass';

        if (!isMassScavengePage) return false;

        if (!window.game_data || !window.jQuery) {
            console.warn('[MassScavenge+] Benötigte Seitendaten sind auf der Massenraubzug-Seite noch nicht verfügbar.');
            return false;
        }

        return true;
    }

    function getAllowedUnits() {
        return (game_data.units || [])
            .filter(unit => UNIT_META[unit])
            .filter(unit => !EXCLUDED_UNITS.has(unit));
    }

    function defaultConfig() {
        const units = getAllowedUnits();
        const enabled = {};
        const reserve = {};

        units.forEach(unit => {
            enabled[unit] = false;
            reserve[unit] = 0;
        });

        const base = {
            version: 2,
            activeProfile: 'Standard',
            unitOrder: [...units],
            unitEnabled: enabled,
            reserve,
            categories: [true, true, true, true],
            priority: 'balanced',
            timeMode: 'return',
            runtime: { off: 4, def: 3 },
            customQuickTime: '22:30',
            quickButtons: [
                { label: '+1h', type: 'hours', value: '1', distribution: 'any' },
                { label: '+2h', type: 'hours', value: '2', distribution: 'any' },
                { label: '+3h', type: 'hours', value: '3', distribution: 'high' },
                { label: '+4h', type: 'hours', value: '4', distribution: 'any' },
                { label: '+6h', type: 'hours', value: '6', distribution: 'any' },
                { label: '+8h', type: 'hours', value: '8', distribution: 'any' },
                { label: 'Heute 22:30', type: 'today', value: '22:30', distribution: 'any' },
                { label: 'Heute 23:00', type: 'today', value: '23:00', distribution: 'any' },
                { label: 'Morgen 07:00', type: 'tomorrow', value: '07:00', distribution: 'balanced' },
                { label: 'Morgen 09:00', type: 'tomorrow', value: '09:00', distribution: 'balanced' },
                { label: 'Nächster 22:30', type: 'next', value: '22:30', distribution: 'any' }
            ],
            stopQuickButtons: [
                { label: '+2h', type: 'hours', value: '2' },
                { label: '+4h', type: 'hours', value: '4' },
                { label: '+6h', type: 'hours', value: '6' },
                { label: 'Heute 22:30', type: 'today', value: '22:30' },
                { label: 'Heute 23:00', type: 'today', value: '23:00' },
                { label: 'Morgen 07:00', type: 'tomorrow', value: '07:00' }
            ],
            returnTime: {
                off: addHoursParts(4),
                def: addHoursParts(3)
            },
            profiles: {},
            ui: {
                compact: true,
                rememberPosition: true,
                left: null,
                top: null
            }
        };

        base.profiles.Standard = profileSnapshot(base);
        return base;
    }

    function profileSnapshot(source) {
        return {
            unitOrder: [...source.unitOrder],
            unitEnabled: { ...source.unitEnabled },
            reserve: { ...source.reserve },
            categories: [...source.categories],
            priority: source.priority,
            timeMode: source.timeMode,
            runtime: { ...source.runtime },
            customQuickTime: typeof source.customQuickTime === 'string' ? source.customQuickTime : '22:30',
            returnTime: {
                off: { ...source.returnTime.off },
                def: { ...source.returnTime.def }
            }
        };
    }

    function normalizeConfig(raw) {
        const base = defaultConfig();
        const units = getAllowedUnits();
        const result = {
            ...base,
            ...(raw || {}),
            runtime: { ...base.runtime, ...(raw?.runtime || {}) },
            returnTime: {
                off: { ...base.returnTime.off, ...(raw?.returnTime?.off || {}) },
                def: { ...base.returnTime.def, ...(raw?.returnTime?.def || {}) }
            },
            ui: { ...base.ui, ...(raw?.ui || {}) },
            profiles: raw?.profiles && typeof raw.profiles === 'object' ? raw.profiles : base.profiles
        };

        result.unitOrder = Array.isArray(raw?.unitOrder)
            ? raw.unitOrder.filter(u => units.includes(u))
            : [...units];

        units.forEach(unit => {
            if (!result.unitOrder.includes(unit)) result.unitOrder.push(unit);
        });

        result.unitEnabled = {};
        result.reserve = {};
        units.forEach(unit => {
            result.unitEnabled[unit] = Boolean(raw?.unitEnabled?.[unit]);
            result.reserve[unit] = safeInt(raw?.reserve?.[unit], 0, 0);
        });

        result.categories = Array.isArray(raw?.categories) && raw.categories.length >= 4
            ? raw.categories.slice(0, 4).map(Boolean)
            : [...base.categories];

        result.priority = raw?.priority === 'high' ? 'high' : 'balanced';
        result.timeMode = raw?.timeMode === 'runtime' ? 'runtime' : 'return';
        result.customQuickTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw?.customQuickTime || ''))
            ? String(raw.customQuickTime)
            : '22:30';
        const validQuickTypes = new Set(['hours', 'today', 'tomorrow', 'next']);
        const defaults = base.quickButtons;

        // v1.2.3: Nur den alten, unveränderten 4er-Standard automatisch auf die neue
        // Schnellauswahl hochziehen. Eigene Schnellbuttons des Nutzers bleiben unangetastet.
        const oldDefaultSignature = '+3h|hours|3;23:00|next|23:00;Morgen 07:00|tomorrow|07:00;22:30|today|22:30';
        const rawQuickSignature = Array.isArray(raw?.quickButtons)
            ? raw.quickButtons.map(item => `${item?.label || ''}|${item?.type || ''}|${item?.value || ''}`).join(';')
            : '';
        if (rawQuickSignature === oldDefaultSignature) {
            raw = { ...(raw || {}), quickButtons: base.quickButtons.map(item => ({ ...item })) };
        }
        result.quickButtons = Array.isArray(raw?.quickButtons)
            ? raw.quickButtons.slice(0, 6).map((item, index) => {
                const fallback = defaults[index] || defaults[0];
                const type = validQuickTypes.has(item?.type) ? item.type : fallback.type;
                let value = String(item?.value ?? fallback.value);
                if (type === 'hours') {
                    const hours = Number(value);
                    value = Number.isFinite(hours) && hours > 0 ? String(hours) : String(fallback.value);
                } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
                    value = String(fallback.value);
                }
                const distribution = ['any', 'balanced', 'high'].includes(item?.distribution)
                    ? item.distribution
                    : (['any', 'balanced', 'high'].includes(fallback.distribution) ? fallback.distribution : 'any');
                return {
                    label: String(item?.label || fallback.label).slice(0, 24),
                    type,
                    value,
                    distribution
                };
            })
            : defaults.map(item => ({ ...item }));
        if (!result.quickButtons.length) {
            result.quickButtons = defaults.map(item => ({ ...item }));
        }

        const stopDefaults = base.stopQuickButtons;
        result.stopQuickButtons = Array.isArray(raw?.stopQuickButtons)
            ? raw.stopQuickButtons.slice(0, 12).map((item, index) => {
                const fallback = stopDefaults[index] || stopDefaults[0];
                const type = validQuickTypes.has(item?.type) ? item.type : fallback.type;
                let value = String(item?.value ?? fallback.value);
                if (type === 'hours') {
                    const hours = Number(value);
                    value = Number.isFinite(hours) && hours > 0 ? String(hours) : String(fallback.value);
                } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
                    value = String(fallback.value);
                }
                return {
                    label: String(item?.label || fallback.label).slice(0, 24),
                    type,
                    value
                };
            })
            : stopDefaults.map(item => ({ ...item }));
        if (!result.stopQuickButtons.length) {
            result.stopQuickButtons = stopDefaults.map(item => ({ ...item }));
        }

        result.activeProfile = typeof raw?.activeProfile === 'string' ? raw.activeProfile : 'Standard';

        if (!result.profiles[result.activeProfile]) {
            result.activeProfile = Object.keys(result.profiles)[0] || 'Standard';
        }

        return result;
    }

    function migrateLegacyConfig() {
        const legacyExists = [
            'troopTypeEnabled', 'keepHome', 'categoryEnabled',
            'prioritiseHighCat', 'sendOrder', 'runTimes', 'timeElement'
        ].some(key => localStorage.getItem(key) !== null);

        if (!legacyExists) return null;

        const base = defaultConfig();

        try {
            const enabled = JSON.parse(localStorage.getItem('troopTypeEnabled') || '{}');
            const keepHome = JSON.parse(localStorage.getItem('keepHome') || '{}');
            const categories = JSON.parse(localStorage.getItem('categoryEnabled') || '[true,true,true,true]');
            const high = JSON.parse(localStorage.getItem('prioritiseHighCat') || 'false');
            const order = JSON.parse(localStorage.getItem('sendOrder') || '[]');
            const times = JSON.parse(localStorage.getItem('runTimes') || '{"off":4,"def":3}');
            const timeMode = localStorage.getItem('timeElement') === 'Hours' ? 'runtime' : 'return';

            getAllowedUnits().forEach(unit => {
                if (Object.prototype.hasOwnProperty.call(enabled, unit)) base.unitEnabled[unit] = Boolean(enabled[unit]);
                if (Object.prototype.hasOwnProperty.call(keepHome, unit)) base.reserve[unit] = safeInt(keepHome[unit], 0, 0);
            });

            if (Array.isArray(categories)) base.categories = categories.slice(0, 4).map(Boolean);
            base.priority = high ? 'high' : 'balanced';
            base.timeMode = timeMode;

            if (Array.isArray(order) && order.length) {
                const units = getAllowedUnits();
                base.unitOrder = order.filter(unit => units.includes(unit));
                units.forEach(unit => {
                    if (!base.unitOrder.includes(unit)) base.unitOrder.push(unit);
                });
            }

            base.runtime.off = safeFloat(times.off, 4, 0.01);
            base.runtime.def = safeFloat(times.def, 3, 0.01);
            base.returnTime.off = addHoursParts(base.runtime.off);
            base.returnTime.def = addHoursParts(base.runtime.def);
            base.profiles.Standard = profileSnapshot(base);

            return base;
        } catch (error) {
            console.warn('[MassScavenge+] Legacy-Migration fehlgeschlagen:', error);
            return null;
        }
    }

    function loadConfig() {
        try {
            const saved = localStorage.getItem(APP.storageKey);
            if (saved) return normalizeConfig(JSON.parse(saved));
        } catch (error) {
            console.warn('[MassScavenge+] Konfiguration konnte nicht gelesen werden:', error);
        }

        const migrated = migrateLegacyConfig();
        const result = normalizeConfig(migrated || defaultConfig());
        saveConfig(result);
        return result;
    }

    function saveConfig(value = config) {
        localStorage.setItem(APP.storageKey, JSON.stringify(value));
    }

    function safeInt(value, fallback = 0, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, parsed));
    }

    function safeFloat(value, fallback = 0, min = -Infinity, max = Infinity) {
        const normalized = String(value ?? '').replace(',', '.');
        const parsed = Number.parseFloat(normalized);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, parsed));
    }

    function pad2(value) {
        return String(value).padStart(2, '0');
    }

    function dateParts(date) {
        return {
            date: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
            time: `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
        };
    }

    function addHoursParts(hours) {
        return dateParts(new Date(Date.now() + Number(hours || 0) * 3600000));
    }

    function parseServerDate() {
        try {
            const dateText = $('#serverDate').first().text().trim();
            const timeText = $('#serverTime').first().text().trim();
            const dateMatch = dateText.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
            const timeMatch = timeText.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);

            if (!dateMatch || !timeMatch) return Date.now();

            const [, dd, mm, yyyy] = dateMatch;
            const [, hh, min, sec = '0'] = timeMatch;
            const parsed = new Date(
                Number(yyyy), Number(mm) - 1, Number(dd),
                Number(hh), Number(min), Number(sec), 0
            ).getTime();

            return Number.isFinite(parsed) ? parsed : Date.now();
        } catch {
            return Date.now();
        }
    }

    function parseLocalDateTime(dateValue, timeValue) {
        if (!dateValue || !timeValue) return NaN;
        const [y, m, d] = dateValue.split('-').map(Number);
        const [hh, mm] = timeValue.split(':').map(Number);
        return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
    }

    function formatDuration(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return 'Zeitpunkt liegt in der Vergangenheit';
        const total = Math.floor(seconds);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return `${h}:${pad2(m)}:${pad2(s)}`;
    }

    function formatNumber(value) {
        return new Intl.NumberFormat('de-DE').format(Math.max(0, Math.round(Number(value) || 0)));
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function injectStyles() {
        document.getElementById(APP.styleId)?.remove();

        const css = `
#${APP.id}, #${APP.id} * { box-sizing: border-box; }
#${APP.id} {
    position: fixed; z-index: 9999; left: 50%; top: 72px; transform: translateX(-50%);
    width: min(900px, calc(100vw - 28px)); max-height: calc(100vh - 92px); overflow: auto;
    font-family: Arial, Helvetica, sans-serif; color: #2b1a0d;
    background: #f4e4bc; border: 2px solid #7d510f; border-radius: 8px;
    box-shadow: 0 12px 35px rgba(0,0,0,.42);
}
#${APP.id}.msp-positioned { transform: none; }
#${APP.id} .msp-header {
    position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; background: linear-gradient(#cbb47b,#b89b5d); border-bottom: 1px solid #7d510f;
}
#${APP.id} .msp-title { font-size: 18px; font-weight: 800; color: #4b2d0b; white-space: nowrap; }
#${APP.id} .msp-version { font-size: 10px; opacity: .7; margin-left: 4px; }
#${APP.id} .msp-spacer { flex: 1; }
#${APP.id} .msp-header-summary { display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
#${APP.id} .msp-chip {
    display:inline-flex; align-items:center; gap:4px; padding:3px 7px; border:1px solid rgba(86,55,13,.35);
    border-radius:999px; background:rgba(255,245,218,.62); color:#4b2d0b; font-size:10px; font-weight:700;
}
#${APP.id} .msp-chip b { font-size:11px; }
#${APP.id} button, #${APP.id} select, #${APP.id} input { font: inherit; }
#${APP.id} .msp-btn {
    border: 1px solid #6c4824; border-radius: 5px; padding: 6px 10px; cursor: pointer;
    background: linear-gradient(#947a62,#6c4824); color: #fff; font-weight: 700;
}
#${APP.id} .msp-btn:hover { filter: brightness(1.08); }
#${APP.id} .msp-btn:disabled { opacity: .45; cursor: not-allowed; filter: none; }
#${APP.id} .msp-btn-secondary { background: linear-gradient(#dfcca1,#c7a96c); color: #4b2d0b; }
#${APP.id} .msp-btn-danger { background: linear-gradient(#bd5b51,#8d2d25); }
#${APP.id} .msp-btn-success { background: linear-gradient(#608c45,#3d672b); }
#${APP.id} .msp-btn-icon { min-width: 34px; padding: 6px 8px; }
#${APP.id} .msp-body { padding: 12px; display: grid; gap: 12px; }
#${APP.id} .msp-panel {
    border: 1px solid #b79a63; border-radius: 7px; background: #fff5da; overflow: hidden;
}
#${APP.id} .msp-panel-title {
    display: flex; align-items: center; gap: 8px; padding: 8px 10px;
    background: #e3cf9d; border-bottom: 1px solid #b79a63; font-weight: 800; color: #5c370d;
}
#${APP.id} .msp-panel-title .msp-title-actions { margin-left:auto; display:flex; gap:5px; flex-wrap:wrap; }
#${APP.id} .msp-mini-btn {
    border:1px solid #9d7b40; border-radius:4px; background:#f6e7c1; color:#4b2d0b;
    padding:2px 7px; cursor:pointer; font-size:10px; font-weight:700;
}
#${APP.id} .msp-mini-btn:hover { background:#fff3d3; }
#${APP.id} .msp-panel-content { padding: 10px; }
#${APP.id} .msp-profile-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
#${APP.id} select, #${APP.id} input[type="text"], #${APP.id} input[type="number"], #${APP.id} input[type="date"], #${APP.id} input[type="time"] {
    border: 1px solid #a98d58; border-radius: 4px; background: #fffdf7; color: #2b1a0d; padding: 6px 7px;
}
#${APP.id} .msp-units { display: flex; gap: 8px; flex-wrap: wrap; align-items: stretch; }
#${APP.id} .msp-unit-card {
    position:relative; width: 105px; min-height: 120px; padding: 8px; border: 1px solid #b79a63; border-radius: 6px;
    background: #f9edcc; text-align: center; cursor: grab; user-select: none; transition: transform .12s ease, box-shadow .12s ease, opacity .12s ease;
}
#${APP.id} .msp-unit-card:hover { transform: translateY(-1px); box-shadow:0 3px 8px rgba(83,52,12,.15); }
#${APP.id} .msp-unit-card:not(.msp-disabled) { border-color:#7e9f56; box-shadow:inset 0 0 0 1px rgba(92,132,55,.18); }
#${APP.id} .msp-unit-card.msp-disabled { opacity: .48; filter:saturate(.55); }
#${APP.id} .msp-order-badge {
    position:absolute; top:4px; left:5px; min-width:19px; height:19px; display:flex; align-items:center; justify-content:center;
    border-radius:999px; background:#c6a768; color:#4b2d0b; font-size:10px; font-weight:800; border:1px solid #9a783b;
}
#${APP.id} .msp-unit-card img { width: 34px; height: 34px; image-rendering: auto; }
#${APP.id} .msp-unit-name { font-size: 12px; font-weight: 800; margin: 4px 0 6px; }
#${APP.id} .msp-unit-card label { display: block; font-size: 11px; margin-top: 4px; }
#${APP.id} .msp-reserve { width: 76px; text-align: center; }
#${APP.id} .msp-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
#${APP.id} .msp-categories { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
#${APP.id} .msp-toggle-card {
    border: 1px solid #b79a63; border-radius: 6px; background: #f9edcc; padding: 9px; cursor: pointer; transition:.12s ease;
}
#${APP.id} .msp-toggle-card:hover { background:#fff1cd; }
#${APP.id} .msp-toggle-card.msp-category-off { opacity:.55; }
#${APP.id} .msp-toggle-card:not(.msp-category-off) { border-color:#7e9f56; box-shadow:inset 0 0 0 1px rgba(92,132,55,.15); }
#${APP.id} .msp-toggle-card strong { display: block; margin-bottom: 5px; }
#${APP.id} .msp-time-table { display: grid; grid-template-columns: 130px 1fr 1fr; gap: 8px; align-items: center; }
#${APP.id} .msp-time-head { font-weight: 800; text-align: center; }
#${APP.id} .msp-time-cell { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
#${APP.id} .msp-time-hint { font-size: 11px; opacity: .75; text-align: center; margin-top: 3px; }
#${APP.id} .msp-quick { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; }
#${APP.id} .msp-priority { display: flex; gap: 12px; flex-wrap: wrap; }
#${APP.id} .msp-priority label { flex: 1; min-width: 240px; border: 1px solid #b79a63; border-radius: 6px; padding: 9px; background: #f9edcc; cursor: pointer; }
#${APP.id} .msp-actionbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
#${APP.id} .msp-time-tools { display:flex; gap:6px; flex-wrap:wrap; margin-top:9px; align-items:center; }
#${APP.id} .msp-section-note { font-size:10px; opacity:.72; font-weight:normal; }
#${APP.id} .msp-actionbar .msp-main { flex: 1; min-width: 220px; padding: 9px 14px; }
#${APP.id} .msp-progress-wrap { display: none; margin-top: 10px; }
#${APP.id} .msp-progress-track { height: 12px; background: #dcc79b; border-radius: 20px; overflow: hidden; border: 1px solid #b79a63; }
#${APP.id} .msp-progress { height: 100%; width: 0%; background: #567d3d; transition: width .2s ease; }
#${APP.id} .msp-status { font-size: 12px; margin-top: 5px; }
#${APP.id} .msp-preview { display: none; }
#${APP.id} .msp-summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 10px; }
#${APP.id} .msp-stat { border: 1px solid #b79a63; border-radius: 6px; padding: 8px; background: #f9edcc; text-align: center; }
#${APP.id} .msp-stat b { display: block; font-size: 18px; color: #4b2d0b; }
#${APP.id} .msp-unit-summary { width: 100%; border-collapse: collapse; margin-top: 8px; }
#${APP.id} .msp-unit-summary th, #${APP.id} .msp-unit-summary td { border: 1px solid #c9af78; padding: 5px 7px; text-align: right; }
#${APP.id} .msp-unit-summary th:first-child, #${APP.id} .msp-unit-summary td:first-child { text-align: left; }
#${APP.id} .msp-preview-head { display:flex; gap:8px; align-items:center; justify-content:space-between; flex-wrap:wrap; margin-bottom:8px; }
#${APP.id} .msp-preview-return { font-size:12px; padding:7px 9px; border:1px solid #b79a63; border-radius:6px; background:#fff4d8; }
#${APP.id} .msp-detail-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:7px; margin:8px 0; }
#${APP.id} .msp-detail-card { border:1px solid #c9af78; border-radius:6px; padding:7px 9px; background:#fff7df; font-size:11px; }
#${APP.id} .msp-detail-card b { display:block; font-size:15px; color:#4b2d0b; }
#${APP.id} .msp-category-summary { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0; }
#${APP.id} .msp-category-pill { border:1px solid #b79a63; background:#f7e8bd; border-radius:14px; padding:4px 8px; font-size:11px; }
#${APP.id} .msp-send-progress { margin-top:10px; padding:7px 9px; border:1px solid #9b7b43; border-radius:6px; background:#ead9aa; font-size:11px; font-weight:bold; }
#${APP.id} .msp-group-meta { font-size:10px; opacity:.75; margin-top:2px; }
#${APP.id} .msp-send-groups { display: grid; gap: 7px; margin-top: 8px; max-height:260px; overflow:auto; padding-right:2px; }
#${APP.id} .msp-send-row { display: flex; gap: 8px; align-items: center; padding: 7px; border: 1px solid #b79a63; border-radius: 6px; background: #f9edcc; }
#${APP.id} .msp-send-row.msp-sent { opacity: .68; background: #dbe8cf; }
#${APP.id} .msp-send-row .msp-group-label { flex: 1; }
#${APP.id} .msp-warning { margin-top: 8px; padding: 7px 9px; border: 1px solid #b86f16; border-radius: 5px; background: #ffe4b3; color: #6d3a00; }

#${APP.id} .msp-preview-kpis {
    display:grid;
    grid-template-columns:repeat(4,minmax(0,1fr));
    gap:6px;
    margin:6px 0 7px;
}
#${APP.id} .msp-preview-kpi {
    border:1px solid #c7aa70;
    border-radius:5px;
    background:#f9edcc;
    padding:6px 7px;
    text-align:center;
    font-size:10px;
}
#${APP.id} .msp-preview-kpi b {
    display:block;
    font-size:15px;
    color:#4b2d0b;
}
#${APP.id} .msp-preview-ok {
    margin:6px 0;
    padding:6px 8px;
    border:1px solid #7f9e5b;
    border-radius:5px;
    background:#e6f0d8;
    color:#35501f;
    font-size:11px;
}
#${APP.id} .msp-preview-problem {
    margin:6px 0;
    padding:6px 8px;
    border:1px solid #c58a2d;
    border-radius:5px;
    background:#fff0c5;
    color:#6d4308;
    font-size:11px;
}
#${APP.id} .msp-preview-details {
    display:none;
    margin-top:7px;
    padding-top:7px;
    border-top:1px solid #dcc69a;
}
#${APP.id} .msp-preview-details.msp-open {
    display:block;
}
#${APP.id} .msp-preview-actions {
    display:flex;
    gap:6px;
    align-items:center;
    flex-wrap:wrap;
}
#${APP.id} .msp-preview-return {
    flex:1 1 auto;
}
#${APP.id} .msp-send-progress.msp-all-sent {
    border-color:#789b57;
    background:#dfeccd;
    color:#35501f;
}
#${APP.id} .msp-send-row {
    padding:6px 7px;
}
#${APP.id} .msp-send-row.msp-sent {
    display:none;
}
#${APP.id} .msp-send-groups:empty {
    display:none;
}
#${APP.id} .msp-category-summary {
    margin:6px 0;
}
#${APP.id} .msp-category-pill {
    padding:3px 7px;
}
@media (max-width:760px), (pointer:coarse) {
    #${APP.id} .msp-preview-kpis {
        grid-template-columns:repeat(2,minmax(0,1fr));
    }
    #${APP.id} .msp-preview-head {
        align-items:stretch;
    }
    #${APP.id} .msp-preview-actions {
        width:100%;
    }
    #${APP.id} .msp-preview-actions button {
        flex:1 1 auto;
    }
}

#${APP.id} .msp-hidden { display: none !important; }
#${APP.modalId} {
    position: fixed; z-index: 100005; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,.48); padding: 20px;
}
#${APP.modalId} .msp-modal-box { width: min(620px, 100%); max-height: 86vh; overflow: auto; background: #fff5da; border: 2px solid #7d510f; border-radius: 8px; box-shadow: 0 15px 40px rgba(0,0,0,.45); }
#${APP.modalId} .msp-modal-head { display: flex; gap: 8px; align-items: center; padding: 10px 12px; background: #cbb47b; border-bottom: 1px solid #7d510f; font-weight: 800; }
#${APP.modalId} .msp-modal-head span:first-child { flex: 1; }
#${APP.modalId} .msp-modal-body { padding: 12px; }
#${APP.modalId} textarea { width: 100%; min-height: 180px; resize: vertical; font-family: Consolas, monospace; font-size: 11px; }
#${APP.modalId} .msp-modal-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }

#${APP.id}.msp-compact .msp-body { padding:8px; gap:8px; }
#${APP.id}.msp-compact .msp-panel-content { padding:7px; }
#${APP.id} .msp-village-toolbar { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:8px; }
#${APP.id} .msp-village-search { min-width:220px; flex:1; padding:6px 8px; border:1px solid #a58b61; border-radius:3px; background:#fffdf6; }
#${APP.id} .msp-village-summary { display:flex; gap:6px; flex-wrap:wrap; margin:7px 0; }
#${APP.id} .msp-village-chip { background:#efe0b7; border:1px solid #b79a63; border-radius:12px; padding:3px 8px; font-size:11px; }
#${APP.id} .msp-village-list { max-height:260px; overflow:auto; border:1px solid #b79a63; background:#fffaf0; }
#${APP.id} .msp-village-row { display:grid; grid-template-columns:28px minmax(170px,1fr) 86px 80px 112px 80px; gap:6px; align-items:center; padding:5px 7px; border-bottom:1px solid #e3d3ad; font-size:11px; }
#${APP.id} .msp-village-row:last-child { border-bottom:0; }
#${APP.id} .msp-village-row:hover { background:#f5e8c7; }
#${APP.id} .msp-village-row.msp-village-off { opacity:.55; }
#${APP.id} .msp-village-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:bold; }
#${APP.id} .msp-village-type { display:inline-block; text-align:center; border-radius:10px; padding:2px 6px; font-weight:bold; }
#${APP.id} .msp-type-off { background:#f2c6b8; }
#${APP.id} .msp-type-def { background:#c8dfb5; }
#${APP.id} .msp-type-mix { background:#ddd1b5; }
#${APP.id} .msp-village-empty { padding:12px; text-align:center; color:#6e5b3d; }
#${APP.id} .msp-village-unavailable { opacity:.46; background:#eee4cf; }
#${APP.id} .msp-village-unavailable .msp-village-name { text-decoration:line-through; text-decoration-thickness:1px; }
#${APP.id} .msp-village-manual { width:108px; font-size:11px; padding:2px 3px; }
#${APP.id} .msp-free-none { font-weight:bold; color:#9c2f22; }
#${APP.id} .msp-village-filtercheck { display:inline-flex; align-items:center; gap:4px; white-space:nowrap; font-size:11px; }

#${APP.id} .msp-session-toolbar { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:8px; }
#${APP.id} .msp-session-list { display:flex; flex-direction:column; gap:7px; }
#${APP.id} .msp-session-card { border:1px solid #b79a63; border-radius:5px; background:#fff8e8; overflow:hidden; }
#${APP.id} .msp-session-card.msp-session-done { opacity:.55; }
#${APP.id} .msp-session-head { display:flex; justify-content:space-between; gap:8px; align-items:center; padding:7px 9px; background:#ead7a4; border-bottom:1px solid #c4a66d; }
#${APP.id} .msp-session-title { font-weight:bold; }
#${APP.id} .msp-session-status { font-size:11px; font-weight:bold; padding:2px 7px; border-radius:10px; background:#d8e7c8; }
#${APP.id} .msp-session-done .msp-session-status { background:#ded6c7; }
#${APP.id} .msp-session-body { padding:8px 9px; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:7px; }
#${APP.id} .msp-session-stat { background:#f4e7c5; border:1px solid #d4bd83; border-radius:4px; padding:6px; text-align:center; }
#${APP.id} .msp-session-stat b { display:block; font-size:14px; }
#${APP.id} .msp-session-stat span { display:block; font-size:10px; margin-top:2px; }
#${APP.id} .msp-session-units { padding:0 9px 8px; font-size:11px; }
#${APP.id} .msp-session-empty { padding:12px; text-align:center; color:#6e5b3d; border:1px dashed #b79a63; border-radius:5px; }
#${APP.id} .msp-next-return { font-weight:bold; }

#${APP.id} .msp-analysis-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; margin-bottom:8px; }
#${APP.id} .msp-analysis-card { border:1px solid #c5a86d; border-radius:4px; background:#fff8e8; padding:7px; }
#${APP.id} .msp-analysis-card b { display:block; font-size:14px; }
#${APP.id} .msp-analysis-card span { display:block; font-size:10px; margin-top:2px; color:#5f5139; }
#${APP.id} .msp-analysis-warning { border:1px solid #c99040; background:#fff0c9; border-radius:4px; padding:7px 8px; margin:5px 0; font-size:11px; }
#${APP.id} .msp-analysis-error { border-color:#b55d4a; background:#f8d8d0; }
#${APP.id} .msp-analysis-good { border-color:#7f9e5b; background:#e6f0d8; }
#${APP.id} .msp-analysis-table { width:100%; border-collapse:collapse; font-size:11px; margin-top:7px; }
#${APP.id} .msp-analysis-table th, #${APP.id} .msp-analysis-table td { border:1px solid #d6c094; padding:4px 5px; text-align:right; }
#${APP.id} .msp-analysis-table th:first-child, #${APP.id} .msp-analysis-table td:first-child { text-align:left; }
#${APP.id} .msp-analysis-reason { display:flex; justify-content:space-between; gap:8px; border-bottom:1px solid #ead9b5; padding:4px 0; font-size:11px; }
#${APP.id} .msp-analysis-reason:last-child { border-bottom:0; }

#${APP.id} .msp-top-status{padding:4px 6px;margin-bottom:5px;gap:4px}
#${APP.id} .msp-top-status .msp-status-pill{padding:2px 6px;font-size:10px}
#${APP.id} .msp-panel{margin-bottom:5px}
#${APP.id} .msp-panel-title{padding:5px 8px!important}
#${APP.id} .msp-panel-content{padding:7px!important}
#${APP.id} .msp-section-note{font-size:9px;opacity:.72}
#${APP.id} .msp-unit-card{padding:5px!important}
#${APP.id} .msp-category-card{padding:6px!important}
#${APP.id} #mspCalculatePanel{position:sticky;bottom:0;z-index:12;margin-bottom:0;box-shadow:0 -2px 7px rgba(0,0,0,.13)}
#${APP.id} #mspCalculatePanel>.msp-panel-title{display:none}
#${APP.id} #mspCalculatePanel>.msp-panel-content{padding:6px 8px!important;background:rgba(246,235,207,.98)}
#${APP.id} .msp-scroll-top{bottom:58px}

#${APP.id} .msp-two-col { display:block !important; }
#${APP.id} #mspCategoriesPanel,
#${APP.id} #mspDistributionPanel { width:100% !important; }

#${APP.id} #mspDistributionPanel .msp-panel-content {
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:8px;
}
#${APP.id} #mspDistributionPanel .msp-choice-card {
    margin:0 !important;
    min-height:0 !important;
    padding:8px 10px !important;
}
#${APP.id} #mspDistributionPanel .msp-choice-card small,
#${APP.id} #mspDistributionPanel .msp-choice-card span {
    font-size:10px;
}

#${APP.id} #mspTimePanel .msp-panel-content {
    padding:6px 8px !important;
}
#${APP.id} #mspTimePanel .msp-time-table {
    row-gap:5px !important;
}
#${APP.id} #mspTimePanel .msp-quick-row,
#${APP.id} #mspTimePanel .msp-copy-row {
    margin-top:5px !important;
}

#${APP.id} #mspResetBtn { display:none !important; }

/* v2.8: echte 50/50-Verteilung */
#${APP.id} #mspDistributionPanel .msp-panel-content { display:block !important; }
#${APP.id} #mspDistributionPanel .msp-priority {
    display:grid !important;
    grid-template-columns:1fr 1fr !important;
    gap:8px !important;
}
#${APP.id} #mspDistributionPanel .msp-priority label {
    margin:0 !important;
    min-height:0 !important;
    padding:8px 10px !important;
}

/* v2.8: kompakter Zeitbereich */
#${APP.id} .msp-time-mode-row {
    display:flex;
    gap:18px;
    align-items:center;
    flex-wrap:wrap;
    margin-bottom:7px;
}
#${APP.id} .msp-time-compact {
    display:grid;
    grid-template-columns:minmax(230px,1fr) 92px minmax(230px,1fr);
    gap:10px;
    align-items:end;
}
#${APP.id} .msp-time-side {
    display:flex;
    flex-direction:column;
    gap:4px;
}
#${APP.id} .msp-time-side-title {
    text-align:center;
    font-weight:bold;
    font-size:12px;
}
#${APP.id} .msp-time-side-title .msp-time-hint {
    display:inline;
    font-weight:normal;
    font-size:11px;
    color:#6b5636;
}
#${APP.id} .msp-time-inputs {
    display:flex;
    justify-content:center;
    gap:5px;
    align-items:center;
}
#${APP.id} .msp-time-copy-center {
    display:flex;
    flex-direction:column;
    gap:5px;
    align-items:stretch;
    justify-content:flex-end;
    padding-bottom:1px;
}
#${APP.id} .msp-time-copy-center button {
    white-space:nowrap;
}
#${APP.id} .msp-quick-v28 {
    display:flex;
    gap:5px;
    align-items:center;
    flex-wrap:wrap;
    margin-top:8px;
}
#${APP.id} .msp-quick-v28 .msp-quick-preset {
    min-width:58px;
}
#${APP.id} .msp-quick-settings-grid {
    display:grid;
    grid-template-columns:34px minmax(90px,1fr) minmax(125px,1.25fr) minmax(90px,1fr);
    gap:6px;
    align-items:center;
}
#${APP.id} .msp-quick-settings-grid > * {
    min-width:0;
}
#${APP.id} .msp-quick-settings-head {
    font-size:10px;
    font-weight:bold;
    opacity:.75;
}
#${APP.id} .msp-quick-settings-grid input,
#${APP.id} .msp-quick-settings-grid select {
    width:100%;
    box-sizing:border-box;
}

.msp-quick-modal-overlay {
    position:fixed;
    inset:0;
    z-index:100001;
    background:rgba(0,0,0,.42);
    display:flex;
    align-items:center;
    justify-content:center;
}


.msp-quick-modal-overlay .msp-modal-box {
    width:min(690px, calc(100vw - 32px));
    max-height:min(82vh, 620px);
    overflow:auto;
    background:#fff5da;
    border:2px solid #7d510f;
    border-radius:8px;
    box-shadow:0 16px 44px rgba(0,0,0,.48);
    color:#3d2a12;
    font-family:Verdana,Arial,sans-serif;
    font-size:12px;
}
.msp-quick-modal-overlay .msp-modal-head {
    position:sticky;
    top:0;
    z-index:2;
    display:flex;
    align-items:center;
    gap:8px;
    padding:10px 12px;
    background:#cbb47b;
    border-bottom:1px solid #7d510f;
    font-weight:800;
    font-size:13px;
}
.msp-quick-modal-overlay .msp-modal-head > span:first-child {
    flex:1;
}
.msp-quick-modal-overlay .msp-modal-body {
    padding:12px;
}
.msp-quick-modal-overlay .msp-modal-body p {
    margin:0 0 12px;
    padding:8px 10px;
    border:1px solid #d0b474;
    border-radius:5px;
    background:#f6e8c5;
    line-height:1.45;
}
.msp-quick-modal-overlay .msp-quick-settings-grid {
    display:grid;
    grid-template-columns:30px minmax(110px,1fr) minmax(135px,1.15fr) minmax(90px,.75fr) minmax(150px,1.1fr) 34px;
    gap:7px;
    align-items:center;
    padding:8px;
    border:1px solid #c9ad72;
    border-radius:5px;
    background:#fffaf0;
}
.msp-quick-modal-overlay .msp-quick-settings-head {
    font-size:10px;
    font-weight:800;
    color:#6d5734;
    padding-bottom:2px;
}
.msp-quick-modal-overlay input,
.msp-quick-modal-overlay select {
    width:100%;
    height:30px;
    box-sizing:border-box;
    padding:4px 6px;
    border:1px solid #a98a53;
    border-radius:4px;
    background:#fffdf7;
    color:#2f2416;
    font:12px Verdana,Arial,sans-serif;
}
.msp-quick-modal-overlay input:focus,
.msp-quick-modal-overlay select:focus {
    outline:2px solid rgba(142,105,39,.22);
    border-color:#7d510f;
}
.msp-quick-modal-overlay .msp-modal-actions {
    display:flex;
    justify-content:flex-end;
    gap:7px;
    margin-top:12px;
    padding-top:10px;
    border-top:1px solid #d5be8c;
}
.msp-quick-modal-overlay .msp-btn,
.msp-quick-modal-overlay .msp-mini-btn {
    display:inline-flex;
    align-items:center;
    justify-content:center;
    min-height:30px;
    padding:5px 11px;
    border:1px solid #80631f;
    border-radius:4px;
    background:linear-gradient(#ead6a4,#c8a765);
    color:#2f2416;
    font:bold 11px Verdana,Arial,sans-serif;
    cursor:pointer;
    box-shadow:inset 0 1px rgba(255,255,255,.45);
}
.msp-quick-modal-overlay .msp-btn:hover,
.msp-quick-modal-overlay .msp-mini-btn:hover {
    filter:brightness(1.05);
}
.msp-quick-modal-overlay .msp-btn-success {
    background:linear-gradient(#5f9847,#39752f);
    border-color:#2f6326;
    color:#fff;
}
.msp-quick-modal-overlay .msp-btn-danger {
    background:linear-gradient(#cf5b50,#a9312c);
    border-color:#84231f;
    color:#fff;
}
.msp-quick-modal-overlay .msp-btn-icon {
    width:30px;
    min-width:30px;
    padding:0;
}

.msp-quick-modal-overlay .msp-q-delete {
    width:30px;
    min-width:30px;
    height:30px;
    padding:0;
    border:1px solid #9b443c;
    border-radius:4px;
    background:linear-gradient(#d96e63,#b13e35);
    color:#fff;
    font-weight:bold;
    cursor:pointer;
}
.msp-quick-modal-overlay .msp-q-delete:hover {
    filter:brightness(1.08);
}
.msp-quick-modal-overlay .msp-q-add-row {
    display:flex;
    justify-content:flex-start;
    margin-top:9px;
}

#${APP.id} .msp-smart-warning {
    margin:7px 0 0;
    padding:7px 9px;
    border:1px solid #d62828;
    border-radius:5px;
    background:#ffe3df;
    color:#b51f1f;
    font-size:11px;
    font-weight:600;
    display:flex;
    gap:8px;
    align-items:center;
    flex-wrap:wrap;
    box-shadow:inset 0 0 0 1px rgba(214,40,40,.08);
}
#${APP.id} .msp-smart-warning strong { color:#a71919; }

/* v2.9.4 Mobile Layout */
@media (max-width: 760px), (pointer: coarse) {
    #${APP.id} {

    /* Statusleiste scrollt auf dem Handy normal mit dem Inhalt mit. */
    #${APP.id} .msp-top-status {
        position: static !important;
        top: auto !important;
        z-index: auto !important;
    }

    /* Allgemeines Zahnrad: Modal sicher über dem Script und im Viewport. */
    #${APP.modalId} {
        z-index: 100005 !important;
        align-items: flex-start !important;
        justify-content: center !important;
        padding: 10px 6px !important;
        box-sizing: border-box !important;
        overflow: auto !important;
    }

    #${APP.modalId} .msp-modal-box {
        width: calc(100vw - 12px) !important;
        max-width: none !important;
        max-height: calc(100dvh - 20px) !important;
        overflow: auto !important;
        margin: 0 !important;
        box-sizing: border-box !important;
    }

    #${APP.modalId} .msp-modal-head {
        position: sticky !important;
        top: 0 !important;
        z-index: 2 !important;
    }

    #${APP.modalId} .msp-modal-body {
        padding: 10px !important;
    }

    #${APP.modalId} textarea {
        min-height: 150px !important;
        max-height: 38dvh !important;
        font-size: 10px !important;
        box-sizing: border-box !important;
    }

    #${APP.modalId} .msp-modal-actions {
        display: grid !important;
        grid-template-columns: 1fr !important;
        gap: 7px !important;
    }

    #${APP.modalId} .msp-modal-actions button {
        width: 100% !important;
        min-height: 38px !important;
    }


        position: fixed !important;
        left: 6px !important;
        right: 6px !important;
        top: 118px !important;
        width: auto !important;
        max-width: none !important;
        min-width: 0 !important;
        transform: none !important;
        margin: 0 !important;
        max-height: calc(100dvh - 118px - 86px) !important;
        z-index: 99999 !important;
        box-sizing: border-box !important;
    }

    #${APP.id} .msp-header {
        cursor: grab;
        touch-action: none;
        padding: 9px 10px !important;
    }

    #${APP.id}.msp-mobile-dragging .msp-header {
        cursor: grabbing;
    }

    #${APP.id} .msp-title {
        font-size: 18px !important;
        white-space: nowrap;
    }

    #${APP.id} .msp-version {
        font-size: 10px !important;
    }

    #${APP.id} .msp-body {
        max-height: calc(100dvh - 118px - 86px - 52px) !important;
        overflow-y: auto !important;
        -webkit-overflow-scrolling: touch;
        overscroll-behavior: contain;
        padding: 7px !important;
        box-sizing: border-box !important;
    }

    #${APP.id} .msp-top-status {
        position: sticky;
        top: 0;
        z-index: 10;
        gap: 4px !important;
        padding: 5px !important;
    }

    #${APP.id} .msp-top-status .msp-status-pill {
        font-size: 10px !important;
        padding: 3px 6px !important;
    }

    #${APP.id} .msp-panel {
        margin-bottom: 6px !important;
    }

    #${APP.id} .msp-panel-title {
        padding: 7px 8px !important;
        font-size: 12px !important;
    }

    #${APP.id} .msp-panel-content {
        padding: 8px !important;
    }

    /* Verteilung: nebeneinander, solange der Platz reicht */
    #${APP.id} #mspDistributionPanel .msp-priority {
        grid-template-columns: 1fr 1fr !important;
        gap: 6px !important;
    }

    #${APP.id} #mspDistributionPanel .msp-priority label {
        padding: 8px !important;
        font-size: 11px !important;
    }

    /* Zeitbereich mobil */
    #${APP.id} .msp-time-mode-row {
        gap: 14px !important;
        margin-bottom: 7px !important;
        font-size: 11px !important;
    }

    #${APP.id} .msp-time-compact {
        grid-template-columns: 1fr !important;
        gap: 7px !important;
        align-items: stretch !important;
    }

    #${APP.id} .msp-time-side {
        gap: 4px !important;
    }

    #${APP.id} .msp-time-side-title {
        text-align: left !important;
        font-size: 12px !important;
    }

    #${APP.id} .msp-time-inputs {
        justify-content: flex-start !important;
        flex-wrap: wrap;
    }

    #${APP.id} .msp-time-inputs input[type="date"] {
        width: 145px !important;
        max-width: 56vw !important;
    }

    #${APP.id} .msp-time-inputs input[type="time"] {
        width: 88px !important;
    }

    #${APP.id} .msp-time-copy-center {
        display: grid !important;
        grid-template-columns: 1fr 1fr !important;
        gap: 6px !important;
        padding: 0 !important;
        order: 3;
    }

    #${APP.id} .msp-quick-v28 {
        gap: 5px !important;
        align-items: center !important;
        margin-top: 8px !important;
    }

    #${APP.id} #mspQuickButtons {
        display: flex !important;
        flex-wrap: wrap !important;
        gap: 5px !important;
        flex: 1 1 auto;
        min-width: 0;
    }

    #${APP.id} .msp-quick-preset {
        flex: 0 1 auto !important;
        min-width: 56px !important;
        max-width: 145px !important;
        white-space: normal !important;
        line-height: 1.15 !important;
        padding: 7px 9px !important;
    }

    #${APP.id} #mspQuickSettingsBtn {
        flex: 0 0 auto !important;
    }

    /* Dorfwahl mobil */
    #${APP.id} .msp-village-toolbar {
        gap: 5px !important;
    }

    #${APP.id} .msp-village-search {
        min-width: 0 !important;
        width: 100% !important;
        flex: 1 1 100% !important;
    }

    #${APP.id} .msp-village-row {
        grid-template-columns: 24px minmax(125px,1fr) 72px 68px !important;
        gap: 4px !important;
    }

    #${APP.id} .msp-village-row .msp-village-manual,
    #${APP.id} .msp-village-row > span:nth-last-child(1) {
        grid-column: 2 / -1;
    }

    /* Analyse enger */
    #${APP.id} .msp-analysis-grid {
        grid-template-columns: repeat(2, minmax(0,1fr)) !important;
    }

    #${APP.id} #mspCalculatePanel {
        position: sticky !important;
        bottom: 0 !important;
        z-index: 20 !important;
    }

    #${APP.id} #mspCalculateBtn {
        min-height: 42px !important;
        font-size: 13px !important;
    }

    #${APP.id} .msp-scroll-top {
        display: none !important;
    }

    .msp-quick-modal-overlay {
        align-items: flex-start !important;
        padding: 10px !important;
        box-sizing: border-box !important;
    }

    .msp-quick-modal-overlay .msp-modal-box {
        width: 100% !important;
        max-height: calc(100dvh - 20px) !important;
    }
}

@media (max-width: 460px) {
    #${APP.id} #mspDistributionPanel .msp-priority {
        grid-template-columns: 1fr !important;
    }

    #${APP.id} .msp-top-status .msp-status-pill {
        flex: 1 1 auto;
    }
}

#${APP.id} .msp-smart-warning .msp-smart-warning-text { flex:1; min-width:220px; }
#${APP.id} .msp-smart-warning.msp-smart-ok {
    border-color:#7d9d5a;
    background:#e7f0d9;
    color:#37501f;
}


@media (max-width:700px) {
    .msp-quick-modal-overlay {
        align-items:flex-start;
        padding-top:12px;
    }
    .msp-quick-modal-overlay .msp-quick-settings-grid {
        grid-template-columns:24px 1fr;
    }
    .msp-quick-modal-overlay .msp-quick-settings-head:nth-child(3),
    .msp-quick-modal-overlay .msp-quick-settings-head:nth-child(4) {
        display:none;
    }
    .msp-quick-modal-overlay .msp-q-type,
    .msp-quick-modal-overlay .msp-q-value {
        grid-column:2;
    }
}






#${APP.id} { max-height:calc(100vh - var(--msp-safe-top, 52px) - var(--msp-safe-bottom, 38px)); }
#${APP.id} .msp-body { max-height:calc(100vh - var(--msp-safe-top, 52px) - var(--msp-safe-bottom, 38px) - 50px); overflow-y:auto; scrollbar-gutter:stable; padding-bottom:14px; box-sizing:border-box; }
#${APP.id} .msp-top-status { position:sticky; top:0; z-index:8; display:flex; gap:6px; flex-wrap:wrap; align-items:center; padding:6px 8px; margin:-1px 0 8px; background:rgba(246,235,207,.96); border:1px solid #b79a63; border-radius:4px; box-shadow:0 2px 5px rgba(0,0,0,.12); backdrop-filter:blur(2px); }
#${APP.id} .msp-top-status .msp-status-pill { display:inline-flex; align-items:center; gap:4px; padding:3px 8px; border-radius:12px; border:1px solid #c4a66d; background:#fff8e8; font-size:11px; white-space:nowrap; }
#${APP.id} .msp-panel-title { cursor:pointer; user-select:none; display:flex; align-items:center; justify-content:space-between; gap:8px; }
#${APP.id} .msp-panel-title-main { display:flex; align-items:center; gap:6px; min-width:0; }
#${APP.id} .msp-collapse-icon { width:18px; height:18px; display:inline-flex; align-items:center; justify-content:center; border:1px solid #a98b57; border-radius:3px; background:#f7e8c1; font-size:11px; flex:0 0 auto; }
#${APP.id} .msp-panel.msp-collapsed > .msp-panel-content { display:none !important; }
#${APP.id} .msp-panel.msp-collapsed { margin-bottom:5px; }
#${APP.id} .msp-panel.msp-collapsed .msp-collapse-icon { transform:rotate(-90deg); }
#${APP.id} .msp-panel-title .msp-section-note { margin-left:auto; margin-right:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
#${APP.id} .msp-scroll-top { position:sticky; bottom:7px; float:right; z-index:9; margin:5px 6px 5px 0; width:30px; height:30px; border-radius:50%; border:1px solid #8d7144; background:#ead7a4; cursor:pointer; font-weight:bold; box-shadow:0 2px 5px rgba(0,0,0,.18); }



#${APP.id}.msp-compact .msp-panel-title { padding:6px 8px; }
#${APP.id}.msp-compact .msp-unit-card { width:94px; min-height:101px; padding:5px; }
#${APP.id}.msp-compact .msp-unit-card img { width:29px; height:29px; }
#${APP.id}.msp-compact .msp-unit-name { margin:2px 0 4px; }
#${APP.id}.msp-compact .msp-unit-card label { margin-top:2px; }
#${APP.id}.msp-compact .msp-toggle-card { padding:7px; }

@media (max-width: 760px) {
    #${APP.id} { top: 10px; max-height: calc(100vh - 20px); }
    #${APP.id} .msp-grid-2 { grid-template-columns: 1fr; }
    #${APP.id} .msp-categories { grid-template-columns: 1fr 1fr; }
    #${APP.id} .msp-time-table { grid-template-columns: 1fr; }
    #${APP.id} .msp-time-head { display: none; }
    #${APP.id} .msp-summary-grid { grid-template-columns: 1fr 1fr; }
    #${APP.id} .msp-detail-grid { grid-template-columns:1fr; }
    #${APP.id} .msp-unit-card { width: calc(50% - 4px); }
}

/* v2.9.6 – letzter Mobile-Override: Infoleiste soll NORMAL mitscrollen */
@media (max-width:760px), (pointer:coarse) {
    #${APP.id} .msp-top-status,
    #${APP.id} #mspTopStatus {
        position: static !important;
        top: auto !important;
        bottom: auto !important;
        left: auto !important;
        right: auto !important;
        z-index: auto !important;
        transform: none !important;
        inset: auto !important;
    }
}


/* MSP_AUTOMATE_UI_CLEANUP_121 */
#${APP.id} #mspAutoPanel .msp-auto-actions { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:7px; }
#${APP.id} #mspAutoPanel .msp-auto-statusbar {
    display:flex; align-items:stretch; flex-wrap:wrap; border:1px solid #c5a362;
    border-radius:6px; overflow:hidden; background:#fff7df; margin:6px 0 8px;
}
#${APP.id} #mspAutoPanel .msp-auto-status-main,
#${APP.id} #mspAutoPanel .msp-auto-stat { padding:7px 10px; border-right:1px solid #dec78e; box-sizing:border-box; }
#${APP.id} #mspAutoPanel .msp-auto-status-main { flex:1 1 220px; }
#${APP.id} #mspAutoPanel .msp-auto-stat { flex:0 1 105px; min-width:90px; text-align:center; }
#${APP.id} #mspAutoPanel .msp-auto-stat b,
#${APP.id} #mspAutoPanel .msp-auto-status-main b { display:block; font-size:12px; }
#${APP.id} #mspAutoPanel .msp-auto-stat small,
#${APP.id} #mspAutoPanel .msp-auto-status-main small { display:block; font-size:10px; opacity:.78; margin-top:2px; }
#${APP.id} #mspAutoPanel .msp-auto-settings {
    display:flex; gap:7px; align-items:center; flex-wrap:wrap; padding:7px 8px;
    border:1px solid #d0b26c; border-radius:5px; background:#fff5d7; margin:6px 0;
}
#${APP.id} #mspAutoPanel .msp-auto-setting-label { font-weight:bold; font-size:11px; }
#${APP.id} #mspAutoPanel .msp-auto-details { display:none; margin:7px 0; }
#${APP.id} #mspAutoPanel.msp-auto-details-open .msp-auto-details {
    display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px;
}
#${APP.id} #mspAutoPanel .msp-auto-info {
    padding:8px; border-radius:5px; border:1px solid #c3a267; background:#fff5d8;
    font-size:11px; line-height:1.4;
}
#${APP.id} #mspAutoPanel .msp-auto-info.green { background:#eaf4dc; border-color:#7f9e5b; }
#${APP.id} #mspAutoPanel .msp-auto-info.blue { background:#e8f1f9; border-color:#779fbe; }
#${APP.id} #mspAutoPanel .msp-auto-info.red { background:#ffe8df; border-color:#b75a47; }
#${APP.id} #mspAutoPanel .msp-auto-log-head {
    display:flex; align-items:center; gap:8px; justify-content:space-between;
    padding:6px 8px; margin-top:7px; background:#292929; color:#eee;
    border-radius:5px 5px 0 0; font-size:11px;
}
#${APP.id} #mspAutoPanel #mspAutoLog { border-radius:0 0 5px 5px !important; margin-top:0 !important; }
.msp-quick-modal-overlay .msp-q-move-up,
.msp-quick-modal-overlay .msp-q-move-down {
    width:24px; min-width:24px; height:25px; padding:0; border:1px solid #a98b57;
    border-radius:3px; background:#f6e8c5; cursor:pointer;
}
.msp-quick-modal-overlay .msp-q-move-up:disabled,
.msp-quick-modal-overlay .msp-q-move-down:disabled { opacity:.35; cursor:default; }
@media(max-width:760px){
    #${APP.id} #mspAutoPanel.msp-auto-details-open .msp-auto-details { grid-template-columns:1fr; }
    #${APP.id} #mspAutoPanel .msp-auto-stat { flex:1 1 30%; }
    #${APP.id} #mspAutoPanel .msp-auto-status-main { flex:1 1 100%; }
}


/* MSP 1.2.3 – Laufzeit-Schnellauswahl + Bündeln in Statusleiste */
#${APP.id} #mspTimePanel .msp-quick-box {
    display:block !important;
    margin-top:9px !important;
    padding:7px 8px 6px !important;
    border:1px solid #d0b26c;
    border-radius:5px;
    background:#fff7df;
}
#${APP.id} #mspTimePanel .msp-quick-box-head {
    font-size:11px;
    font-weight:bold;
    margin-bottom:5px;
}
#${APP.id} #mspTimePanel .msp-quick-box-row {
    display:flex;
    gap:5px;
    align-items:stretch;
    flex-wrap:wrap;
}
#${APP.id} #mspTimePanel #mspQuickButtons {
    display:flex;
    gap:5px;
    flex-wrap:wrap;
    flex:1 1 auto;
}
#${APP.id} #mspTimePanel .msp-quick-preset {
    min-width:68px !important;
    padding:6px 8px !important;
    line-height:1.1 !important;
}
#${APP.id} #mspTimePanel .msp-quick-personalize {
    white-space:nowrap;
}
#${APP.id} #mspTimePanel .msp-quick-box-foot {
    margin-top:5px;
    padding-top:5px;
    border-top:1px solid #ead7a4;
    font-size:10px;
    opacity:.72;
}
#${APP.id} #mspAutoPanel .msp-auto-bundle-stat {
    min-width:115px;
}
#${APP.id} #mspAutoPanel .msp-auto-bundle-stat small {
    display:flex;
    justify-content:center;
    align-items:center;
    gap:3px;
}
#${APP.id} #mspAutoPanel .msp-auto-bundle-stat input {
    width:46px;
    height:23px;
    padding:1px 3px;
    text-align:center;
}


/* v1.3.0 – getrennte Autopilot-Endzeit und harte Raubzug-Laufzeit */
#${APP.id} .msp-max-raid-runtime {
    margin-left:auto;
    display:inline-flex;
    align-items:center;
    gap:5px;
    padding:3px 7px;
    border:1px solid #c9ad6c;
    border-radius:4px;
    background:#fff7df;
}
#${APP.id} .msp-max-raid-runtime input {
    width:64px;
}
#${APP.id} #mspAutoPanel .msp-auto-stop-stat {
    min-width:245px;
    flex:1 1 245px;
}
#${APP.id} #mspAutoPanel .msp-auto-stop-stat small:first-of-type {
    display:flex;
    gap:4px;
    justify-content:center;
    align-items:center;
}
#${APP.id} #mspAutoPanel .msp-auto-stop-stat input[type="date"] { width:128px; }
#${APP.id} #mspAutoPanel .msp-auto-stop-stat input[type="time"] { width:76px; }
@media(max-width:760px){
    #${APP.id} .msp-max-raid-runtime { margin-left:0; flex:1 1 100%; }
    #${APP.id} #mspAutoPanel .msp-auto-stop-stat { flex:1 1 100%; }
}


/* v1.3.1 – gebündelte Zeitsteuerung */
#${APP.id} .msp-auto-time-control {
    margin:8px 8px 6px; padding:8px 10px;
    border:1px solid #b99a57; border-radius:5px; background:#fff7df;
    display:flex; align-items:center; justify-content:space-between; gap:10px;
}
#${APP.id} .msp-auto-time-control-head { display:flex; flex-direction:column; gap:2px; }
#${APP.id} .msp-auto-time-control-head span { font-size:10px; opacity:.72; }
#${APP.id} .msp-auto-time-control-inputs { display:flex; gap:5px; flex:0 0 auto; }
#${APP.id} .msp-auto-time-control-inputs input[type="date"] { width:128px; }
#${APP.id} .msp-auto-time-control-inputs input[type="time"] { width:76px; }
#${APP.id} #mspAutoPanel .msp-auto-stop-summary { min-width:145px; }
@media(max-width:760px){
 #${APP.id} .msp-auto-time-control { align-items:stretch; flex-direction:column; }
 #${APP.id} .msp-auto-time-control-inputs input[type="date"] { flex:1 1 auto; width:auto; }
}


/* v1.3.2 – Schnellauswahl für Autopilot-Endzeit */
#${APP.id} .msp-auto-time-control-right {
    display:flex; flex-direction:column; align-items:flex-end; gap:5px; min-width:0;
}
#${APP.id} .msp-auto-stop-quick {
    display:flex; flex-wrap:wrap; justify-content:flex-end; gap:4px;
}
#${APP.id} .msp-auto-stop-quick .msp-auto-stop-preset {
    padding:3px 7px !important; min-width:0 !important; font-size:10px !important;
}
@media(max-width:760px){
    #${APP.id} .msp-auto-time-control-right { align-items:stretch; }
    #${APP.id} .msp-auto-stop-quick { justify-content:flex-start; }
}


/* v1.3.3 – personalisierbare Autopilot-Schnellbuttons */
#${APP.id} .msp-auto-stop-quick-row { display:flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:5px; }
#${APP.id} #mspAutoStopQuickButtons { display:flex; flex-wrap:wrap; gap:4px; justify-content:flex-end; }
#${APP.id} #mspAutoStopQuickSettingsBtn { flex:0 0 auto; }
.msp-auto-stop-quick-grid { grid-template-columns:46px minmax(110px,1fr) 145px 110px 34px !important; }
@media(max-width:760px){
 #${APP.id} .msp-auto-stop-quick-row { justify-content:flex-start; }
 #${APP.id} #mspAutoStopQuickButtons { justify-content:flex-start; }
 .msp-auto-stop-quick-grid { grid-template-columns:24px 1fr !important; }
 .msp-auto-stop-quick-grid .msp-auto-stop-q-type,
 .msp-auto-stop-quick-grid .msp-auto-stop-q-value { grid-column:2; }
}


/* v1.3.6 – kompakter UI-Polish */
#${APP.id} .msp-time-block {
    padding:8px;
    border:1px solid #d3bd88;
    border-radius:5px;
    background:#fffdf6;
}
#${APP.id} .msp-time-block + .msp-time-block { margin-top:9px; }
#${APP.id} .msp-time-block-title {
    display:flex; align-items:center; gap:5px; margin-bottom:7px;
    font-size:12px; font-weight:700; color:#5d4719;
}
#${APP.id} .msp-info-hint {
    display:inline-flex; align-items:center; justify-content:center;
    width:16px; height:16px; border:1px solid #b99a57; border-radius:50%;
    color:#765d26; background:#fffaf0; font-size:10px; font-weight:700;
    cursor:help; flex:0 0 auto;
}
#${APP.id} .msp-quick-unified { margin-top:8px; }
#${APP.id} .msp-quick-unified-head {
    display:flex; align-items:center; justify-content:space-between; gap:8px;
    margin-bottom:5px;
}
#${APP.id} .msp-quick-purpose-title {
    font-size:10px; font-weight:700; opacity:.8; letter-spacing:.1px;
}
#${APP.id} .msp-quick-unified-row {
    display:flex; align-items:flex-start; gap:5px; flex-wrap:wrap;
}
#${APP.id} .msp-quick-unified-row > :first-child {
    display:flex; flex:1 1 320px; flex-wrap:wrap; gap:5px;
}
#${APP.id} .msp-time-hint.msp-time-past {
    opacity:1; color:#9c1f16; font-weight:700; background:#ffe9e6;
    border:1px solid #d77b70; border-radius:4px; padding:2px 5px;
}
#${APP.id} .msp-time-side.msp-time-past {
    border-color:#d77b70; background:#fff4f2;
    box-shadow:inset 0 0 0 1px rgba(156,31,22,.08);
}
/* v1.3.6 – Autopilot-Schnellwahl links und einklappbare Verteilung */
#${APP.id} #mspAutoStopQuickButtons {
    flex:0 1 auto !important;
    justify-content:flex-start !important;
}
#${APP.id} .msp-distribution-summary {
    margin-left:5px; font-size:10px; font-weight:400; opacity:.72;
}
@media(max-width:760px){
    #${APP.id} .msp-quick-unified-head { align-items:flex-start; }
    #${APP.id} .msp-quick-unified-row { flex-direction:column; }
    #${APP.id} .msp-quick-unified-row > :first-child { flex:0 1 auto; width:100%; }
    #${APP.id} .msp-quick-personalize,
    #${APP.id} #mspAutoStopQuickSettingsBtn { align-self:flex-end; }
}

`;

        $('<style>', { id: APP.styleId }).text(css).appendTo(document.head);
    }

    function extractBalancedJson(text, startIndex) {
        const opener = text[startIndex];
        if (opener !== '{' && opener !== '[') return null;

        const stack = [opener];
        let inString = false;
        let escaped = false;

        for (let i = startIndex + 1; i < text.length; i++) {
            const ch = text[i];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (ch === '\\') {
                    escaped = true;
                } else if (ch === '"') {
                    inString = false;
                }
                continue;
            }

            if (ch === '"') {
                inString = true;
                continue;
            }

            if (ch === '{' || ch === '[') {
                stack.push(ch);
                continue;
            }

            if (ch === '}' || ch === ']') {
                const expected = ch === '}' ? '{' : '[';
                if (stack[stack.length - 1] !== expected) return null;
                stack.pop();
                if (stack.length === 0) {
                    return text.slice(startIndex, i + 1);
                }
            }
        }
        return null;
    }

    function findParsedContainerAround(text, anchorIndex, predicate, lookBack = 25000) {
        const from = Math.max(0, anchorIndex - lookBack);
        const starts = [];
        for (let i = anchorIndex; i >= from; i--) {
            if (text[i] === '{' || text[i] === '[') starts.push(i);
        }

        for (const start of starts) {
            const raw = extractBalancedJson(text, start);
            if (!raw || start + raw.length <= anchorIndex) continue;
            try {
                const parsed = JSON.parse(raw);
                if (predicate(parsed)) return parsed;
            } catch (_) {
                // Kein eigenständiger JSON-Block; nächstgrößeren Container versuchen.
            }
        }
        return null;
    }

    function findNestedValue(root, predicate, maxDepth = 8) {
        const seen = new Set();
        function walk(value, depth) {
            if (value == null || typeof value !== 'object' || depth > maxDepth || seen.has(value)) return null;
            seen.add(value);
            if (predicate(value)) return value;
            for (const child of Object.values(value)) {
                const found = walk(child, depth + 1);
                if (found) return found;
            }
            return null;
        }
        return walk(root, 0);
    }

    function scavengeScriptTextFromHtml(html) {
        const script = $(html).find('script').filter((_, el) => (el.textContent || '').includes('ScavengeMassScreen')).first();
        const text = script.html() || script.text() || '';
        if (!text) throw new Error('ScavengeMassScreen-Daten wurden nicht gefunden.');
        return text;
    }

    function extractWorldParameters(html) {
        const text = scavengeScriptTextFromHtml(html);
        const anchor = text.indexOf('duration_exponent');
        if (anchor < 0) throw new Error('Weltparameter wurden in der Seite nicht gefunden.');

        const container = findParsedContainerAround(
            text,
            anchor,
            value => !!findNestedValue(value, v =>
                Object.prototype.hasOwnProperty.call(v, 'duration_exponent') &&
                Object.prototype.hasOwnProperty.call(v, 'duration_factor')
            )
        );
        if (!container) throw new Error('Weltparameter konnten nicht als JSON gelesen werden.');

        const params = findNestedValue(container, v =>
            Object.prototype.hasOwnProperty.call(v, 'duration_exponent') &&
            Object.prototype.hasOwnProperty.call(v, 'duration_factor')
        );
        if (!params) throw new Error('Weltparameter sind unvollständig.');
        return params;
    }

    function extractVillagesFromHtml(html) {
        const text = scavengeScriptTextFromHtml(html);
        const villages = [];
        const seen = new Set();
        const anchorRegex = /["']unit_counts_home["']/g;
        let match;

        while ((match = anchorRegex.exec(text)) !== null) {
            const village = findParsedContainerAround(text, match.index, value =>
                value && typeof value === 'object' && !Array.isArray(value) &&
                value.village_id != null && value.unit_counts_home && value.options
            , 12000);

            if (village && !seen.has(String(village.village_id))) {
                seen.add(String(village.village_id));
                villages.push(village);
            }
        }

        if (!villages.length) {
            throw new Error('Auf dieser Sammelseite wurden keine Dorf-Datensätze erkannt.');
        }
        return villages;
    }

    function readCategoryNamesFromPage() {
        try {
            const text = $('script').filter((_, el) => (el.textContent || '').includes('ScavengeMassScreen')).first().html() || '';
            const candidates = [];
            const nameRegex = /["']name["']/g;
            let match;

            while ((match = nameRegex.exec(text)) !== null && candidates.length < 40) {
                const container = findParsedContainerAround(text, match.index, value => {
                    if (!value || typeof value !== 'object') return false;
                    const names = [1, 2, 3, 4].map(i => value?.[i]?.name).filter(Boolean);
                    return names.length === 4;
                }, 10000);
                if (container) {
                    const names = [1, 2, 3, 4].map(i => container?.[i]?.name).filter(Boolean);
                    if (names.length === 4) {
                        categoryNames = names;
                        return;
                    }
                }
                candidates.push(match.index);
            }
        } catch (error) {
            log('Kategorienamen konnten nicht gelesen werden', error);
        }
    }

    function unitImage(unit) {
        return `/graphic/unit/unit_${unit}.png`;
    }

    function renderApp() {
        document.getElementById(APP.id)?.remove();
        document.getElementById(APP.modalId)?.remove();
        injectStyles();

        const root = $(`
<div id="${APP.id}" class="msp-compact">
    <div class="msp-header">
        <div class="msp-title">Mass Scavenge+ Automate <span class="msp-version">v${APP.version} SIM</span></div>
        <div class="msp-spacer"></div>
        <button class="msp-btn msp-btn-secondary msp-btn-icon" id="mspSettingsBtn" title="Einstellungen">⚙</button>
        <button class="msp-btn msp-btn-danger msp-btn-icon" id="mspCloseBtn" title="Schließen">✕</button>
    </div>
    <div class="msp-body">
            <div class="msp-top-status" id="mspTopStatus">
                <span class="msp-status-pill" id="mspStatusTroops">Truppen: —</span>
                <span class="msp-status-pill" id="mspStatusCategories">Kategorien: —</span>
                <span class="msp-status-pill" id="mspStatusVillages">Dörfer: —</span>
                <span class="msp-status-pill" id="mspStatusReturn">Rückkehr: —</span>
            </div>
        

        <section class="msp-panel" id="mspTroopsPanel">
            <div class="msp-panel-title">
                1. Truppen auswählen <span class="msp-section-note">(ziehen = Priorität)</span>
                <span class="msp-title-actions">
                    <button class="msp-mini-btn" id="mspUnitsAll" type="button">Alle</button>
                    <button class="msp-mini-btn" id="mspUnitsNone" type="button">Keine</button>
                    <button class="msp-mini-btn" id="mspReserveZero" type="button">Reserven 0</button>
                </span>
            </div>
            <div class="msp-panel-content">
                <div class="msp-units" id="mspUnits"></div>
            </div>
        </section>

        <section class="msp-panel" id="mspCategoriesPanel">
                <div class="msp-panel-title">
                    2. Sammelkategorien
                    <span class="msp-title-actions">
                        <button class="msp-mini-btn" id="mspCatsAll" type="button">Alle</button>
                        <button class="msp-mini-btn" id="mspCatsNone" type="button">Keine</button>
                    </span>
                </div>
                <div class="msp-panel-content">
                    <div class="msp-categories" id="mspCategories"></div>
                </div>
            </section>

            <section class="msp-panel" id="mspDistributionPanel">
                <div class="msp-panel-title">3. Verteilung <span class="msp-distribution-summary" id="mspDistributionSummary">· Ausgeglichen</span></div>
                <div class="msp-panel-content">
                    <div class="msp-priority">
                        <label><input type="radio" name="mspPriority" value="balanced"> <b>Ausgeglichen</b><br><small>Truppen möglichst auf aktive Kategorien verteilen.</small></label>
                        <label><input type="radio" name="mspPriority" value="high"> <b>Hohe Kategorien zuerst</b><br><small>Höhere Sammelstufen zuerst füllen.</small></label>
                    </div>
                
                <div id="mspSmartWarning" style="display:none"></div>
            </div>
            </section>

        <section class="msp-panel" id="mspTimePanel">
            <div class="msp-panel-title">🕰️ Zeitsteuerung</div>
            <div class="msp-panel-content">
                <div class="msp-time-block">
                    <div class="msp-time-block-title">Raubzüge <span class="msp-info-hint" title="Lege Rückkehrzeit oder Laufzeit für Off- und Def-Dörfer fest.">ⓘ</span></div>
                    <div class="msp-time-mode-row">
                        <label><input type="radio" name="mspTimeMode" value="return"> Rückkehrzeit</label>
                        <label><input type="radio" name="mspTimeMode" value="runtime"> Laufzeit in Stunden</label>
                        <label class="msp-max-raid-runtime" title="Harte Obergrenze: Kein einzelner neu gestarteter Raubzug darf länger laufen – unabhängig von Rückkehrzeit oder eingestellter Laufzeit.">
                            <b>Max. je Raubzug:</b>
                            <input id="mspAutoMaxRaidHours" type="number" min="0.1" max="48" step="0.25"
                                value="${escapeHtml(String(AUTO.maxRaidHours))}"> Std.
                            <span class="msp-info-hint" title="Harte Obergrenze: gilt immer, unabhängig von Rückkehrzeit oder Laufzeit.">ⓘ</span>
                        </label>
                    </div>

                    <div class="msp-time-compact">
                        <div class="msp-time-side" id="mspOffTimeSide">
                            <div class="msp-time-side-title">Off-Dörfer <span class="msp-time-hint" id="mspOffDuration"></span></div>
                            <div class="msp-time-inputs msp-return-row">
                                <input type="date" id="mspOffDate"><input type="time" id="mspOffTime">
                            </div>
                            <div class="msp-time-inputs msp-runtime-row">
                                <input type="number" id="mspOffRuntime" min="0.01" step="0.05" style="width:105px;"><span>Stunden</span>
                            </div>
                        </div>
                        <div class="msp-time-copy-center">
                            <button class="msp-mini-btn" id="mspCopyOffToDef" type="button">Off → Def</button>
                            <button class="msp-mini-btn" id="mspCopyDefToOff" type="button">Def → Off</button>
                        </div>
                        <div class="msp-time-side" id="mspDefTimeSide">
                            <div class="msp-time-side-title">Def-Dörfer <span class="msp-time-hint" id="mspDefDuration"></span></div>
                            <div class="msp-time-inputs msp-return-row">
                                <input type="date" id="mspDefDate"><input type="time" id="mspDefTime">
                            </div>
                            <div class="msp-time-inputs msp-runtime-row">
                                <input type="number" id="mspDefRuntime" min="0.01" step="0.05" style="width:105px;"><span>Stunden</span>
                            </div>
                        </div>
                    </div>

                    <div class="msp-quick-unified">
                        <div class="msp-quick-unified-head"><span class="msp-quick-purpose-title">⏱ Schnellwahl Raubzüge</span><span class="msp-info-hint" title="Setzt Laufzeit oder Rückkehr direkt für Off- und Def-Dörfer.">ⓘ</span></div>
                        <div class="msp-quick-unified-row">
                            <span id="mspQuickButtons"></span>
                            <button class="msp-btn msp-btn-secondary msp-quick-personalize" id="mspQuickSettingsBtn" type="button" title="Schnellbuttons einstellen, umbenennen und sortieren">⚙ Personalisieren</button>
                        </div>
                        <div class="msp-quick-box-foot" id="mspQuickHint">Setzt Off und Def gemeinsam.</div>
                    </div>
                </div>

                <div class="msp-time-block">
                    <div class="msp-time-block-title">🔴 Autopilot-Ende <span class="msp-info-hint" title="Bis zu diesem Zeitpunkt darf der Autopilot neue Aufträge starten. Laufende Raubzüge kehren normal zurück.">ⓘ</span></div>
                    <div class="msp-auto-time-control-inputs">
                        <input id="mspAutoStopDate" type="date"><input id="mspAutoStopTime" type="time">
                    </div>
                    <div class="msp-quick-unified">
                        <div class="msp-quick-unified-head"><span class="msp-quick-purpose-title">🛑 Schnellwahl Autopilot-Ende</span></div>
                        <div class="msp-quick-unified-row">
                            <div id="mspAutoStopQuickButtons" aria-label="Schnellwahl Autopilot-Ende"></div>
                            <button type="button" class="msp-btn msp-btn-secondary msp-quick-personalize" id="mspAutoStopQuickSettingsBtn" title="Schnellbuttons einstellen, umbenennen und sortieren">⚙ Personalisieren</button>
                        </div>
                    </div>
                </div>
            </div>
        </section>

        <section class="msp-panel" id="mspVillagesPanel">
            <div class="msp-panel-title">5. Dörfer <span class="msp-section-note">optional auswählen oder filtern</span></div>
            <div class="msp-panel-content">
                <div class="msp-village-toolbar">
                    <button class="msp-btn msp-btn-secondary" id="mspLoadVillagesBtn" type="button">Dörfer laden</button>
                    <input class="msp-village-search" id="mspVillageSearch" type="text" placeholder="Dorfname oder Koordinate suchen …" disabled>
                    <select id="mspVillageTypeFilter" disabled>
                        <option value="all">Alle Typen</option>
                        <option value="off">Off-Dörfer</option>
                        <option value="def">Def-Dörfer</option>
                        <option value="mix">Gemischt</option>
                    </select>
                    <label class="msp-village-filtercheck" title="Zeigt nur Dörfer, in denen mindestens eine Sammelkategorie frei ist.">
                        <input type="checkbox" id="mspOnlyUsableVillages" disabled> nur nutzbare
                    </label>
                </div>
                <div class="msp-village-toolbar">
                    <button class="msp-mini-btn" id="mspVillagesAll" type="button" disabled>Alle auswählen</button>
                    <button class="msp-mini-btn" id="mspVillagesNone" type="button" disabled>Alle abwählen</button>
                    <button class="msp-mini-btn" id="mspVillagesVisible" type="button" disabled>Sichtbare auswählen</button>
                    <button class="msp-mini-btn" id="mspVillagesVisibleNone" type="button" disabled>Sichtbare abwählen</button>
                    <label class="msp-village-filtercheck" title="Dörfer ohne freie Sammelkategorie werden beim Laden automatisch aus der Auswahl genommen.">
                        <input type="checkbox" id="mspAutoDeselectBlocked" checked disabled> 0/4 automatisch abwählen
                    </label>
                </div>
                <div class="msp-village-summary" id="mspVillageSummary"><span class="msp-village-chip">Noch nicht geladen – Berechnen nutzt automatisch alle Dörfer.</span></div>
                <div class="msp-village-list" id="mspVillageList" style="display:none"></div>
            </div>
        </section>

        <section class="msp-panel" id="mspAnalysisPanel">
            <div class="msp-panel-title">6. Berechnungsanalyse <span class="msp-section-note">warum das Script so plant</span></div>
            <div class="msp-panel-content">
                <div id="mspAnalysisContent"><div class="msp-session-empty">Noch keine Berechnung durchgeführt.</div></div>
            </div>
        </section>

        

        <section class="msp-panel" id="mspCalculatePanel">
            <div class="msp-panel-title">7. Berechnen</div>
            <div class="msp-panel-content">
                <div class="msp-actionbar">
                    <button class="msp-btn msp-btn-success msp-main" id="mspCalculateBtn">Sammelaufträge berechnen</button>
                    <button id="mspResetBtn" class="msp-btn msp-btn-secondary" id="mspResetFormBtn">Eingaben zurücksetzen</button>
                </div>
                <div class="msp-progress-wrap" id="mspProgressWrap">
                    <div class="msp-progress-track"><div class="msp-progress" id="mspProgress"></div></div>
                    <div class="msp-status" id="mspStatus">Bereit.</div>
                </div>
            </div>
        </section>

        <section class="msp-panel msp-preview" id="mspPreviewPanel">
            <div class="msp-panel-title">Vorschau & Versand</div>
            <div class="msp-panel-content" id="mspPreviewContent"></div>
        </section>
    </div>
</div>`);

        $('.maincell, #mobileContent').first().prepend(root);

        applyStoredPosition();
        fillProfileSelect();
        renderUnits();
        renderCategories();
        syncFormFromConfig();
        bindEvents();
        updateHeaderSummary();

        if ($.fn.draggable && !isMobileLayout()) {
            root.draggable({
                handle: '.msp-header',
                containment: 'window',
                stop: (_, ui) => {
                    if (config.ui.rememberPosition) {
                        config.ui.left = ui.position.left;
                        config.ui.top = ui.position.top;
                        saveConfig();
                    }
                }
            });
        }
    }

    function applyStoredPosition() {
        if (isMobileLayout()) {
            const top = Number.isFinite(config.ui.top)
                ? Math.max(mobileTopBoundary(), config.ui.top)
                : mobileTopBoundary();
            $(`#${APP.id}`)
                .addClass('msp-positioned')
                .css({ left: '6px', right: '6px', width: 'auto', top: `${top}px`, bottom: 'auto', transform: 'none' });
            return;
        }

        if (!config.ui.rememberPosition) return;
        if (Number.isFinite(config.ui.left) && Number.isFinite(config.ui.top)) {
            $(`#${APP.id}`)
                .addClass('msp-positioned')
                .css({ left: `${config.ui.left}px`, top: `${config.ui.top}px` });
        }
    }

    function fillProfileSelect() {
        const select = $('#mspProfileSelect').empty();
        Object.keys(config.profiles).sort((a, b) => a.localeCompare(b, 'de')).forEach(name => {
            $('<option>').val(name).text(name).appendTo(select);
        });
        select.val(config.activeProfile);
    }

    function renderUnits() {
        const host = $('#mspUnits').empty();
        config.unitOrder.forEach(unit => {
            const meta = UNIT_META[unit];
            if (!meta) return;

            const enabled = Boolean(config.unitEnabled[unit]);
            host.append(`
<div class="msp-unit-card ${enabled ? '' : 'msp-disabled'}" data-unit="${unit}">
    <span class="msp-order-badge">${config.unitOrder.indexOf(unit) + 1}</span>
    <img src="${unitImage(unit)}" alt="${escapeHtml(meta.label)}">
    <div class="msp-unit-name">${escapeHtml(meta.label)}</div>
    <label><input type="checkbox" class="msp-unit-enabled" ${enabled ? 'checked' : ''}> verwenden</label>
    <label>Reserve<br><input type="number" class="msp-reserve" min="0" step="1" value="${safeInt(config.reserve[unit], 0, 0)}"></label>
</div>`);
        });

        if ($.fn.sortable) {
            host.sortable({
                axis: false,
                tolerance: 'pointer',
                distance: 5,
                update: () => {
                    config.unitOrder = $('#mspUnits .msp-unit-card').map((_, el) => $(el).data('unit')).get();
                    $('#mspUnits .msp-order-badge').each((index, el) => $(el).text(index + 1));
                    saveConfig();
                    updateHeaderSummary();
                    clearPreview();
                }
            }).disableSelection();
        }
    }

    function renderCategories() {
        const host = $('#mspCategories').empty();
        for (let i = 0; i < 4; i++) {
            host.append(`
<label class="msp-toggle-card ${config.categories[i] ? '' : 'msp-category-off'}">
    <strong>${escapeHtml(categoryNames[i] || `Kategorie ${i + 1}`)}</strong>
    <input type="checkbox" class="msp-category" data-index="${i}" ${config.categories[i] ? 'checked' : ''}> aktiv
</label>`);
        }
    }

    function syncFormFromConfig() {
        config.unitOrder.forEach(unit => {
            const card = $(`#mspUnits .msp-unit-card[data-unit="${unit}"]`);
            card.find('.msp-unit-enabled').prop('checked', Boolean(config.unitEnabled[unit]));
            card.toggleClass('msp-disabled', !config.unitEnabled[unit]);
            card.find('.msp-reserve').val(safeInt(config.reserve[unit], 0, 0));
        });

        $('.msp-category').each((_, el) => {
            const index = Number($(el).data('index'));
            const active = Boolean(config.categories[index]);
            $(el).prop('checked', active);
            $(el).closest('.msp-toggle-card').toggleClass('msp-category-off', !active);
        });

        $(`input[name="mspPriority"][value="${config.priority}"]`).prop('checked', true);
        $(`input[name="mspTimeMode"][value="${config.timeMode}"]`).prop('checked', true);
        renderQuickButtons();

        $('#mspOffRuntime').val(config.runtime.off);
        $('#mspDefRuntime').val(config.runtime.def);
        $('#mspOffDate').val(config.returnTime.off.date);
        $('#mspOffTime').val(config.returnTime.off.time);
        $('#mspDefDate').val(config.returnTime.def.date);
        $('#mspDefTime').val(config.returnTime.def.time);

        updateTimeModeVisibility();
        updateDurationHints();
        updateHeaderSummary();
    }

    function readFormIntoConfig() {
        const units = [];
        $('#mspUnits .msp-unit-card').each((_, el) => {
            const unit = $(el).data('unit');
            units.push(unit);
            config.unitEnabled[unit] = $(el).find('.msp-unit-enabled').is(':checked');
            config.reserve[unit] = safeInt($(el).find('.msp-reserve').val(), 0, 0);
        });
        config.unitOrder = units;

        config.categories = [0, 1, 2, 3].map(i => $(`.msp-category[data-index="${i}"]`).is(':checked'));
        config.priority = $('input[name="mspPriority"]:checked').val() === 'high' ? 'high' : 'balanced';
        config.timeMode = $('input[name="mspTimeMode"]:checked').val() === 'runtime' ? 'runtime' : 'return';

        config.runtime.off = safeFloat($('#mspOffRuntime').val(), 4, 0.01);
        config.runtime.def = safeFloat($('#mspDefRuntime').val(), 3, 0.01);
        config.returnTime.off = { date: $('#mspOffDate').val(), time: $('#mspOffTime').val() };
        config.returnTime.def = { date: $('#mspDefDate').val(), time: $('#mspDefTime').val() };

        saveConfig();
    }


    function updateHeaderSummary() {
        // v2.9.1: Alle Statusinformationen stehen nur noch in einer Zeile.
        updateTopStatus();
    }

    function setAllUnits(enabled) {
        $('#mspUnits .msp-unit-enabled').prop('checked', enabled).each((_, el) => {
            $(el).closest('.msp-unit-card').toggleClass('msp-disabled', !enabled);
        });
        readFormIntoConfig();
        updateHeaderSummary();
        clearPreview();
    }

    function setAllCategories(enabled) {
        $('.msp-category').prop('checked', enabled).each((_, el) => {
            $(el).closest('.msp-toggle-card').toggleClass('msp-category-off', !enabled);
        });
        readFormIntoConfig();
        updateHeaderSummary();
        clearPreview();
    }

    function copyTime(direction) {
        const mode = $('input[name="mspTimeMode"]:checked').val();
        if (mode === 'runtime') {
            if (direction === 'offToDef') $('#mspDefRuntime').val($('#mspOffRuntime').val());
            else $('#mspOffRuntime').val($('#mspDefRuntime').val());
        } else {
            if (direction === 'offToDef') {
                $('#mspDefDate').val($('#mspOffDate').val());
                $('#mspDefTime').val($('#mspOffTime').val());
            } else {
                $('#mspOffDate').val($('#mspDefDate').val());
                $('#mspOffTime').val($('#mspDefTime').val());
            }
        }
        readFormIntoConfig();
        updateDurationHints();
        updateHeaderSummary();
        clearPreview();
    }

    function bindEvents() {
        $('#mspCloseBtn').on('click', () => {
            readFormIntoConfig();
            $(`#${APP.id}`).remove();
            $(`#${APP.modalId}`).remove();
        });

        $('#mspSettingsBtn').on('click', openSettingsModal);

        $('#mspCompactBtn').on('click', () => {
            config.ui.compact = !config.ui.compact;
            saveConfig();
            $(`#${APP.id}`).toggleClass('msp-compact', config.ui.compact);
        });

        $('#mspUnitsAll').on('click', () => setAllUnits(true));
        $('#mspUnitsNone').on('click', () => setAllUnits(false));
        $('#mspReserveZero').on('click', () => {
            $('#mspUnits .msp-reserve').val(0);
            readFormIntoConfig();
            clearPreview();
        });

        $('#mspCatsAll').on('click', () => setAllCategories(true));
        $('#mspCatsNone').on('click', () => setAllCategories(false));

        $('#mspCopyOffToDef').on('click', () => copyTime('offToDef'));
        $('#mspCopyDefToOff').on('click', () => copyTime('defToOff'));

        $('#mspUnits').on('change', '.msp-unit-enabled', function () {
            const card = $(this).closest('.msp-unit-card');
            card.toggleClass('msp-disabled', !this.checked);
            readFormIntoConfig();
            updateHeaderSummary();
            clearPreview();
        });

        $('#mspUnits').on('change input', '.msp-reserve', () => {
            readFormIntoConfig();
            clearPreview();
        });

        $('.msp-category').on('change', function () {
            $(this).closest('.msp-toggle-card').toggleClass('msp-category-off', !this.checked);
            readFormIntoConfig();
            updateHeaderSummary();
            clearPreview();
        });

        $('input[name="mspPriority"]').on('change', () => {
            readFormIntoConfig();
            updateDistributionPanelTitle();
            clearPreview();
        });

        $('input[name="mspTimeMode"]').on('change', () => {
            readFormIntoConfig();
            updateTimeModeVisibility();
            updateDurationHints();
            updateHeaderSummary();
            clearPreview();
        });

        $('#mspOffDate,#mspOffTime,#mspDefDate,#mspDefTime,#mspOffRuntime,#mspDefRuntime').on('input change', () => {
            readFormIntoConfig();
            updateDurationHints();
            updateHeaderSummary();
            clearPreview();
        });

        $('#mspQuickButtons').on('click', '.msp-quick-preset', function () {
            applyQuickPreset(Number($(this).data('index')));
        });
        $('#mspQuickSettingsBtn').on('click', openQuickSettingsModal);

        $('#mspLoadVillagesBtn').on('click', loadVillagesForSelection);
        $('#mspVillageSearch,#mspVillageTypeFilter,#mspOnlyUsableVillages').on('input change', renderVillageSelection);
        $('#mspVillagesAll').on('click', () => setVillageSelection('all'));
        $('#mspVillagesNone').on('click', () => setVillageSelection('none'));
        $('#mspVillagesVisible').on('click', () => setVillageSelection('visible-on'));
        $('#mspVillagesVisibleNone').on('click', () => setVillageSelection('visible-off'));
        $('#mspVillageList').on('change', '.msp-village-check', function () {
            const id = String($(this).data('village'));
            if (this.checked) villageSelection.add(id); else villageSelection.delete(id);
            $(this).closest('.msp-village-row').toggleClass('msp-village-off', !this.checked);
            updateVillageSummary();
            clearPreviewKeepVillages();
        });
        $('#mspVillageList').on('change', '.msp-village-manual', function () {
            const id = String($(this).data('village'));
            const value = String($(this).val() || 'auto');
            if (value === 'auto') delete villageTypeOverrides[id];
            else villageTypeOverrides[id] = value;
            saveVillageTypeOverrides();
            renderVillageSelection();
            clearPreviewKeepVillages();
        });

        $('#mspSessionRefresh').on('click', renderSessionHistory);
        $('#mspSessionClearDone').on('click', function () {
            const now = Date.now();
            sessionHistory = sessionHistory.filter(item => Number(item.returnAt || 0) > now);
            saveSessionHistory();
            renderSessionHistory();
        });
        $('#mspSessionClearAll').on('click', function () {
            if (!sessionHistory.length) return;
            if (!window.confirm('Wirklich die komplette Rückkehrübersicht leeren?')) return;
            sessionHistory = [];
            saveSessionHistory();
            renderSessionHistory();
        });

        $('#mspSmartWarning').on('click', '#mspApplyRecommendedDistribution', function () {
            if (activeQuickRecommendation?.distribution) {
                setDistribution(activeQuickRecommendation.distribution);
            }
        });
        $('#mspSmartWarning').on('click', '#mspIgnoreRecommendedDistribution', function () {
            activeQuickRecommendation = null;
            updateSmartWarning();
        });
        $('input[name="mspPriority"]').on('change', function () {
            readFormIntoConfig();
            updateSmartWarning();
        });

        $('#mspCalculateBtn').on('click', calculateAll);
        $('#mspResetFormBtn').on('click', resetFormOnly);

        $('#mspProfileLoad').on('click', loadSelectedProfile);
        $('#mspProfileSave').on('click', saveCurrentProfile);
        $('#mspProfileNew').on('click', createProfile);
        $('#mspProfileDelete').on('click', deleteProfile);

        $('#mspProfileSelect').on('change', function () {
            config.activeProfile = String($(this).val() || 'Standard');
            saveConfig();
        });
    }

    function setRuntimeBoth(hours) {
        $('input[name="mspTimeMode"][value="runtime"]').prop('checked', true);
        $('#mspOffRuntime,#mspDefRuntime').val(hours);
        readFormIntoConfig();
        updateTimeModeVisibility();
        updateDurationHints();
        updateHeaderSummary();
        clearPreview();
    }

    function setReturnBoth(hour, minute, dayOffset) {
        const date = new Date(serverDateMs);
        date.setHours(hour, minute, 0, 0);
        date.setDate(date.getDate() + dayOffset);
        if (dayOffset === 0 && date.getTime() <= serverDateMs) date.setDate(date.getDate() + 1);
        const parts = dateParts(date);

        $('input[name="mspTimeMode"][value="return"]').prop('checked', true);
        $('#mspOffDate,#mspDefDate').val(parts.date);
        $('#mspOffTime,#mspDefTime').val(parts.time);
        readFormIntoConfig();
        updateTimeModeVisibility();
        updateDurationHints();
        updateHeaderSummary();
        clearPreview();
    }

    function updateTimeModeVisibility() {
        const mode = $('input[name="mspTimeMode"]:checked').val();
        $('.msp-return-row').toggleClass('msp-hidden', mode !== 'return');
        $('.msp-runtime-row').toggleClass('msp-hidden', mode !== 'runtime');
    }

    function getEffectiveTimes() {
        serverDateMs = parseServerDate();
        const mode = $('input[name="mspTimeMode"]:checked').val();

        if (mode === 'runtime') {
            return {
                off: safeFloat($('#mspOffRuntime').val(), NaN, 0.01),
                def: safeFloat($('#mspDefRuntime').val(), NaN, 0.01)
            };
        }

        const offTarget = parseLocalDateTime($('#mspOffDate').val(), $('#mspOffTime').val());
        const defTarget = parseLocalDateTime($('#mspDefDate').val(), $('#mspDefTime').val());
        return {
            off: (offTarget - serverDateMs) / 3600000,
            def: (defTarget - serverDateMs) / 3600000
        };
    }

    function updateDurationHints() {
        const times = getEffectiveTimes();
        const returnMode = config.timeMode === 'return';
        [
            { key:'Off', hours:times.off },
            { key:'Def', hours:times.def }
        ].forEach(item => {
            const past = returnMode && Number.isFinite(item.hours) && item.hours < 0;
            const hint = $(`#msp${item.key}Duration`);
            const side = $(`#msp${item.key}TimeSide`);
            hint.text(past ? '⚠ Vergangenheit' : `(${formatDuration(item.hours * 3600)})`)
                .toggleClass('msp-time-past', past);
            side.toggleClass('msp-time-past', past);
        });
    }

    function saveCurrentProfile() {
        readFormIntoConfig();
        const name = String($('#mspProfileSelect').val() || config.activeProfile || 'Standard');
        config.activeProfile = name;
        config.profiles[name] = profileSnapshot(config);
        saveConfig();
        fillProfileSelect();
        notifySuccess(`Profil „${name}“ gespeichert.`);
    }

    function createProfile() {
        readFormIntoConfig();
        const raw = prompt('Name des neuen Profils:');
        if (raw === null) return;
        const name = raw.trim();
        if (!name) return notifyError('Bitte einen Profilnamen eingeben.');
        if (config.profiles[name] && !confirm(`Profil „${name}“ existiert bereits. Überschreiben?`)) return;

        config.profiles[name] = profileSnapshot(config);
        config.activeProfile = name;
        saveConfig();
        fillProfileSelect();
        notifySuccess(`Profil „${name}“ angelegt.`);
    }

    function loadSelectedProfile() {
        const name = String($('#mspProfileSelect').val() || '');
        const profile = config.profiles[name];
        if (!profile) return notifyError('Profil nicht gefunden.');

        const normalized = normalizeConfig({ ...config, ...profile, activeProfile: name, profiles: config.profiles });
        config = normalized;
        saveConfig();
        renderUnits();
        renderCategories();
        syncFormFromConfig();
        bindDynamicAfterProfileReload();
        clearPreview();
        notifySuccess(`Profil „${name}“ geladen.`);
    }

    function bindDynamicAfterProfileReload() {
        $('#mspUnits').off('change.msp input.msp');
        $('#mspUnits').on('change.msp', '.msp-unit-enabled', function () {
            const card = $(this).closest('.msp-unit-card');
            card.toggleClass('msp-disabled', !this.checked);
            readFormIntoConfig();
            updateHeaderSummary();
            clearPreview();
        });
        $('#mspUnits').on('change.msp input.msp', '.msp-reserve', () => {
            readFormIntoConfig();
            clearPreview();
        });
        $('.msp-category').off('change.msp').on('change.msp', function () {
            $(this).closest('.msp-toggle-card').toggleClass('msp-category-off', !this.checked);
            readFormIntoConfig();
            updateHeaderSummary();
            clearPreview();
        });
        updateHeaderSummary();
    }

    function deleteProfile() {
        const name = String($('#mspProfileSelect').val() || '');
        if (!name || !config.profiles[name]) return;
        if (Object.keys(config.profiles).length <= 1) return notifyError('Mindestens ein Profil muss erhalten bleiben.');
        if (!confirm(`Profil „${name}“ wirklich löschen?`)) return;

        delete config.profiles[name];
        config.activeProfile = Object.keys(config.profiles)[0];
        saveConfig();
        fillProfileSelect();
        loadSelectedProfile();
    }

    function resetFormOnly() {
        if (!confirm('Eingaben dieses Profils auf Standardwerte zurücksetzen?')) return;
        const fresh = defaultConfig();
        const keepProfiles = config.profiles;
        const active = config.activeProfile;
        config = normalizeConfig({ ...fresh, profiles: keepProfiles, activeProfile: active });
        saveConfig();
        renderUnits();
        renderCategories();
        syncFormFromConfig();
        bindDynamicAfterProfileReload();
        clearPreview();
    }

    function openSettingsModal() {
        document.getElementById(APP.modalId)?.remove();
        const exportText = JSON.stringify(config, null, 2);

        const modal = $(`
<div id="${APP.modalId}">
    <div class="msp-modal-box">
        <div class="msp-modal-head"><span>Mass Scavenge+ Einstellungen</span><button class="msp-btn msp-btn-danger msp-btn-icon" id="mspModalClose">✕</button></div>
        <div class="msp-modal-body">
            <label style="display:block;margin-bottom:8px;"><input type="checkbox" id="mspRememberPosition" ${config.ui.rememberPosition ? 'checked' : ''}> Fensterposition merken</label>
            <div style="font-weight:bold;margin-bottom:5px;">Konfiguration exportieren / importieren</div>
            <textarea id="mspConfigText">${escapeHtml(exportText)}</textarea>
            <div class="msp-modal-actions">
                <button class="msp-btn msp-btn-secondary" id="mspCopyConfig">In Zwischenablage kopieren</button>
                <button class="msp-btn msp-btn-success" id="mspImportConfig">Konfiguration importieren</button>
                <button class="msp-btn msp-btn-danger" id="mspResetAll">Alles zurücksetzen</button>
            </div>
            <div style="font-size:11px;opacity:.75;margin-top:10px;">Alte Sophie-Einstellungen werden bei der ersten Nutzung automatisch übernommen, sofern noch keine V2-Konfiguration existiert.</div>
</div>
    </div>
</div>`);

        $('body').append(modal);

        const closeSettingsModal = () => {
            $(document).off('keydown.mspModal');
            modal.remove();
        };
        $('#mspModalClose').on('click', closeSettingsModal);
        modal.on('click', e => { if (e.target === modal[0]) closeSettingsModal(); });
        $(document).on('keydown.mspModal', e => { if (e.key === 'Escape') closeSettingsModal(); });

        $('#mspRememberPosition').on('change', function () {
            config.ui.rememberPosition = this.checked;
            if (!this.checked) {
                config.ui.left = null;
                config.ui.top = null;
            }
            saveConfig();
        });

        $('#mspCopyConfig').on('click', async () => {
            try {
                await navigator.clipboard.writeText($('#mspConfigText').val());
                notifySuccess('Konfiguration kopiert.');
            } catch {
                $('#mspConfigText')[0].select();
                document.execCommand('copy');
                notifySuccess('Konfiguration kopiert.');
            }
        });

        $('#mspImportConfig').on('click', () => {
            try {
                const imported = JSON.parse($('#mspConfigText').val());
                config = normalizeConfig(imported);
                saveConfig();
                modal.remove();
                renderApp();
                notifySuccess('Konfiguration importiert.');
            } catch (error) {
                notifyError(`Import fehlgeschlagen: ${error.message}`);
            }
        });

        $('#mspResetAll').on('click', () => {
            if (!confirm('Mass Scavenge+ wirklich vollständig zurücksetzen?')) return;
            localStorage.removeItem(APP.storageKey);
            localStorage.removeItem(APP.villageTypeStorageKey);
            localStorage.removeItem(APP.sessionStorageKey);
            localStorage.removeItem(APP.uiStorageKey);
            uiState = { collapsed: {} };
            lastAnalysis = null;
            sessionHistory = [];
            villageTypeOverrides = {};
            config = defaultConfig();
            saveConfig();
            modal.remove();
            renderApp();
            notifySuccess('Mass Scavenge+ wurde zurückgesetzt.');
        });
    }

    function distributionLabel(value) {
        return value === 'balanced' ? 'Ausgeglichen'
            : value === 'high' ? 'Hohe Kategorien zuerst'
            : 'Egal';
    }

    function currentDistribution() {
        return config.priority === 'high' ? 'high' : 'balanced';
    }

    function updateDistributionPanelTitle() {
        const label = config.priority === 'high' ? 'Hohe Kategorien zuerst' : 'Ausgeglichen';
        $('#mspDistributionSummary').text(`· ${label}`);
    }

    function setDistribution(value) {
        if (!['balanced', 'high'].includes(value)) return;
        config.priority = value;
        $(`input[name="mspPriority"][value="${value}"]`).prop('checked', true);
        saveConfig();
        updateDistributionPanelTitle();
        updateSmartWarning();
        clearPreview();
    }

    function updateSmartWarning() {
        const host = $('#mspSmartWarning');
        if (!host.length) return;

        const rec = activeQuickRecommendation;
        if (!rec || rec.distribution === 'any') {
            host.hide().empty();
            return;
        }

        const current = currentDistribution();
        if (current === rec.distribution) {
            host
                .removeClass('msp-smart-warning')
                .addClass('msp-smart-warning msp-smart-ok')
                .html(`<span class="msp-smart-warning-text">✓ Verteilung passt zu „${escapeHtml(rec.label)}“: <strong>${escapeHtml(distributionLabel(rec.distribution))}</strong>.</span>`)
                .show();
            return;
        }

        host
            .removeClass('msp-smart-ok')
            .addClass('msp-smart-warning')
            .html(`
                <span class="msp-smart-warning-text"><span style="color:#c71f1f;font-size:14px;font-weight:900;">⚠</span> Für „${escapeHtml(rec.label)}“ ist <strong>${escapeHtml(distributionLabel(rec.distribution))}</strong> empfohlen. Aktuell ist <strong>${escapeHtml(distributionLabel(current))}</strong> aktiv.</span>
                <button class="msp-mini-btn" id="mspApplyRecommendedDistribution" type="button">Auf ${escapeHtml(distributionLabel(rec.distribution))} umstellen</button>
                <button class="msp-mini-btn" id="mspIgnoreRecommendedDistribution" type="button">Ignorieren</button>
            `)
            .show();
    }

    function setActiveQuickRecommendation(item) {
        activeQuickRecommendation = item && item.distribution && item.distribution !== 'any'
            ? {
                label: item.label,
                distribution: item.distribution
            }
            : null;
        updateSmartWarning();
    }

    function checkRecommendationBeforeCalculate() {
        const rec = activeQuickRecommendation;
        if (!rec || rec.distribution === 'any') return true;

        const current = currentDistribution();
        if (current === rec.distribution) return true;

        updateSmartWarning();
        const answer = window.confirm(
            `Für „${rec.label}“ ist „${distributionLabel(rec.distribution)}“ empfohlen.\n\n` +
            `Aktuell ist „${distributionLabel(current)}“ aktiv.\n\n` +
            `OK = trotzdem berechnen\nAbbrechen = zuerst Verteilung ändern`
        );
        return answer;
    }

    function quickTypeLabel(type) {
        return {
            hours: '+X Stunden',
            today: 'Heute um',
            tomorrow: 'Morgen um',
            next: 'Nächster Zeitpunkt'
        }[type] || type;
    }

    function renderQuickButtons() {
        const host = $('#mspQuickButtons');
        if (!host.length) return;

        const buttons = Array.isArray(config.quickButtons) ? config.quickButtons : [];
        host.html(buttons.map((item, index) =>
            `<button class="msp-btn msp-btn-secondary msp-quick-preset" type="button" data-index="${index}" title="${escapeHtml(quickTypeLabel(item.type))}: ${escapeHtml(String(item.value))}${item.distribution && item.distribution !== 'any' ? ` · Empfehlung: ${escapeHtml(distributionLabel(item.distribution))}` : ''}">${escapeHtml(item.label)}</button>`
        ).join(' '));
    }

    function quickTargetParts(type, value) {
        serverDateMs = parseServerDate();
        const now = new Date(serverDateMs);

        if (type === 'hours') {
            const hours = Number(value);
            if (!Number.isFinite(hours) || hours <= 0) return null;
            return { mode: 'runtime', hours };
        }

        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) return null;
        const [hour, minute] = String(value).split(':').map(Number);
        const target = new Date(now);
        target.setHours(hour, minute, 0, 0);

        if (type === 'tomorrow') {
            target.setDate(target.getDate() + 1);
        } else if (type === 'next') {
            if (target.getTime() <= serverDateMs) target.setDate(target.getDate() + 1);
        } else if (type === 'today') {
            // "Heute" bedeutet bewusst heute. Liegt die Zeit schon zurück,
            // wird nicht stillschweigend auf morgen gewechselt.
            if (target.getTime() <= serverDateMs) {
                notifyError(`„Heute ${value}“ liegt bereits in der Vergangenheit.`);
                return null;
            }
        }

        return { mode: 'return', parts: dateParts(target) };
    }

    function safetyRuntimeLabel(hours) {
        if (!Number.isFinite(hours)) return '—';
        const totalMinutes = Math.max(0, Math.round(hours * 60));
        const h = Math.floor(totalMinutes / 60);
        const m = totalMinutes % 60;
        return `${h}h ${String(m).padStart(2,'0')}m`;
    }

    function todayTargetForClock(value) {
        const [hour, minute] = String(value || '').split(':').map(Number);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
        const target = new Date(serverDateMs);
        target.setHours(hour, minute, 0, 0);
        return target.getTime() > serverDateMs ? target : null;
    }

    function guardTomorrowAfterMidnight(item, target) {
        if (item?.type !== 'tomorrow' || target?.mode !== 'return') return target;

        const now = new Date(serverDateMs);
        const targetDate = new Date(`${target.parts.date}T${target.parts.time}:00`);
        const hoursAway = (targetDate.getTime() - serverDateMs) / 3600000;

        // Kritischer Alltagsfall: kurz nach Mitternacht wird "morgen" schnell zu ~30h.
        if (now.getHours() < 6 && hoursAway > 18) {
            const todayMs = todayTargetForClock(item.value);
            if (todayMs) {
                const today = new Date(todayMs);
                const todayParts = dateParts(today);
                const todayHours = (todayMs - serverDateMs) / 3600000;

                const useToday = confirm(
                    `⚠ ZEITWARNUNG\n\n` +
                    `Es ist ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')} Uhr.\n` +
                    `„${item.label}“ würde eine Laufzeit von ca. ${safetyRuntimeLabel(hoursAway)} erzeugen.\n\n` +
                    `Meinst du stattdessen HEUTE ${item.value}?\n` +
                    `Das wären ca. ${safetyRuntimeLabel(todayHours)}.\n\n` +
                    `OK = Heute ${item.value}\nAbbrechen = Morgen prüfen`
                );
                if (useToday) return { mode:'return', parts: todayParts };

                const reallyTomorrow = confirm(
                    `⚠ Wirklich MORGEN ${item.value} einstellen?\n\n` +
                    `Die Truppen wären ungefähr ${safetyRuntimeLabel(hoursAway)} unterwegs.\n\n` +
                    `OK = Trotzdem morgen\nAbbrechen = nichts ändern`
                );
                return reallyTomorrow ? target : null;
            }
        }
        return target;
    }

    function safetyLevelForTimes(times) {
        const maxHours = Math.max(Number(times?.off || 0), Number(times?.def || 0));
        if (maxHours >= 20) return 'red';
        if (maxHours >= 12) return 'yellow';
        return 'ok';
    }

    function confirmExtremeRuntime(times, context='Berechnung') {
        const maxHours = Math.max(Number(times?.off || 0), Number(times?.def || 0));
        if (maxHours < 20) return true;
        return confirm(
            `⚠ UNGEWÖHNLICH LANGE LAUFZEIT\n\n` +
            `${context}: Off ${safetyRuntimeLabel(times.off)} · Def ${safetyRuntimeLabel(times.def)}\n\n` +
            `Mindestens eine Laufzeit beträgt 20 Stunden oder mehr.\n` +
            `Bitte prüfe besonders „Heute/Morgen“ und die eingestellte Uhrzeit.\n\n` +
            `Trotzdem fortfahren?`
        );
    }

    function applyQuickPreset(index) {
        const item = config.quickButtons?.[index];
        if (!item) return;

        setActiveQuickRecommendation(item);

        let target = quickTargetParts(item.type, item.value);
        if (!target) return;

        target = guardTomorrowAfterMidnight(item, target);
        if (!target) return;

        if (target.mode === 'runtime') {
            setRuntimeBoth(target.hours);
            return;
        }

        $('input[name="mspTimeMode"][value="return"]').prop('checked', true);
        $('#mspOffDate,#mspDefDate').val(target.parts.date);
        $('#mspOffTime,#mspDefTime').val(target.parts.time);
        readFormIntoConfig();
        updateTimeModeVisibility();
        updateDurationHints();
        updateHeaderSummary();
        updateTopStatus();
        clearPreview();
    }

    function openQuickSettingsModal() {
        $('#mspQuickModal').remove();

        let draftButtons = (config.quickButtons || []).map(item => ({ ...item }));

        const renderEditorRows = () => {
            const grid = $('#mspQuickGrid');
            if (!grid.length) return;

            const rows = draftButtons.map((item, index) => `
                <div class="msp-q-order" style="display:flex;gap:2px;align-items:center;justify-content:center;">
                    <button type="button" class="msp-q-move-up" data-index="${index}" title="Nach oben" ${index === 0 ? 'disabled' : ''}>↑</button>
                    <button type="button" class="msp-q-move-down" data-index="${index}" title="Nach unten" ${index === draftButtons.length - 1 ? 'disabled' : ''}>↓</button>
                </div>
                <input type="text" class="msp-q-label" data-index="${index}" maxlength="24" placeholder="Buttonname" title="Frei wählbarer Buttonname" value="${escapeHtml(item.label)}">
                <select class="msp-q-type" data-index="${index}">
                    <option value="hours" ${item.type === 'hours' ? 'selected' : ''}>+X Stunden</option>
                    <option value="today" ${item.type === 'today' ? 'selected' : ''}>Heute um</option>
                    <option value="tomorrow" ${item.type === 'tomorrow' ? 'selected' : ''}>Morgen um</option>
                    <option value="next" ${item.type === 'next' ? 'selected' : ''}>Nächster Zeitpunkt</option>
                </select>
                <input type="${item.type === 'hours' ? 'number' : 'time'}" class="msp-q-value" data-index="${index}" ${item.type === 'hours' ? 'min="0.1" step="0.1"' : ''} value="${escapeHtml(String(item.value))}">
                <select class="msp-q-distribution" data-index="${index}" title="Empfohlene Verteilung">
                    <option value="any" ${item.distribution === 'any' ? 'selected' : ''}>Egal</option>
                    <option value="balanced" ${item.distribution === 'balanced' ? 'selected' : ''}>Ausgeglichen</option>
                    <option value="high" ${item.distribution === 'high' ? 'selected' : ''}>Hohe Kategorien zuerst</option>
                </select>
                <button type="button" class="msp-q-delete" data-index="${index}" title="Button entfernen">×</button>
            `).join('');

            grid.html(`
                <div class="msp-quick-settings-head">↕</div>
                <div class="msp-quick-settings-head">Buttonname</div>
                <div class="msp-quick-settings-head">Logik</div>
                <div class="msp-quick-settings-head">Wert</div>
                <div class="msp-quick-settings-head">Empfehlung</div>
                <div></div>
                ${rows}
            `);
        };

        const modal = $(`
<div id="mspQuickModal" class="msp-quick-modal-overlay">
    <div class="msp-modal-box" style="max-width:690px;">
        <div class="msp-modal-head">
            <span>Schnellbuttons einstellen</span>
            <button class="msp-btn msp-btn-danger msp-btn-icon" id="mspQuickModalClose">✕</button>
        </div>
        <div class="msp-modal-body">
            <p style="margin-top:0;font-size:11px;">
                <b>Heute</b> bleibt immer heute. <b>Morgen</b> ist immer der nächste Kalendertag.
                <b>Nächster Zeitpunkt</b> nimmt heute, solange die Uhrzeit noch kommt – sonst morgen.<br>
                Mit <b>↑ / ↓</b> bestimmst du die Reihenfolge der Schnellbuttons. Den <b>Buttonnamen</b> kannst du frei vergeben.
            </p>
            <div class="msp-quick-settings-grid" id="mspQuickGrid"></div>
            <div class="msp-q-add-row">
                <button class="msp-btn msp-btn-secondary" id="mspQuickAdd" type="button">+ Button hinzufügen</button>
            </div>
            <div class="msp-modal-actions">
                <button class="msp-btn msp-btn-secondary" id="mspQuickDefaults">Standard</button>
                <button class="msp-btn msp-btn-secondary" id="mspQuickCancel">Abbrechen</button>
                <button class="msp-btn msp-btn-success" id="mspQuickSave">Speichern</button>
            </div>
        </div>
    </div>
</div>`);

        $('body').append(modal);
        renderEditorRows();

        const close = () => {
            $(document).off('keydown.mspQuickModal');
            modal.remove();
        };
        $(document).on('keydown.mspQuickModal', e => {
            if (e.key === 'Escape') close();
        });
        $('#mspQuickModalClose').on('click', close);
        $('#mspQuickCancel').on('click', close);
        modal.on('click', e => { if (e.target === modal[0]) close(); });

        modal.on('input change', '.msp-q-label,.msp-q-value,.msp-q-type,.msp-q-distribution', function () {
            const index = Number($(this).data('index'));
            if (!draftButtons[index]) return;

            if ($(this).hasClass('msp-q-label')) {
                draftButtons[index].label = String($(this).val() || '');
                return;
            }

            if ($(this).hasClass('msp-q-value')) {
                draftButtons[index].value = String($(this).val() || '');
                return;
            }

            if ($(this).hasClass('msp-q-distribution')) {
                draftButtons[index].distribution = String($(this).val() || 'any');
                return;
            }

            if ($(this).hasClass('msp-q-type')) {
                const type = String($(this).val());
                draftButtons[index].type = type;
                draftButtons[index].value = type === 'hours' ? '3' : '22:30';
                renderEditorRows();
            }
        });

        modal.on('click', '.msp-q-move-up,.msp-q-move-down', function () {
            const index = Number($(this).data('index'));
            if (!Number.isInteger(index) || !draftButtons[index]) return;
            const direction = $(this).hasClass('msp-q-move-up') ? -1 : 1;
            const target = index + direction;
            if (target < 0 || target >= draftButtons.length) return;
            [draftButtons[index], draftButtons[target]] = [draftButtons[target], draftButtons[index]];
            renderEditorRows();
        });

        modal.on('click', '.msp-q-delete', function () {
            const index = Number($(this).data('index'));
            if (!Number.isInteger(index) || !draftButtons[index]) return;
            draftButtons.splice(index, 1);
            renderEditorRows();
        });

        $('#mspQuickAdd').on('click', function () {
            if (draftButtons.length >= 12) {
                notifyError('Maximal 12 Schnellbuttons sind möglich.');
                return;
            }
            draftButtons.push({
                label: '+3h',
                type: 'hours',
                value: '3',
                distribution: 'any'
            });
            renderEditorRows();
        });

        $('#mspQuickDefaults').on('click', function () {
            draftButtons = [
                { label: '+1h', type: 'hours', value: '1', distribution: 'any' },
                { label: '+2h', type: 'hours', value: '2', distribution: 'any' },
                { label: '+3h', type: 'hours', value: '3', distribution: 'high' },
                { label: '+4h', type: 'hours', value: '4', distribution: 'any' },
                { label: '+6h', type: 'hours', value: '6', distribution: 'any' },
                { label: '+8h', type: 'hours', value: '8', distribution: 'any' },
                { label: 'Heute 22:30', type: 'today', value: '22:30', distribution: 'any' },
                { label: 'Heute 23:00', type: 'today', value: '23:00', distribution: 'any' },
                { label: 'Morgen 07:00', type: 'tomorrow', value: '07:00', distribution: 'balanced' },
                { label: 'Morgen 09:00', type: 'tomorrow', value: '09:00', distribution: 'balanced' },
                { label: 'Nächster 22:30', type: 'next', value: '22:30', distribution: 'any' }
            ];
            renderEditorRows();
        });

        $('#mspQuickSave').on('click', function () {
            // v1.3.6: sichtbare Werte vor dem Speichern explizit übernehmen,
            // damit insbesondere frei umbenannte Buttonnamen sicher erhalten bleiben.
            draftButtons.forEach((item, index) => {
                const label = String($(`.msp-q-label[data-index="${index}"]`).val() || '').trim();
                const type = String($(`.msp-q-type[data-index="${index}"]`).val() || item.type || 'hours');
                const value = String($(`.msp-q-value[data-index="${index}"]`).val() || item.value || '');
                const distribution = String($(`.msp-q-distribution[data-index="${index}"]`).val() || item.distribution || 'any');
                draftButtons[index] = {
                    ...item,
                    label: label || item.label || (type === 'hours' ? '+1h' : 'Zeit'),
                    type,
                    value,
                    distribution
                };
            });
            const result = [];

            for (let index = 0; index < draftButtons.length; index++) {
                const item = draftButtons[index];
                const label = String(item.label || '').trim();
                const type = String(item.type || '');
                const value = String(item.value || '').trim();
                const distribution = ['any', 'balanced', 'high'].includes(item.distribution)
                    ? item.distribution
                    : 'any';

                if (!label) return notifyError(`Schnellbutton ${index + 1}: Bitte eine Anzeige eingeben.`);
                if (!['hours', 'today', 'tomorrow', 'next'].includes(type)) {
                    return notifyError(`Schnellbutton ${index + 1}: Ungültige Logik.`);
                }

                if (type === 'hours') {
                    const hours = Number(value);
                    if (!Number.isFinite(hours) || hours <= 0) {
                        return notifyError(`Schnellbutton ${index + 1}: Ungültige Stundenanzahl.`);
                    }
                } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
                    return notifyError(`Schnellbutton ${index + 1}: Ungültige Uhrzeit.`);
                }

                result.push({ label: label.slice(0, 24), type, value, distribution });
            }

            config.quickButtons = result;
            saveConfig();
            renderQuickButtons();
            updateAutomateDeadlineBadge();
            close();
            notifySuccess('Schnellbuttons gespeichert.');
        });
    }

    function loadUiState() {
        try {
            const raw = JSON.parse(localStorage.getItem(APP.uiStorageKey) || '{}');
            const state = {
                collapsed: raw && typeof raw.collapsed === 'object' ? raw.collapsed : {},
                compactDefaultsVersion: Number(raw?.compactDefaultsVersion || 0)
            };

            // v2.7.1: einmalig die neue Compact-UI-Ausgangslage setzen.
            if (state.compactDefaultsVersion < 271) {
                state.collapsed = {
                    ...(state.collapsed || {}),
                    mspTroopsPanel: true,
                    mspCategoriesPanel: true,
                    mspVillagesPanel: true,
                    mspAnalysisPanel: true
                };
                state.compactDefaultsVersion = 271;
                localStorage.setItem(APP.uiStorageKey, JSON.stringify(state));
            }

            return state;
        } catch {
            const state = {
                collapsed: {
                    mspTroopsPanel: true,
                    mspCategoriesPanel: true,
                    mspVillagesPanel: true,
                    mspAnalysisPanel: true
                },
                compactDefaultsVersion: 271
            };
            localStorage.setItem(APP.uiStorageKey, JSON.stringify(state));
            return state;
        }
    }

    function saveUiState() {
        uiState.compactDefaultsVersion = 271;
        localStorage.setItem(APP.uiStorageKey, JSON.stringify(uiState));
    }

    function panelKey(panel, index) {
        return panel.attr('id') || `panel-${index}`;
    }

    function prepareCollapsiblePanels() {
        const defaultCollapsed = new Set(['mspTroopsPanel','mspCategoriesPanel','mspVillagesPanel','mspAnalysisPanel']);
        const alwaysOpen = new Set(['mspTimePanel','mspCalculatePanel']);

        $(`#${APP.id} .msp-panel`).each(function(index) {
            const panel=$(this), title=panel.children('.msp-panel-title').first(), content=panel.children('.msp-panel-content').first();
            if(!title.length||!content.length) return;
            const key=panelKey(panel,index);

            if(alwaysOpen.has(key)){
                panel.removeClass('msp-collapsed');
                title.css('cursor','default').removeAttr('title');
                return;
            }

            if(title.data('msp-collapse-ready')) return;
            title.data('msp-collapse-ready',true);
            const original=title.html();
            title.html(`<span class="msp-panel-title-main">${original}</span><span class="msp-collapse-icon">▼</span>`);
            title.attr('title','Bereich ein-/ausklappen');

            const saved=Object.prototype.hasOwnProperty.call(uiState.collapsed||{},key);
            panel.toggleClass('msp-collapsed',saved?Boolean(uiState.collapsed[key]):defaultCollapsed.has(key));

            title.on('click',function(event){
                if($(event.target).is('button,input,select,a,label')) return;
                panel.toggleClass('msp-collapsed');
                uiState.collapsed[key]=panel.hasClass('msp-collapsed');
                saveUiState();
            });
        });
    }

    function activeCategoryCount() {
        return [0,1,2,3].filter(i => Boolean(config.categories?.[i])).length;
    }

    function getStatusReturnText() {
        if (config.timeMode === 'runtime') {
            return `Laufzeit Off ${Number(config.runtime?.off || 0)}h · Def ${Number(config.runtime?.def || 0)}h`;
        }
        const off = config.returnTime?.off?.time || '—';
        const def = config.returnTime?.def?.time || '—';
        return off === def ? `Rückkehr ${off}` : `Off ${off} · Def ${def}`;
    }

    function updateTopStatus() {
        if (!$('#mspTopStatus').length) return;

        const enabledUnits = config.unitOrder.filter(unit => config.unitEnabled[unit]).length;
        $('#mspStatusTroops').text(`${enabledUnits} Truppen`);
        $('#mspStatusCategories').text('Kategorien: automatisch');

        if (currentScavengeInfo.length) {
            const selected = villageSelectionInitialized
                ? currentScavengeInfo.filter(v => villageSelection.has(String(v.village_id))).length
                : currentScavengeInfo.length;
            const usable = currentScavengeInfo.filter(v => freeCategoryCount(v) > 0).length;
            $('#mspStatusVillages').text(`Dörfer: ${selected}/${currentScavengeInfo.length} · ${usable} nutzbar`);
        } else {
            $('#mspStatusVillages').text('Dörfer: noch nicht geladen');
        }

        if (config.timeMode === 'runtime') {
            const off = Number(config.runtimeHours?.off ?? config.offRuntime ?? 0);
            const def = Number(config.runtimeHours?.def ?? config.defRuntime ?? 0);
            const fmt = value => {
                if (!Number.isFinite(value) || value <= 0) return '—';
                return `${value.toFixed(value % 1 ? 1 : 0)}h`;
            };
            $('#mspStatusReturn').text(
                Math.abs(off - def) < 0.001
                    ? `Laufzeit: ${fmt(off)}`
                    : `Laufzeit: Off ${fmt(off)} · Def ${fmt(def)}`
            );
            return;
        }

        const base = getStatusReturnText();
        let duration = '';
        try {
            const times = getEffectiveTimes();
            if (Number.isFinite(times.off) && Number.isFinite(times.def) && Math.abs(times.off - times.def) < 0.01) {
                duration = ` (${formatDuration(Math.max(0, times.off) * 3600)})`;
            }
        } catch {}

        // getStatusReturnText liefert bereits "Rückkehr: ...".
        $('#mspStatusReturn').text(`${base}${duration}`);
    }

    function getSafeTopOffset() {
        // Desktop-Stämme: die rote Hauptleiste endet ca. 48px unterhalb
        // des Seiten-Viewports. Mit 4px Abstand sitzt Mass Scavenge+
        // direkt darunter.
        return 52;
    }

    function keepWindowBelowGameNavigation() {
        const app = document.getElementById(APP.id);
        if (!app) return;

        const safeTop = getSafeTopOffset();
        const safeBottom = 38;
        app.style.setProperty('--msp-safe-top', `${safeTop}px`);
        app.style.setProperty('--msp-safe-bottom', `${safeBottom}px`);

        const rect = app.getBoundingClientRect();
        if (rect.top < safeTop) {
            const currentTop = parseFloat(app.style.top);
            if (Number.isFinite(currentTop)) {
                app.style.top = `${currentTop + (safeTop - rect.top)}px`;
            } else {
                app.style.top = `${safeTop}px`;
                app.style.bottom = 'auto';
                app.style.transform = 'none';
            }
        }

        const updated = app.getBoundingClientRect();
        const maxTop = Math.max(safeTop, window.innerHeight - 70);
        if (updated.top > maxTop) {
            app.style.top = `${maxTop}px`;
            app.style.bottom = 'auto';
        }
    }

    function placeWindowDirectlyBelowHeader() {
        const app = document.getElementById(APP.id);
        if (!app) return;

        const safeTop = getSafeTopOffset();
        const safeBottom = 38;
        app.style.setProperty('--msp-safe-top', `${safeTop}px`);
        app.style.setProperty('--msp-safe-bottom', `${safeBottom}px`);
        app.style.top = `${safeTop}px`;
        app.style.bottom = 'auto';
        app.style.transform = 'none';
    }

    function isMobileLayout() {
        return window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
    }

    function mobileTopBoundary() {
        // Genug Abstand unter der mobilen Stämme-Kopfzeile.
        return 118;
    }

    function releaseMobileStatusBar() {
        if (!isMobileLayout()) return;
        const bar = document.getElementById('mspTopStatus');
        if (!bar) return;

        bar.style.removeProperty('position');
        bar.style.removeProperty('top');
        bar.style.removeProperty('bottom');
        bar.style.removeProperty('left');
        bar.style.removeProperty('right');
        bar.style.removeProperty('z-index');
        bar.style.removeProperty('transform');
        bar.style.removeProperty('inset');
    }

    function applyMobileWindowLayout() {
        const app = document.getElementById(APP.id);
        if (!app) return;

        if (!isMobileLayout()) return;

        app.style.left = '6px';
        app.style.right = '6px';
        app.style.width = 'auto';
        app.style.maxWidth = 'none';
        app.style.transform = 'none';

        const currentTop = parseFloat(app.style.top);
        const minTop = mobileTopBoundary();
        if (!Number.isFinite(currentTop) || currentTop < minTop) {
            app.style.top = `${minTop}px`;
        }

        app.style.bottom = 'auto';
        releaseMobileStatusBar();
    }

    function bindMobileDrag() {
        const app = document.getElementById(APP.id);
        const header = app?.querySelector('.msp-header');
        if (!app || !header || !isMobileLayout()) return;
        if (header.dataset.mspTouchDrag === '1') return;
        header.dataset.mspTouchDrag = '1';

        let dragging = false;
        let pointerId = null;
        let startY = 0;
        let startTop = 0;

        const endDrag = () => {
            if (!dragging) return;
            dragging = false;
            pointerId = null;
            app.classList.remove('msp-mobile-dragging');

            const top = parseFloat(app.style.top);
            if (Number.isFinite(top)) {
                config.ui.top = top;
                saveConfig();
            }
        };

        header.addEventListener('pointerdown', event => {
            if (!isMobileLayout()) return;
            if (event.target.closest('button,input,select,a')) return;

            dragging = true;
            pointerId = event.pointerId;
            startY = event.clientY;
            startTop = app.getBoundingClientRect().top;
            app.classList.add('msp-mobile-dragging');

            try { header.setPointerCapture(pointerId); } catch {}
            event.preventDefault();
        }, { passive: false });

        header.addEventListener('pointermove', event => {
            if (!dragging || event.pointerId !== pointerId) return;

            const deltaY = event.clientY - startY;
            const minTop = mobileTopBoundary();
            const maxTop = Math.max(minTop, window.innerHeight - 150);
            const nextTop = Math.min(maxTop, Math.max(minTop, startTop + deltaY));

            app.style.top = `${nextTop}px`;
            app.style.bottom = 'auto';
            event.preventDefault();
        }, { passive: false });

        header.addEventListener('pointerup', endDrag);
        header.addEventListener('pointercancel', endDrag);
        header.addEventListener('lostpointercapture', endDrag);
    }

    function startSafePositionGuard() {
        if (isMobileLayout()) {
            applyMobileWindowLayout();
            bindMobileDrag();
        } else {
            placeWindowDirectlyBelowHeader();
            keepWindowBelowGameNavigation();
        }

        let resizeTimer = null;
        $(window).on('resize.mspSafePosition orientationchange.mspSafePosition', function() {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (isMobileLayout()) {
                    applyMobileWindowLayout();
                    bindMobileDrag();
                } else {
                    keepWindowBelowGameNavigation();
                }
            }, 80);
        });

        setTimeout(() => {
            if (isMobileLayout()) {
                applyMobileWindowLayout();
                bindMobileDrag();
            } else {
                placeWindowDirectlyBelowHeader();
                keepWindowBelowGameNavigation();
            }
        }, 250);

        setTimeout(() => {
            if (isMobileLayout()) {
                applyMobileWindowLayout();
                bindMobileDrag();
            } else {
                placeWindowDirectlyBelowHeader();
                keepWindowBelowGameNavigation();
            }
        }, 1000);
    }

    function bindUiComfortEvents() {
        $('#mspScrollTop').on('click', function() {
            $(`#${APP.id} .msp-body`).stop(true).animate({ scrollTop: 0 }, 180);
        });

        $(`#${APP.id}`).on('change input', 'input,select', function() {
            window.setTimeout(updateTopStatus, 0);
        });

        $(document).on('mouseup.mspSafePosition touchend.mspSafePosition', function() {
            if (!isMobileLayout()) {
                window.setTimeout(keepWindowBelowGameNavigation, 0);
            }
        });
    }

    function createAnalysisCounters() {
        return {
            villagesLoaded: 0,
            villagesSelected: 0,
            villagesUsed: 0,
            villagesNoRallyPoint: 0,
            villagesNoFreeCategory: 0,
            villagesNoTroops: 0,
            villagesOtherUnused: 0,
            totalHomeUnits: 0,
            totalReservedUnits: 0,
            totalAvailableUnits: 0,
            totalSentUnits: 0,
            totalSquads: 0,
            categories: {
                1: { squads: 0, units: 0 },
                2: { squads: 0, units: 0 },
                3: { squads: 0, units: 0 },
                4: { squads: 0, units: 0 }
            },
            units: {}
        };
    }

    function analyzeVillageBeforeCalculation(village, counters) {
        if (!village?.has_rally_point) {
            counters.villagesNoRallyPoint++;
            return;
        }

        const activeFreeCats = [1,2,3,4].filter(i => {
            const option = village?.options?.[i];
            return option && !option.is_locked && option.scavenging_squad == null && config.categories?.[i - 1];
        }).length;
        if (activeFreeCats === 0) counters.villagesNoFreeCategory++;

        let home = 0;
        let reserved = 0;
        let available = 0;

        for (const unit of config.unitOrder || []) {
            if (!config.unitEnabled?.[unit]) continue;
            const homeCount = safeInt(village?.unit_counts_home?.[unit], 0, 0);
            const reserve = safeInt(config.reserve?.[unit], 0, 0);
            home += homeCount;
            reserved += Math.min(homeCount, reserve);
            available += Math.max(0, homeCount - reserve);
        }

        counters.totalHomeUnits += home;
        counters.totalReservedUnits += reserved;
        counters.totalAvailableUnits += available;
        if (available <= 0) counters.villagesNoTroops++;
    }

    function finishAnalysisFromRequests(counters, requests) {
        const usedVillages = new Set();

        for (const request of requests || []) {
            usedVillages.add(String(request?.village_id ?? ''));
            const category = safeInt(request?.option_id, 0, 0);
            if (counters.categories[category]) counters.categories[category].squads++;

            const counts = request?.candidate_squad?.unit_counts || {};
            for (const [unit, raw] of Object.entries(counts)) {
                const amount = safeInt(raw, 0, 0);
                if (amount <= 0) continue;
                counters.totalSentUnits += amount;
                counters.units[unit] = (counters.units[unit] || 0) + amount;
                if (counters.categories[category]) counters.categories[category].units += amount;
            }
        }

        counters.totalSquads = (requests || []).length;
        counters.villagesUsed = usedVillages.size;
        counters.villagesOtherUnused = Math.max(
            0,
            counters.villagesSelected
                - counters.villagesUsed
                - counters.villagesNoRallyPoint
                - counters.villagesNoFreeCategory
                - counters.villagesNoTroops
        );

        lastAnalysis = counters;
        renderAnalysis(counters);
        $('#mspAnalysisContent .msp-analysis-stale').remove();
    }

    function analysisWarnings(counters) {
        const warnings = [];
        const enabledUnits = (config.unitOrder || []).filter(unit => config.unitEnabled?.[unit]).length;
        const enabledCategories = [0,1,2,3].filter(i => config.categories?.[i]).length;

        if (!enabledUnits) warnings.push({ type:'error', text:'Kein Truppentyp ist aktiviert.' });
        if (!enabledCategories) warnings.push({ type:'error', text:'Keine Sammelkategorie ist aktiviert.' });

        if (counters.villagesNoFreeCategory > 0) {
            warnings.push({ type:'warn', text:`${counters.villagesNoFreeCategory} ausgewählte Dörfer haben aktuell keine freie aktivierte Sammelkategorie.` });
        }
        if (counters.villagesNoTroops > 0) {
            warnings.push({ type:'warn', text:`${counters.villagesNoTroops} Dörfer haben nach Abzug deiner Reserve keine nutzbaren Truppen.` });
        }
        if (counters.totalAvailableUnits > 0 && counters.totalSentUnits === 0) {
            warnings.push({ type:'error', text:'Es sind Truppen verfügbar, aber es wurde kein Sammelauftrag erzeugt. Prüfe Laufzeit, Kategorien und Reserven.' });
        }

        const usage = counters.totalAvailableUnits > 0 ? counters.totalSentUnits / counters.totalAvailableUnits : 0;
        if (usage > 0 && usage < 0.15) {
            warnings.push({ type:'warn', text:'Weniger als 15 % der verfügbaren Truppen werden eingeplant. Ursache kann eine kurze Laufzeit, hohe Reserve oder wenige freie Kategorien sein.' });
        }

        if (!warnings.length) warnings.push({ type:'good', text:'Keine auffälligen Einstellungen erkannt.' });
        return warnings;
    }

    function renderAnalysis(counters) {
        const box = $('#mspAnalysisContent');
        if (!box.length) return;

        const available = counters.totalAvailableUnits || 0;
        const sent = counters.totalSentUnits || 0;
        const usage = available > 0 ? (sent / available * 100) : 0;
        const reserveShare = counters.totalHomeUnits > 0
            ? (counters.totalReservedUnits / counters.totalHomeUnits * 100)
            : 0;

        const warnings = analysisWarnings(counters).map(item => {
            const cls = item.type === 'error' ? 'msp-analysis-error' : item.type === 'good' ? 'msp-analysis-good' : '';
            return `<div class="msp-analysis-warning ${cls}">${escapeHtml(item.text)}</div>`;
        }).join('');

        const reasonRows = [
            ['Ohne Versammlungsplatz', counters.villagesNoRallyPoint],
            ['Keine freie aktive Kategorie', counters.villagesNoFreeCategory],
            ['Keine Truppen nach Reserve', counters.villagesNoTroops],
            ['Sonst nicht genutzt', counters.villagesOtherUnused]
        ].filter(([,value]) => value > 0);

        const reasons = reasonRows.length
            ? reasonRows.map(([label,value]) => `<div class="msp-analysis-reason"><span>${escapeHtml(label)}</span><b>${formatNumber(value)}</b></div>`).join('')
            : '<div class="msp-analysis-reason"><span>Keine ausgelassenen Dörfer erkannt</span><b>✓</b></div>';

        const categoryRows = [1,2,3,4].map(i => {
            const entry = counters.categories[i];
            return `<tr><td>Kategorie ${i}</td><td>${formatNumber(entry.squads)}</td><td>${formatNumber(entry.units)}</td></tr>`;
        }).join('');

        const unitRows = (config.unitOrder || [])
            .filter(unit => (counters.units[unit] || 0) > 0)
            .map(unit => `<tr><td>${escapeHtml(UNIT_META[unit]?.label || unit)}</td><td>${formatNumber(counters.units[unit])}</td></tr>`)
            .join('');

        box.html(`
            <div class="msp-analysis-grid">
                <div class="msp-analysis-card"><b>${formatNumber(counters.villagesSelected)}</b><span>Dörfer ausgewählt</span></div>
                <div class="msp-analysis-card"><b>${formatNumber(counters.villagesUsed)}</b><span>Dörfer genutzt</span></div>
                <div class="msp-analysis-card"><b>${formatNumber(counters.totalSquads)}</b><span>Sammelaufträge</span></div>
                <div class="msp-analysis-card"><b>${formatNumber(available)}</b><span>Truppen verfügbar</span></div>
                <div class="msp-analysis-card"><b>${formatNumber(sent)}</b><span>Truppen eingeplant</span></div>
                <div class="msp-analysis-card"><b>${usage.toFixed(1)} %</b><span>Nutzung verfügbarer Truppen</span></div>
            </div>

            ${warnings}

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
                <div class="msp-analysis-card">
                    <b>Warum Dörfer ausgelassen wurden</b>
                    <div style="margin-top:5px;">${reasons}</div>
                </div>
                <div class="msp-analysis-card">
                    <b>Reserve-Effekt</b>
                    <div class="msp-analysis-reason"><span>Truppen zu Hause</span><b>${formatNumber(counters.totalHomeUnits)}</b></div>
                    <div class="msp-analysis-reason"><span>Davon Reserve</span><b>${formatNumber(counters.totalReservedUnits)} (${reserveShare.toFixed(1)} %)</b></div>
                    <div class="msp-analysis-reason"><span>Danach verfügbar</span><b>${formatNumber(available)}</b></div>
                </div>
            </div>

            <table class="msp-analysis-table">
                <thead><tr><th>Kategorie</th><th>Aufträge</th><th>Truppen</th></tr></thead>
                <tbody>${categoryRows}</tbody>
            </table>

            ${unitRows ? `<table class="msp-analysis-table">
                <thead><tr><th>Truppentyp</th><th>Eingeplant</th></tr></thead>
                <tbody>${unitRows}</tbody>
            </table>` : ''}
        `);
    }

    function loadSessionHistory() {
        try {
            const raw = JSON.parse(localStorage.getItem(APP.sessionStorageKey) || '[]');
            if (!Array.isArray(raw)) return [];
            return raw
                .filter(item => item && Number.isFinite(Number(item.returnAt)))
                .map(item => ({
                    id: String(item.id || `${Date.now()}-${Math.random()}`),
                    runId: String(item.runId || item.id || `${Date.now()}-${Math.random()}`),
                    createdAt: Number(item.createdAt || Date.now()),
                    returnAt: Number(item.returnAt),
                    returnOffAt: Number(item.returnOffAt || item.returnAt),
                    returnDefAt: Number(item.returnDefAt || item.returnAt),
                    groups: safeInt(item.groups, 1, 1),
                    squads: safeInt(item.squads, 0, 0),
                    villages: safeInt(item.villages, 0, 0),
                    villageIds: Array.isArray(item.villageIds) ? item.villageIds.map(String) : [],
                    units: item.units && typeof item.units === 'object' ? item.units : {},
                    label: typeof item.label === 'string' ? item.label : 'Sammelrunde'
                }))
                .sort((a, b) => a.createdAt - b.createdAt)
                .slice(-50);
        } catch {
            return [];
        }
    }

    function saveSessionHistory() {
        localStorage.setItem(APP.sessionStorageKey, JSON.stringify(sessionHistory.slice(-50)));
    }

    function formatSessionDateTime(ms) {
        const d = new Date(Number(ms));
        if (Number.isNaN(d.getTime())) return '—';
        return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    }

    function formatCountdown(ms) {
        const diff = Number(ms) - Date.now();
        if (diff <= 0) return 'erledigt';
        const total = Math.floor(diff / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const sec = total % 60;
        return h > 0 ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m ${String(sec).padStart(2,'0')}s`;
    }

    function renderSessionHistory() {
        const list = $('#mspSessionList');
        if (!list.length) return;

        const now = Date.now();
        const active = sessionHistory
            .filter(item => Number(item.returnAt) > now)
            .sort((a,b) => a.returnAt - b.returnAt);

        if (active.length) {
            const next = active[0];
            $('#mspNextReturnChip')
                .addClass('msp-next-return')
                .text(`Nächste Rückkehr: ${formatCountdown(next.returnAt)} · ${formatSessionDateTime(next.returnAt)}`);
            $('#mspStatusReturn').text(`Nächste Rückkehr: ${formatCountdown(next.returnAt)} · ${formatSessionDateTime(next.returnAt).split(' ').pop()}`);
        } else {
            $('#mspNextReturnChip').removeClass('msp-next-return').text('Keine aktive Rückkehr');
            updateTopStatus();
        }

        if (!sessionHistory.length) {
            list.html('<div class="msp-session-empty">Noch keine gesendeten Sammelrunden gespeichert.</div>');
            return;
        }

        const html = sessionHistory
            .slice()
            .sort((a,b) => b.createdAt - a.createdAt)
            .map(item => {
                const done = Number(item.returnAt) <= now;
                const units = (config.unitOrder || [])
                    .filter(unit => safeInt(item.units?.[unit], 0, 0) > 0)
                    .map(unit => `${UNIT_META[unit]?.label || unit}: ${formatNumber(safeInt(item.units[unit], 0, 0))}`)
                    .join(' · ');

                return `<div class="msp-session-card ${done ? 'msp-session-done' : ''}">
                    <div class="msp-session-head">
                        <div>
                            <div class="msp-session-title">${escapeHtml(item.label)}</div>
                            <div style="font-size:10px;">Gesendet ${formatSessionDateTime(item.createdAt)}</div>
                        </div>
                        <span class="msp-session-status">${done ? 'Erledigt' : formatCountdown(item.returnAt)}</span>
                    </div>
                    <div class="msp-session-body">
                        <div class="msp-session-stat"><b>${formatNumber(item.villages)}</b><span>Dörfer</span></div>
                        <div class="msp-session-stat"><b>${formatNumber(item.squads)}</b><span>Sammelaufträge</span></div>
                        <div class="msp-session-stat"><b>${formatNumber(item.groups)}</b><span>Versandgruppen</span></div>
                        <div class="msp-session-stat"><b>${formatSessionDateTime(item.returnAt).split(' ').pop()}</b><span>späteste Rückkehr</span></div>
                    </div>
                    <div class="msp-session-units">
                        <b>Rückkehr:</b> Off ${formatSessionDateTime(item.returnOffAt)} · Def ${formatSessionDateTime(item.returnDefAt)}
                        ${units ? `<br><b>Truppen:</b> ${escapeHtml(units)}` : ''}
                    </div>
                </div>`;
            })
            .join('');

        list.html(html);
    }

    function startSessionTicker() {
        if (sessionTicker) clearInterval(sessionTicker);
        renderSessionHistory();
        sessionTicker = setInterval(renderSessionHistory, 1000);
    }

    function groupUnitTotals(group) {
        const totals = {};
        for (const request of group || []) {
            const counts = request?.candidate_squad?.unit_counts || {};
            for (const [unit, value] of Object.entries(counts)) {
                totals[unit] = (totals[unit] || 0) + safeInt(value, 0, 0);
            }
        }
        return totals;
    }

    function recordSentGroup(groupIndex, group) {
        if (!currentPreview || !Array.isArray(group) || !group.length) return;

        if (!currentRunId) {
            currentRunId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        }

        const stats = groupStats(group);
        const returnOffAt = serverDateMs + Number(currentPreview.times?.off || 0) * 3600000;
        const returnDefAt = serverDateMs + Number(currentPreview.times?.def || 0) * 3600000;
        const returnAt = Math.max(returnOffAt, returnDefAt);
        const units = groupUnitTotals(group);
        const villageIds = new Set(
            group.map(request => String(request?.village_id ?? '')).filter(Boolean)
        );

        let session = sessionHistory.find(item => item.runId === currentRunId);

        if (!session) {
            session = {
                id: currentRunId,
                runId: currentRunId,
                createdAt: Date.now(),
                returnAt,
                returnOffAt,
                returnDefAt,
                groups: 0,
                squads: 0,
                villages: 0,
                villageIds: [],
                units: {},
                label: `${config.activeProfile || 'Standard'} · Sammelrunde`
            };
            sessionHistory.push(session);
        }

        session.groups += 1;
        session.squads += group.length;
        session.returnAt = Math.max(Number(session.returnAt || 0), returnAt);
        session.returnOffAt = Math.max(Number(session.returnOffAt || 0), returnOffAt);
        session.returnDefAt = Math.max(Number(session.returnDefAt || 0), returnDefAt);

        const mergedVillageIds = new Set([
            ...(Array.isArray(session.villageIds) ? session.villageIds.map(String) : []),
            ...villageIds
        ]);
        session.villageIds = [...mergedVillageIds];
        session.villages = session.villageIds.length || Math.max(session.villages || 0, stats.villages || 0);

        for (const [unit, value] of Object.entries(units)) {
            session.units[unit] = safeInt(session.units?.[unit], 0, 0) + safeInt(value, 0, 0);
        }

        sessionHistory = sessionHistory.slice(-50);
        saveSessionHistory();
        renderSessionHistory();
    }

    function loadVillageTypeOverrides() {
        try {
            const raw = JSON.parse(localStorage.getItem(APP.villageTypeStorageKey) || '{}');
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
            const clean = {};
            for (const [id, value] of Object.entries(raw)) {
                if (['off', 'def', 'mix'].includes(value)) clean[String(id)] = value;
            }
            return clean;
        } catch {
            return {};
        }
    }

    function saveVillageTypeOverrides() {
        localStorage.setItem(APP.villageTypeStorageKey, JSON.stringify(villageTypeOverrides));
    }

    function freeCategoryCount(data) {
        return [1, 2, 3, 4].filter(i => {
            const option = data?.options?.[i];
            return option && !option.is_locked && option.scavenging_squad == null;
        }).length;
    }

    function automaticVillageType(data) {
        let off = 0, def = 0;
        for (const unit of config.unitOrder) {
            if (!config.unitEnabled[unit]) continue;
            const amount = Math.max(0, safeInt(data?.unit_counts_home?.[unit], 0, 0) - safeInt(config.reserve[unit], 0, 0));
            const type = UNIT_META[unit]?.type;
            if (type === 'off') off += amount;
            if (type === 'def') def += amount;
        }
        if (off > def * 1.15) return 'off';
        if (def > off * 1.15) return 'def';
        return 'mix';
    }

    function villageType(data) {
        const id = String(data?.village_id ?? '');
        const override = villageTypeOverrides[id];
        return ['off', 'def', 'mix'].includes(override) ? override : automaticVillageType(data);
    }

    function villageCoords(data) {
        const name = String(data?.village_name || '');
        const match = name.match(/\b(\d{3}\|\d{3})\b/);
        return match ? match[1] : '';
    }

    function villageMatchesFilter(data) {
        const q = String($('#mspVillageSearch').val() || '').trim().toLowerCase();
        const typeFilter = String($('#mspVillageTypeFilter').val() || 'all');
        const onlyUsable = $('#mspOnlyUsableVillages').is(':checked');
        const type = villageType(data);
        if (typeFilter !== 'all' && type !== typeFilter) return false;
        if (onlyUsable && freeCategoryCount(data) === 0) return false;
        if (!q) return true;
        return `${data?.village_name || ''} ${villageCoords(data)}`.toLowerCase().includes(q);
    }

    async function loadVillagesForSelection() {
        const btn = $('#mspLoadVillagesBtn');
        btn.prop('disabled', true).text('Dörfer werden geladen …');
        try {
            readFormIntoConfig();
            currentScavengeInfo = await loadAllVillagePages();
            if (!villageSelectionInitialized) {
                villageSelection = new Set(currentScavengeInfo.map(v => String(v.village_id)));
                villageSelectionInitialized = true;
            } else {
                const valid = new Set(currentScavengeInfo.map(v => String(v.village_id)));
                villageSelection = new Set([...villageSelection].filter(id => valid.has(id)));
            }
            if ($('#mspAutoDeselectBlocked').is(':checked')) {
                currentScavengeInfo
                    .filter(v => freeCategoryCount(v) === 0)
                    .forEach(v => villageSelection.delete(String(v.village_id)));
            }
            $('#mspVillageSearch,#mspVillageTypeFilter,#mspOnlyUsableVillages,#mspAutoDeselectBlocked,#mspVillagesAll,#mspVillagesNone,#mspVillagesVisible,#mspVillagesVisibleNone').prop('disabled', false);
            $('#mspVillageList').show();
            renderVillageSelection();
            setProgress(100, `${formatNumber(currentScavengeInfo.length)} Dörfer für die Auswahl geladen.`);
        } catch (error) {
            console.error('[MassScavenge+] Dorfwahl konnte nicht geladen werden:', error);
            notifyError(`Dörfer konnten nicht geladen werden: ${error.message}`);
        } finally {
            btn.prop('disabled', false).text('Dörfer neu laden');
        }
    }

    function renderVillageSelection() {
        if (!currentScavengeInfo.length) return;
        const visible = currentScavengeInfo.filter(villageMatchesFilter);
        const html = visible.map(v => {
            const id = String(v.village_id);
            const checked = villageSelection.has(id);
            const type = villageType(v);
            const autoType = automaticVillageType(v);
            const override = villageTypeOverrides[id] || 'auto';
            const typeLabel = type === 'off' ? 'Off' : type === 'def' ? 'Def' : 'Gemischt';
            const autoLabel = autoType === 'off' ? 'Off' : autoType === 'def' ? 'Def' : 'Gemischt';
            const freeCats = freeCategoryCount(v);
            const unavailable = freeCats === 0;
            const rowClasses = [
                checked ? '' : 'msp-village-off',
                unavailable ? 'msp-village-unavailable' : ''
            ].filter(Boolean).join(' ');
            return `<div class="msp-village-row ${rowClasses}" data-village-row="${id}">
                <input type="checkbox" class="msp-village-check" data-village="${id}" ${checked ? 'checked' : ''}>
                <span class="msp-village-name" title="${escapeHtml(v.village_name || `Dorf ${id}`)}">${escapeHtml(v.village_name || `Dorf ${id}`)}</span>
                <span>${escapeHtml(villageCoords(v) || '—')}</span>
                <span class="msp-village-type msp-type-${type}" title="${override === 'auto' ? `Automatisch erkannt: ${typeLabel}` : 'Manuell festgelegt'}">${typeLabel}</span>
                <select class="msp-village-manual" data-village="${id}" title="Dorf-Typ festlegen">
                    <option value="auto" ${override === 'auto' ? 'selected' : ''}>Auto (${autoLabel})</option>
                    <option value="off" ${override === 'off' ? 'selected' : ''}>Off</option>
                    <option value="def" ${override === 'def' ? 'selected' : ''}>Def</option>
                    <option value="mix" ${override === 'mix' ? 'selected' : ''}>Gemischt</option>
                </select>
                <span class="${unavailable ? 'msp-free-none' : ''}">${freeCats}/4 frei</span>
            </div>`;
        }).join('');
        $('#mspVillageList').html(html || '<div class="msp-village-empty">Keine Dörfer passen zum aktuellen Filter.</div>');
        updateVillageSummary(visible.length);
    }

    function updateVillageSummary(visibleCount = null) {
        const total = currentScavengeInfo.length;
        const selected = currentScavengeInfo.filter(v => villageSelection.has(String(v.village_id))).length;
        const off = currentScavengeInfo.filter(v => villageSelection.has(String(v.village_id)) && villageType(v) === 'off').length;
        const def = currentScavengeInfo.filter(v => villageSelection.has(String(v.village_id)) && villageType(v) === 'def').length;
        const mix = selected - off - def;
        const usable = currentScavengeInfo.filter(v => freeCategoryCount(v) > 0).length;
        const manual = currentScavengeInfo.filter(v => villageTypeOverrides[String(v.village_id)]).length;
        if (visibleCount == null) visibleCount = currentScavengeInfo.filter(villageMatchesFilter).length;
        $('#mspVillageSummary').html(`
            <span class="msp-village-chip"><b>${formatNumber(selected)}</b> / ${formatNumber(total)} ausgewählt</span>
            <span class="msp-village-chip">${formatNumber(usable)} aktuell nutzbar</span>
            <span class="msp-village-chip">Off ${formatNumber(off)}</span>
            <span class="msp-village-chip">Def ${formatNumber(def)}</span>
            <span class="msp-village-chip">Gemischt ${formatNumber(mix)}</span>
            <span class="msp-village-chip">${formatNumber(manual)} manuell</span>
            <span class="msp-village-chip">${formatNumber(visibleCount)} sichtbar</span>`);
        updateTopStatus();
    }

    function setVillageSelection(mode) {
        if (!currentScavengeInfo.length) return;
        if (mode === 'all') {
            const skipBlocked = $('#mspAutoDeselectBlocked').is(':checked');
            villageSelection = new Set(
                currentScavengeInfo
                    .filter(v => !skipBlocked || freeCategoryCount(v) > 0)
                    .map(v => String(v.village_id))
            );
        }
        if (mode === 'none') villageSelection.clear();
        if (mode === 'visible-on' || mode === 'visible-off') {
            currentScavengeInfo.filter(villageMatchesFilter).forEach(v => {
                const id = String(v.village_id);
                if (mode === 'visible-on') villageSelection.add(id); else villageSelection.delete(id);
            });
        }
        villageSelectionInitialized = true;
        renderVillageSelection();
        clearPreviewKeepVillages();
    }

    function clearPreviewKeepVillages() {
        squadRequests = [];
        squadRequestsPremium = [];
        squadGroups = [];
        squadGroupsPremium = [];
        currentPreview = null;
        if (lastAnalysis && !$('#mspAnalysisContent .msp-analysis-stale').length) {
            $('#mspAnalysisContent').prepend('<div class="msp-analysis-warning msp-analysis-stale">Einstellungen wurden geändert. Diese Analyse gehört noch zur letzten Berechnung.</div>');
        }
        $('#mspPreviewPanel').hide();
        $('#mspPreviewContent').empty();
    }

    function clearCalculationState() {
        currentScavengeInfo = [];
        squadRequests = [];
        squadRequestsPremium = [];
        squadGroups = [];
        squadGroupsPremium = [];
        currentPreview = null;
    }

    function clearPreview() {
        clearPreviewKeepVillages();
        if (currentScavengeInfo.length) renderVillageSelection();
    }

    function validateForm(times) {
        const enabledUnits = config.unitOrder.filter(unit => config.unitEnabled[unit]);
        if (!enabledUnits.length) return 'Bitte mindestens einen Truppentyp auswählen.';
        if (!config.categories.some(Boolean)) return 'Bitte mindestens eine Sammelkategorie auswählen.';
        if (!Number.isFinite(times.off) || !Number.isFinite(times.def) || times.off <= 0 || times.def <= 0) {
            return 'Off- und Def-Laufzeit müssen in der Zukunft liegen und größer als 0 sein.';
        }
        return null;
    }

    function setProgress(percent, text) {
        $('#mspProgressWrap').show();
        $('#mspProgress').css('width', `${Math.max(0, Math.min(100, percent))}%`);
        $('#mspStatus').text(text || '');
    }

    function baseMassUrl() {
        if (game_data.player?.sitter > 0) {
            return `game.php?t=${game_data.player.id}&screen=place&mode=scavenge_mass`;
        }
        return 'game.php?screen=place&mode=scavenge_mass';
    }

    function extractPageCount(html) {
        let maxPage = 0;
        $(html).find('.paged-nav-item').each((_, el) => {
            const href = $(el).attr('href') || '';
            const match = href.match(/[?&]page=(\d+)/);
            if (match) maxPage = Math.max(maxPage, Number(match[1]));
        });
        return maxPage;
    }

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function getHtml(url) {
        return new Promise((resolve, reject) => {
            $.get(url)
                .done(resolve)
                .fail(xhr => reject(new Error(`HTTP-Fehler beim Laden (${xhr.status || 'unbekannt'}).`)));
        });
    }

    async function loadAllVillagePages() {
        const baseUrl = baseMassUrl();
        setProgress(3, 'Sammelseite wird vorbereitet …');

        const firstHtml = await getHtml(baseUrl);
        const worldData = extractWorldParameters(firstHtml);
        durationExponent = Number(worldData.duration_exponent || 0);
        durationFactor = Number(worldData.duration_factor || 0);
        durationInitialSeconds = Number(worldData.duration_initial_seconds || 0);

        if (!durationExponent || !durationFactor) throw new Error('Weltparameter für die Laufzeitberechnung fehlen.');

        const maxPage = extractPageCount(firstHtml);
        const urls = Array.from({ length: maxPage + 1 }, (_, page) => `${baseUrl}&page=${page}`);
        const all = [];

        for (let i = 0; i < urls.length; i++) {
            const html = i === 0 ? firstHtml : await getHtml(urls[i]);
            const pageVillages = extractVillagesFromHtml(html);
            all.push(...pageVillages);

            const progress = 5 + ((i + 1) / urls.length) * 55;
            setProgress(progress, `Dörfer laden: Seite ${i + 1} von ${urls.length} …`);
            if (i < urls.length - 1) await wait(APP.requestDelayMs);
        }

        return all;
    }

    async function calculateAll() {
        if (!checkRecommendationBeforeCalculate()) return;
        currentRunId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        readFormIntoConfig();
        clearPreviewKeepVillages();
        $('#mspPreviewPanel').hide();
        $('#mspCalculateBtn').prop('disabled', true).text('Berechnung läuft …');

        try {
            const times = getEffectiveTimes();
            const validation = validateForm(times);
            if (validation) throw new Error(validation);

            const safetyLevel = safetyLevelForTimes(times);
            if (safetyLevel === 'red' && !confirmExtremeRuntime(times, 'Berechnung')) {
                throw new Error('Berechnung wegen ungewöhnlich langer Laufzeit abgebrochen.');
            }
            if (safetyLevel === 'yellow') {
                notifyInfo(`⚠ Ungewöhnlich lange Laufzeit: Off ${safetyRuntimeLabel(times.off)} · Def ${safetyRuntimeLabel(times.def)}.`);
            }

            if (!currentScavengeInfo.length) {
                currentScavengeInfo = await loadAllVillagePages();
                if (!villageSelectionInitialized) {
                    const autoSkipBlocked = $('#mspAutoDeselectBlocked').is(':checked');
                    villageSelection = new Set(
                        currentScavengeInfo
                            .filter(v => !autoSkipBlocked || freeCategoryCount(v) > 0)
                            .map(v => String(v.village_id))
                    );
                    villageSelectionInitialized = true;
                }
            }
            const selectedVillages = villageSelectionInitialized
                ? currentScavengeInfo.filter(v => villageSelection.has(String(v.village_id)))
                : currentScavengeInfo;
            if (!selectedVillages.length) throw new Error('Bitte mindestens ein Dorf auswählen.');
            const analysis = createAnalysisCounters();
            analysis.villagesLoaded = currentScavengeInfo.length;
            analysis.villagesSelected = selectedVillages.length;
            selectedVillages.forEach(village => analyzeVillageBeforeCalculation(village, analysis));
            setProgress(62, `${formatNumber(selectedVillages.length)} von ${formatNumber(currentScavengeInfo.length)} Dörfern ausgewählt. Verteilung wird berechnet …`);

            const preview = createEmptyPreview(times);
            preview.villagesLoaded = currentScavengeInfo.length;
            preview.villagesSelected = selectedVillages.length;
            const total = selectedVillages.length || 1;

            selectedVillages.forEach((village, index) => {
                calculateVillage(village, times, preview);
                if (index % 40 === 0 || index === currentScavengeInfo.length - 1) {
                    setProgress(62 + ((index + 1) / total) * 28, `Berechnung: ${index + 1} von ${selectedVillages.length} ausgewählten Dörfern …`);
                }
            });

            squadGroups = chunk(squadRequests, APP.maxSquadsPerGroup);
            squadGroupsPremium = chunk(squadRequestsPremium, APP.maxSquadsPerGroup);
            preview.groups = squadGroups.length;
            currentPreview = preview;
            finishAnalysisFromRequests(analysis, squadRequests);

            setProgress(100, `Fertig: ${formatNumber(preview.requests)} Sammelaufträge in ${preview.groups} Gruppe(n).`);
            renderPreview(preview);
        } catch (error) {
            console.error('[MassScavenge+] Berechnung fehlgeschlagen:', error);
            setProgress(0, `Fehler: ${error.message}`);
            notifyError(`Mass Scavenge+: ${error.message}`);
        } finally {
            $('#mspCalculateBtn').prop('disabled', false).text('Sammelaufträge berechnen');
        }
    }

    function createEmptyPreview(times) {
        const unitTotals = {};
        config.unitOrder.forEach(unit => { unitTotals[unit] = 0; });
        return {
            villagesLoaded: currentScavengeInfo.length,
            villagesSelected: currentScavengeInfo.length,
            villagesEligible: 0,
            villagesUsed: new Set(),
            requests: 0,
            groups: 0,
            skippedNoRally: 0,
            skippedNoTroops: 0,
            skippedNoCategory: 0,
            times,
            unitTotals,
            categoryTotals: [
                { requests: 0, units: 0 },
                { requests: 0, units: 0 },
                { requests: 0, units: 0 },
                { requests: 0, units: 0 }
            ]
        };
    }

    function calculateVillage(data, times, preview) {
        if (!data?.has_rally_point) {
            preview.skippedNoRally++;
            return;
        }

        preview.villagesEligible++;

        const troopsAllowed = {};
        config.unitOrder.forEach(unit => {
            if (!config.unitEnabled[unit]) return;
            const home = safeInt(data.unit_counts_home?.[unit], 0, 0);
            const reserve = safeInt(config.reserve[unit], 0, 0);
            troopsAllowed[unit] = Math.max(0, home - reserve);
        });

        const troopCount = Object.values(troopsAllowed).reduce((sum, value) => sum + value, 0);
        const availableFarmSpace = totalFarmSpace(troopsAllowed);
        if (troopCount <= 0 || availableFarmSpace < MIN_SCAVENGE_FARM_SPACE) {
            preview.skippedNoTroops++;
            return;
        }

        const typeCount = { off: 0, def: 0 };
        for (const [unit, amount] of Object.entries(troopsAllowed)) {
            const type = UNIT_META[unit]?.type;
            if (type) typeCount[type] += amount;
        }

        let totalLoot = 0;
        for (const [unit, amount] of Object.entries(troopsAllowed)) {
            const carry = UNIT_META[unit]?.carry || 0;
            totalLoot += amount * (Number(data.unit_carry_factor || 1) * carry);
        }
        if (totalLoot <= 0) {
            preview.skippedNoTroops++;
            return;
        }

        const runtime = typeCount.off > typeCount.def ? times.off : times.def;
        const haul = calculateTargetHaul(runtime);
        if (!Number.isFinite(haul) || haul <= 0) return;

        const haulCategoryRate = {};
        const factors = { 1: 0.10, 2: 0.25, 3: 0.50, 4: 0.75 };
        let availableCategoryCount = 0;

        for (let category = 1; category <= 4; category++) {
            const option = data.options?.[category];
            const unavailable = !config.categories[category - 1] || !option || option.is_locked || option.scavenging_squad != null;
            if (unavailable) {
                haulCategoryRate[category] = 0;
            } else {
                haulCategoryRate[category] = haul / factors[category];
                availableCategoryCount++;
            }
        }

        if (!availableCategoryCount) {
            preview.skippedNoCategory++;
            return;
        }

        const totalHaul = Object.values(haulCategoryRate).reduce((sum, value) => sum + value, 0);
        if (totalHaul <= 0) return;

        const unitsReady = calculateUnitsPerVillage({
            troopsAllowed: { ...troopsAllowed },
            totalLoot,
            totalHaul,
            haulCategoryRate
        });

        let villageUsed = false;

        for (let index = 0; index < 4; index++) {
            const category = index + 1;
            const option = data.options?.[category];
            if (!config.categories[index] || !option || option.is_locked || option.scavenging_squad != null) continue;

            const unitCounts = sanitizeUnitCounts(unitsReady[index] || {});
            const unitSum = Object.values(unitCounts).reduce((sum, value) => sum + value, 0);
            if (unitSum <= 0) continue;

            // Die Stämme verlangt mindestens 10 Bauernhofplätze pro Sammelauftrag.
            // Unterhalb dieses Wertes wird niemals ein Request erzeugt.
            const farmSpace = farmSpaceOfCounts(unitCounts);
            if (farmSpace < MIN_SCAVENGE_FARM_SPACE) continue;

            const candidateSquad = { unit_counts: unitCounts, carry_max: 9999999999 };
            squadRequests.push({
                village_id: data.village_id,
                candidate_squad: candidateSquad,
                option_id: category,
                use_premium: false
            });
            squadRequestsPremium.push({
                village_id: data.village_id,
                candidate_squad: candidateSquad,
                option_id: category,
                use_premium: true
            });

            preview.requests++;
            villageUsed = true;
            let categoryUnitCount = 0;
            for (const [unit, amount] of Object.entries(unitCounts)) {
                preview.unitTotals[unit] = (preview.unitTotals[unit] || 0) + amount;
                categoryUnitCount += amount;
            }
            if (preview.categoryTotals[index]) {
                preview.categoryTotals[index].requests++;
                preview.categoryTotals[index].units += categoryUnitCount;
            }
        }

        if (villageUsed) preview.villagesUsed.add(String(data.village_id));
    }

    function calculateTargetHaul(runtimeHours) {
        const base = (runtimeHours * 3600) / durationFactor - durationInitialSeconds;
        if (base <= 0 || durationExponent <= 0) return 0;
        const first = Math.pow(base, 1 / durationExponent) / 100;
        if (first <= 0) return 0;
        return Math.floor(Math.sqrt(first));
    }

    function farmSpaceOfCounts(counts) {
        let total = 0;
        for (const [unit, amount] of Object.entries(counts || {})) {
            total += safeInt(amount, 0, 0) * safeInt(UNIT_META[unit]?.pop, 1, 1);
        }
        return total;
    }

    function totalFarmSpace(troops) {
        return farmSpaceOfCounts(troops);
    }

    function trySeedBalancedCategories(troopsAllowed, categories) {
        const remaining = { ...troopsAllowed };
        const result = {};
        const farmSpace = {};
        categories.forEach(category => {
            result[category] = {};
            farmSpace[category] = 0;
        });

        const unitOrderByPop = [...config.unitOrder]
            .filter(unit => Object.prototype.hasOwnProperty.call(remaining, unit))
            .sort((a, b) => {
                const popDiff = safeInt(UNIT_META[a]?.pop, 1, 1) - safeInt(UNIT_META[b]?.pop, 1, 1);
                return popDiff || config.unitOrder.indexOf(a) - config.unitOrder.indexOf(b);
            });

        while (categories.some(category => farmSpace[category] < MIN_SCAVENGE_FARM_SPACE)) {
            const category = [...categories]
                .filter(cat => farmSpace[cat] < MIN_SCAVENGE_FARM_SPACE)
                .sort((a, b) => farmSpace[a] - farmSpace[b])[0];

            const unit = unitOrderByPop.find(name => safeInt(remaining[name], 0, 0) > 0);
            if (!unit) return null;

            result[category][unit] = safeInt(result[category][unit], 0, 0) + 1;
            remaining[unit] = safeInt(remaining[unit], 0, 0) - 1;
            farmSpace[category] += safeInt(UNIT_META[unit]?.pop, 1, 1);
        }

        return { result, remaining };
    }

    function calculateBalancedUnitsPerVillage(troopsAllowed, haulCategoryRate) {
        const result = { 0: {}, 1: {}, 2: {}, 3: {} };
        const activeCategories = [1, 2, 3, 4].filter(category => (haulCategoryRate[category] || 0) > 0);
        if (!activeCategories.length) return result;

        // Wenn nicht genug Bauernhofplätze für alle Kategorien vorhanden sind,
        // verwenden wir so viele Kategorien wie tatsächlich mit mindestens 10 BP
        // gestartet werden können. In diesem Engpassfall werden die höheren
        // Sammelstufen zuerst berücksichtigt.
        const highFirst = [...activeCategories].sort((a, b) => b - a);
        let selectedCategories = null;
        let seeded = null;

        for (let count = activeCategories.length; count >= 1; count--) {
            const candidate = count === activeCategories.length
                ? [...activeCategories]
                : highFirst.slice(0, count).sort((a, b) => a - b);

            if (totalFarmSpace(troopsAllowed) < count * MIN_SCAVENGE_FARM_SPACE) continue;

            const attempt = trySeedBalancedCategories(troopsAllowed, candidate);
            if (attempt) {
                selectedCategories = candidate;
                seeded = attempt;
                break;
            }
        }

        if (!selectedCategories || !seeded) return result;

        // Mindestbesatzung übernehmen.
        for (const category of selectedCategories) {
            result[category - 1] = { ...seeded.result[category] };
        }

        const remaining = seeded.remaining;
        const weights = {};
        let weightSum = 0;
        for (const category of selectedCategories) {
            const weight = Math.max(0, Number(haulCategoryRate[category] || 0));
            weights[category] = weight;
            weightSum += weight;
        }
        if (weightSum <= 0) return result;

        const carryOf = counts => {
            let total = 0;
            for (const [unit, amount] of Object.entries(counts || {})) {
                total += safeInt(amount, 0, 0) * (UNIT_META[unit]?.carry || 0);
            }
            return total;
        };

        const remainingCarry = carryOf(remaining);
        const seededCarry = selectedCategories.reduce(
            (sum, category) => sum + carryOf(result[category - 1]),
            0
        );
        const finalCarryTotal = seededCarry + remainingCarry;

        const targetCarry = {};
        const currentCarry = {};
        for (const category of selectedCategories) {
            targetCarry[category] = finalCarryTotal * (weights[category] / weightSum);
            currentCarry[category] = carryOf(result[category - 1]);
        }

        // Restliche Truppen so verteilen, dass die Tragkraft möglichst dem
        // Soll-Verhältnis der Sammelkategorien entspricht. Damit nähern sich
        // die Rückkehrzeiten im Modus "Ausgeglichen" aneinander an.
        for (const unit of config.unitOrder) {
            let available = safeInt(remaining[unit], 0, 0);
            const carry = UNIT_META[unit]?.carry || 0;
            if (available <= 0 || carry <= 0) continue;

            while (available > 0) {
                let category = selectedCategories[0];
                let bestDeficit = -Infinity;

                for (const cat of selectedCategories) {
                    const deficit = targetCarry[cat] - currentCarry[cat];
                    if (deficit > bestDeficit) {
                        bestDeficit = deficit;
                        category = cat;
                    }
                }

                let amount = available;
                if (bestDeficit > 0) {
                    amount = Math.min(available, Math.max(1, Math.floor(bestDeficit / carry)));
                } else {
                    // Nur Rundungsreste: an die relativ am stärksten
                    // unterrepräsentierte Kategorie geben.
                    category = [...selectedCategories].sort((a, b) => {
                        const ratioA = targetCarry[a] > 0 ? currentCarry[a] / targetCarry[a] : Infinity;
                        const ratioB = targetCarry[b] > 0 ? currentCarry[b] / targetCarry[b] : Infinity;
                        return ratioA - ratioB;
                    })[0];
                    amount = 1;
                }

                result[category - 1][unit] = safeInt(result[category - 1][unit], 0, 0) + amount;
                currentCarry[category] += amount * carry;
                available -= amount;
            }
        }

        return result;
    }

    function calculateUnitsPerVillage({ troopsAllowed, totalLoot, totalHaul, haulCategoryRate }) {
        if (config.priority !== 'high') {
            return calculateBalancedUnitsPerVillage({ ...troopsAllowed }, haulCategoryRate);
        }

        const result = { 0: {}, 1: {}, 2: {}, 3: {} };
        const remaining = { ...troopsAllowed };
        const unitHaul = {};
        config.unitOrder.forEach(unit => { unitHaul[unit] = UNIT_META[unit]?.carry || 0; });

        // "Hohe Kategorien zuerst": bewusst von Großartig -> Faul auffüllen.
        for (let j = 3; j >= 0; j--) {
            let reach = haulCategoryRate[j + 1] || 0;
            if (reach <= 0) continue;

            config.unitOrder.forEach(unit => {
                if (!Object.prototype.hasOwnProperty.call(remaining, unit) || reach <= 0 || !unitHaul[unit]) return;
                const available = safeInt(remaining[unit], 0, 0);
                if (available <= 0) return;

                const amountNeeded = Math.max(0, Math.floor(reach / unitHaul[unit]));
                const use = amountNeeded > available ? available : amountNeeded;

                if (use > 0) {
                    result[j][unit] = use;
                    remaining[unit] = available - use;
                    reach -= use * unitHaul[unit];
                }
            });
        }

        return result;
    }

    function sanitizeUnitCounts(counts) {
        const clean = {};
        for (const [unit, value] of Object.entries(counts || {})) {
            const amount = safeInt(value, 0, 0);
            if (amount > 0) clean[unit] = amount;
        }
        return clean;
    }

    function chunk(array, size) {
        const groups = [];
        for (let i = 0; i < array.length; i += size) groups.push(array.slice(i, i + size));
        return groups;
    }

    function formatServerDateTime(ms) {
        const d = new Date(ms);
        const pad = value => String(value).padStart(2, '0');
        return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function groupStats(group) {
        const villages = new Set();
        let units = 0;
        for (const request of group || []) {
            if (request?.village_id != null) villages.add(String(request.village_id));
            for (const value of Object.values(request?.candidate_squad?.unit_counts || {})) units += safeInt(value, 0, 0);
        }
        return { villages: villages.size, units };
    }

    function updateSendProgress() {
        const totalGroups = squadGroups.length;
        const sentRows = $('#mspPreviewContent .msp-send-row.msp-sent');
        const sentGroups = sentRows.length;

        let sentRequests = 0;
        sentRows.each((_, el) => {
            const index = Number($(el).data('group'));
            if (Number.isInteger(index) && Array.isArray(squadGroups[index])) {
                sentRequests += squadGroups[index].length;
            }
        });

        const totalRequests = squadGroups.reduce((sum, group) => sum + (Array.isArray(group) ? group.length : 0), 0);
        const progress = $('#mspSendProgress');

        if (totalGroups > 0 && sentGroups === totalGroups) {
            progress
                .addClass('msp-all-sent')
                .html(`✓ <b>${sentGroups}/${totalGroups}</b> Versandgruppen gesendet · <b>${formatNumber(sentRequests)}/${formatNumber(totalRequests)}</b> Sammelaufträge`);
        } else {
            progress
                .removeClass('msp-all-sent')
                .html(`<b>${sentGroups}/${totalGroups}</b> Versandgruppen gesendet · <b>${formatNumber(sentRequests)}/${formatNumber(totalRequests)}</b> Sammelaufträge`);
        }
    }

    function renderPreview(preview) {
        const usedVillageCount = preview.villagesUsed.size;
        const selectedVillageCount = preview.villagesSelected ?? preview.villagesLoaded;
        const activeUnits = config.unitOrder.filter(unit => (preview.unitTotals[unit] || 0) > 0);
        const totalSentUnits = Object.values(preview.unitTotals).reduce((sum, value) => sum + value, 0);

        const returnOff = serverDateMs + preview.times.off * 3600000;
        const returnDef = serverDateMs + preview.times.def * 3600000;
        const returnOffText = formatServerDateTime(returnOff);
        const returnDefText = formatServerDateTime(returnDef);
        const sameReturn = Math.abs(returnOff - returnDef) < 60000;

        const warnings = [];
        if (!preview.requests) {
            warnings.push('Es konnten keine sinnvollen Sammelaufträge erzeugt werden. Prüfe Laufzeit, Reserven und aktive Kategorien.');
        }
        const maxRuntime = Math.max(preview.times.off, preview.times.def);
        if (maxRuntime >= 20) {
            warnings.push(`⚠ Kritische Laufzeit: Off ${safetyRuntimeLabel(preview.times.off)} · Def ${safetyRuntimeLabel(preview.times.def)}. Bitte Rückkehrdatum und Schnellbutton prüfen.`);
        } else if (maxRuntime >= 12) {
            warnings.push(`Ungewöhnlich lange Laufzeit: Off ${safetyRuntimeLabel(preview.times.off)} · Def ${safetyRuntimeLabel(preview.times.def)}.`);
        }

        const analysisAvailable = Number(lastAnalysis?.totalAvailableUnits || 0);
        const analysisSent = Number(lastAnalysis?.totalSentUnits || 0);
        const usageShare = analysisAvailable > 0 ? analysisSent / analysisAvailable : 1;
        if (analysisAvailable > 0 && usageShare > 0 && usageShare < 0.15) {
            warnings.push(`Nur ${Math.round(usageShare * 100)} % der verfügbaren Truppen werden eingeplant. Prüfe Reserve, Laufzeit und freie Kategorien.`);
        }

        const selectedForSafety = Number(preview.villagesSelected ?? preview.villagesLoaded ?? 0);
        const usedShare = selectedForSafety > 0 ? usedVillageCount / selectedForSafety : 1;
        if (selectedForSafety >= 5 && usedShare < 0.6) {
            warnings.push(`Nur ${usedVillageCount} von ${selectedForSafety} ausgewählten Dörfern werden genutzt. Prüfe freie Kategorien, Reserven und Dorfwahl.`);
        }

        const skippedNoTroops = safeInt(preview.skippedNoTroops, 0, 0);
        const skippedNoSlot = safeInt(preview.skippedNoCategory, 0, 0) + safeInt(preview.skippedNoRally, 0, 0);
        const hasPlanningProblem = skippedNoTroops > 0 || skippedNoSlot > 0;

        const diagnosis = hasPlanningProblem
            ? `<div class="msp-preview-problem">
                ⚠ Nicht alle ausgewählten Dörfer konnten vollständig genutzt werden:
                ${skippedNoTroops ? `<b>${formatNumber(skippedNoTroops)}</b> ohne nutzbare Truppen` : ''}
                ${skippedNoTroops && skippedNoSlot ? ' · ' : ''}
                ${skippedNoSlot ? `<b>${formatNumber(skippedNoSlot)}</b> ohne freie Kategorie / Versammlungsplatz` : ''}
              </div>`
            : `<div class="msp-preview-ok">✓ Alle <b>${formatNumber(usedVillageCount)}</b> genutzten Dörfer konnten ohne erkannte Einschränkung eingeplant werden.</div>`;

        const categoryPills = preview.categoryTotals
            .map((entry, index) => {
                if (!entry.requests && !entry.units) return '';
                return `<span class="msp-category-pill" style="${config.categories[index] ? '' : 'opacity:.5;'}"><b>${escapeHtml(categoryNames[index] || `Kategorie ${index + 1}`)}</b>: ${formatNumber(entry.requests)} Läufe · ${formatNumber(entry.units)} Einh.</span>`;
            })
            .join('');

        const unitRows = activeUnits.map(unit => `
<tr>
    <td><img src="${unitImage(unit)}" style="width:18px;height:18px;vertical-align:middle;margin-right:5px;">${escapeHtml(UNIT_META[unit]?.label || unit)}</td>
    <td>${formatNumber(preview.unitTotals[unit])}</td>
</tr>`).join('');

        const unitInline = activeUnits.length === 1
            ? `<span class="msp-category-pill"><b>${escapeHtml(UNIT_META[activeUnits[0]]?.label || activeUnits[0])}</b>: ${formatNumber(preview.unitTotals[activeUnits[0]])}</span>`
            : '';

        const groupRows = squadGroups.map((group, index) => {
            const stats = groupStats(group);
            return `
<div class="msp-send-row" id="mspGroupRow-${index}" data-group="${index}">
    <div class="msp-group-label">
        <b>Gruppe ${index + 1}/${squadGroups.length}</b> · ${formatNumber(group.length)} Aufträge
        <div class="msp-group-meta">${formatNumber(stats.villages)} Dörfer · ${formatNumber(stats.units)} Einheiten</div>
    </div>
    <button class="msp-btn msp-btn-success msp-send-normal" data-group="${index}">Senden</button>
    ${window.premiumBtnEnabled === true ? `<button class="msp-btn msp-send-premium" data-group="${index}">Premium</button>` : ''}
</div>`;
        }).join('');

        const returnText = sameReturn
            ? `<b>Rückkehr ${returnOffText}</b>`
            : `<b>Rückkehr</b> · Off <b>${returnOffText}</b> · Def <b>${returnDefText}</b>`;

        $('#mspPreviewContent').html(`
<div class="msp-preview-head">
    <div class="msp-preview-return">${returnText}</div>
    <div class="msp-preview-actions">
        <button class="msp-btn msp-btn-secondary" id="mspTogglePreviewDetails" type="button">Details</button>
        <button class="msp-btn msp-btn-secondary" id="mspClosePreview" type="button">Schließen</button>
    </div>
</div>

<div class="msp-preview-kpis">
    <div class="msp-preview-kpi"><b>${formatNumber(usedVillageCount)}/${formatNumber(preview.villagesLoaded)}</b><span>Dörfer genutzt</span></div>
    <div class="msp-preview-kpi"><b>${formatNumber(preview.requests)}</b><span>Sammelaufträge</span></div>
    <div class="msp-preview-kpi"><b>${formatNumber(totalSentUnits)}</b><span>Einheiten</span></div>
    <div class="msp-preview-kpi"><b>${formatNumber(preview.groups)}</b><span>Versandgruppen</span></div>
</div>

${diagnosis}

<div class="msp-category-summary">${categoryPills}${unitInline}</div>

${warnings.map(text => `<div class="msp-warning">${escapeHtml(text)}</div>`).join('')}

<div class="msp-preview-details" id="mspPreviewDetails">
    <div class="msp-detail-grid">
        <div class="msp-detail-card"><b>${formatNumber(preview.villagesLoaded)}</b>Dörfer geladen</div>
        <div class="msp-detail-card"><b>${formatNumber(selectedVillageCount)}</b>Dörfer ausgewählt</div>
        <div class="msp-detail-card"><b>${formatNumber(preview.villagesEligible)}</b>mit Versammlungsplatz</div>
    </div>
    <div style="font-size:11px;margin:5px 0;">
        Gewünschte Laufzeit: <b>Off ${formatDuration(preview.times.off * 3600)}</b> ·
        <b>Def ${formatDuration(preview.times.def * 3600)}</b>
    </div>
    ${unitRows ? `<table class="msp-unit-summary"><thead><tr><th>Einheit</th><th>Eingeplant</th></tr></thead><tbody>${unitRows}</tbody></table>` : ''}
</div>

<div class="msp-send-progress" id="mspSendProgress">0/${preview.groups} Versandgruppen gesendet · 0/${formatNumber(preview.requests)} Sammelaufträge</div>
<div class="msp-send-groups">${groupRows || '<div class="msp-warning">Keine Versandgruppe vorhanden.</div>'}</div>
`);

        $('#mspPreviewPanel').show();
        $('#mspPreviewPanel')[0]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        $('#mspClosePreview').on('click', () => $('#mspPreviewPanel').hide());
        $('#mspTogglePreviewDetails').on('click', function () {
            const details = $('#mspPreviewDetails');
            const open = !details.hasClass('msp-open');
            details.toggleClass('msp-open', open);
            $(this).text(open ? 'Details schließen' : 'Details');
        });

        $('.msp-send-normal').on('click', function () {
            sendGroup(Number($(this).data('group')), false);
        });
        $('.msp-send-premium').on('click', function () {
            sendGroup(Number($(this).data('group')), true);
        });

        updateSendProgress();
    }

    function sendGroup(groupIndex, premium) {
        const group = premium ? squadGroupsPremium[groupIndex] : squadGroups[groupIndex];
        if (!Array.isArray(group) || !group.length) return notifyError('Diese Versandgruppe ist leer oder nicht mehr verfügbar.');

        // Letzte rote Schranke unmittelbar vor dem ersten Versand.
        if (groupIndex === 0 && currentPreview?.times && !confirmExtremeRuntime(currentPreview.times, 'Versand')) {
            notifyInfo('Versand abgebrochen – Laufzeit bitte noch einmal prüfen.');
            return;
        }

        if (premium) {
            const ok = confirm(
                `Gruppe ${groupIndex + 1} wirklich mit Premium versenden?\n\n` +
                'Je nach Anzahl der Dörfer/Einheiten können Premium-Punkte verbraucht werden.'
            );
            if (!ok) return;
        }

        const row = $(`#mspGroupRow-${groupIndex}`);
        row.find('button').prop('disabled', true);

        TribalWars.post(
            'scavenge_api',
            { ajaxaction: 'send_squads' },
            { squad_requests: group },
            () => {
                row.addClass('msp-sent');
                row.find('button').remove();
                updateSendProgress();
                recordSentGroup(groupIndex, group);
                notifySuccess(`Sammelgruppe ${groupIndex + 1} erfolgreich gesendet.`);
            },
            false
        );

        // Sicherheitsnetz: Falls der Callback ausbleibt, Buttons nicht ewig sperren.
        setTimeout(() => {
            if (!row.hasClass('msp-sent')) row.find('button').prop('disabled', false);
        }, 5000);
    }



    /* =========================================================
       Mass Scavenge+ Automate – Autopilot v1.3.6
       - Simulation und echter Autopilot nutzen dieselbe getestete Planungslogik
       - nutzt automatisch alle freien/freigeschalteten Kategorien
       - jeder einzelne Auftrag braucht mindestens 10 Bauernhofplätze
       - reichen Truppen nicht, fällt jeweils die schwächste Kategorie weg und es wird neu gerechnet
       - bündelt pro Dorf versetzt zurückkehrende Kategorien (Standard 10 Min.)
       - simuliert Belegung/Rückkehr und prüft kurz nach der nächsten Rückkehr
       ========================================================= */
    const AUTO = {
        running: false,
        mode: 'sim',
        timer: null,
        busy: new Map(),
        log: [],
        cycleRunning: false,
        minDelayMs: 15000,
        fallbackDelayMs: 120000,
        startedAt: 0,
        cycles: 0,
        launched: 0,
        sentGroups: 0,
        droppedCategories: 0,
        statusTimer: null,
        serverBusyUntil: [],
        serverReturnByVillage: new Map(),
        waitingVillages: new Map(),
        bundleWindowMs: Math.max(
            0,
            Math.min(60, Number(localStorage.getItem('msp_automate_bundle_minutes') || 10))
        ) * 60000,
        deadlineOffAt: 0,
        deadlineDefAt: 0,
        stopDeadlineAt: 0,
        deadlineLabel: '',
        planMode: 'return',
        runtimeOffHours: 4,
        runtimeDefHours: 4,
        maxRaidHours: Math.max(0.1, Number(localStorage.getItem('msp_automate_max_raid_hours') || 4)),
        runtimeSafetyMs: 30000,
        runtimeClamped: 0,
        runtimeRejected: 0
    };


    function autoDuration(ms) {
        const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const sec = total % 60;
        return [h,m,sec].map(v => String(v).padStart(2,'0')).join(':');
    }

    function autoUpdateStatus(extra) {
        const runtime = AUTO.startedAt ? autoDuration(Date.now() - AUTO.startedAt) : '00:00:00';
        const occupied = AUTO.busy.size;
        const suffix = extra ? ` · ${extra}` : '';
        const modeText = AUTO.mode === 'live' ? '🔴 Autopilot läuft' : '🟢 Simulation läuft';
        $('#mspAutoState').text(`${AUTO.running ? modeText : '⚪ Bereit'} · ⏱ ${runtime}${suffix}`);
        $('#mspAutoLaunchedStat').text(`🚀 ${AUTO.launched}`);
        $('#mspAutoCycleStat').text(`🔄 ${AUTO.cycles}`);
        $('#mspAutoBusyStat').text(`📦 ${occupied}`);
        updateAutomateDeadlineBadge();
    }

    function autoTime() {
        return new Date().toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    }

    function autoLog(message) {
        const line = `${autoTime()} · ${message}`;
        AUTO.log.push(line);
        if (AUTO.log.length > 2500) AUTO.log.splice(0, AUTO.log.length - 2500);
        const box = document.getElementById('mspAutoLog');
        if (box) {
            box.textContent = AUTO.log.join('\n');
            box.scrollTop = box.scrollHeight;
        }
    }

    function autoBusyKey(villageId, optionId) { return `${villageId}:${optionId}`; }

    function autoPruneBusy(now = Date.now()) {
        for (const [key, until] of AUTO.busy.entries()) if (until <= now) AUTO.busy.delete(key);
    }

    function autoOverlayBusy(villages) {
        autoPruneBusy();
        for (const village of villages) {
            for (let category = 1; category <= 4; category++) {
                const key = autoBusyKey(village.village_id, category);
                if (AUTO.busy.has(key) && village?.options?.[category]) {
                    village.options[category].scavenging_squad = { __msp_simulated: true };
                }
            }
        }
    }

    function autoFreeCategories(village) {
        const out = [];
        for (let category = 1; category <= 4; category++) {
            const option = village?.options?.[category];
            if (option && !option.is_locked && option.scavenging_squad == null) out.push(category);
        }
        return out;
    }

    const AUTO_POP = { spear:1, sword:1, axe:1, archer:1, light:4, marcher:5, heavy:6, spy:2, ram:5, catapult:8, knight:10 };
    const AUTO_CATEGORY_FACTOR = { 1:0.10, 2:0.25, 3:0.50, 4:0.75 };

    function autoFarmSpaceForRequest(req) {
        const counts = req?.candidate_squad?.unit_counts || {};
        return Object.entries(counts).reduce((sum, [unit, amount]) => {
            return sum + (Number(amount) || 0) * (AUTO_POP[unit] || 0);
        }, 0);
    }

    function autoRuntimeMsForCounts(counts, village, category) {
        counts = counts || {};
        const carryFactor = Number(village?.unit_carry_factor || 1) || 1;
        let rawCarry = 0;
        for (const [unit, amount] of Object.entries(counts)) {
            rawCarry += (Number(amount) || 0) * (UNIT_META[unit]?.carry || 0) * carryFactor;
        }
        const categoryFactor = Number(village?.options?.[category]?.loot_factor || AUTO_CATEGORY_FACTOR[category] || 0);
        const effectiveHaul = rawCarry * categoryFactor;
        if (!(effectiveHaul > 0) || !(durationFactor > 0) || !(durationExponent > 0)) return AUTO.fallbackDelayMs;
        const seconds = durationFactor * (durationInitialSeconds + Math.pow(100 * effectiveHaul * effectiveHaul, durationExponent));
        return Math.max(AUTO.minDelayMs, seconds * 1000);
    }

    function autoActualRuntimeMs(req, village) {
        return autoRuntimeMsForCounts(
            req?.candidate_squad?.unit_counts || {},
            village,
            Number(req?.option_id || 0)
        );
    }

    function autoRequestTroopType(req) {
        let off = 0, def = 0;
        const counts = req?.candidate_squad?.unit_counts || {};
        for (const [unit, amountRaw] of Object.entries(counts)) {
            const amount = Number(amountRaw) || 0;
            if (UNIT_META[unit]?.type === 'off') off += amount;
            else if (UNIT_META[unit]?.type === 'def') def += amount;
        }
        return off > def ? 'off' : 'def';
    }

    function autoRuntimeLimitHoursForRequest(req, times) {
        const troopType = autoRequestTroopType(req);
        const planned = Number(times?.[troopType]);
        const hardMax = Number(AUTO.maxRaidHours);
        const candidates = [planned, hardMax].filter(v => Number.isFinite(v) && v > 0);
        return candidates.length ? Math.min(...candidates) : NaN;
    }

    function autoClampRequestToRuntime(req, village, limitHours) {
        if (!req || !village || !(limitHours > 0)) return null;

        const limitMs = Math.max(
            AUTO.minDelayMs,
            limitHours * 3600000 - Math.min(AUTO.runtimeSafetyMs, limitHours * 3600000 * 0.02)
        );
        const currentMs = autoActualRuntimeMs(req, village);
        if (currentMs <= limitMs) return { request: req, changed: false, runtimeMs: currentMs };

        const original = { ...(req?.candidate_squad?.unit_counts || {}) };
        const build = scale => {
            const counts = {};
            for (const [unit, amountRaw] of Object.entries(original)) {
                const amount = Math.floor((Number(amountRaw) || 0) * scale);
                if (amount > 0) counts[unit] = amount;
            }
            if (farmSpaceOfCounts(counts) < MIN_SCAVENGE_FARM_SPACE) return null;
            const candidate = {
                ...req,
                candidate_squad: {
                    ...(req.candidate_squad || {}),
                    unit_counts: counts
                }
            };
            return { candidate, runtimeMs: autoActualRuntimeMs(candidate, village) };
        };

        let low = 0, high = 1, best = null;
        for (let i = 0; i < 28; i++) {
            const mid = (low + high) / 2;
            const trial = build(mid);
            if (trial && trial.runtimeMs <= limitMs) {
                best = trial;
                low = mid;
            } else {
                high = mid;
            }
        }

        if (!best) return null;
        return { request: best.candidate, changed: true, runtimeMs: best.runtimeMs };
    }

    function autoEnforceRuntimeLimits(requests, premiumRequests, villages, times) {
        const villageMap = new Map((villages || []).map(v => [String(v.village_id), v]));
        const premiumMap = new Map((premiumRequests || []).map(r => [`${r.village_id}:${r.option_id}`, r]));
        const kept = [];
        const keptPremium = [];
        let clamped = 0, rejected = 0;

        for (const req of requests || []) {
            const village = villageMap.get(String(req.village_id));
            const limitHours = autoRuntimeLimitHoursForRequest(req, times);
            const result = autoClampRequestToRuntime(req, village, limitHours);
            if (!result) {
                rejected++;
                continue;
            }
            if (result.changed) clamped++;
            kept.push(result.request);

            const key = `${req.village_id}:${req.option_id}`;
            const prem = premiumMap.get(key);
            if (prem) {
                keptPremium.push({
                    ...prem,
                    candidate_squad: {
                        ...(prem.candidate_squad || {}),
                        unit_counts: { ...(result.request.candidate_squad?.unit_counts || {}) }
                    }
                });
            }
        }

        AUTO.runtimeClamped += clamped;
        AUTO.runtimeRejected += rejected;
        return { requests: kept, premiumRequests: keptPremium, clamped, rejected };
    }

    function autoFinalRuntimeGuard(requests, villages, times) {
        const villageMap = new Map((villages || []).map(v => [String(v.village_id), v]));
        const violations = [];
        for (const req of requests || []) {
            const village = villageMap.get(String(req.village_id));
            const limitHours = autoRuntimeLimitHoursForRequest(req, times);
            const runtimeMs = autoActualRuntimeMs(req, village);
            if (!(limitHours > 0) || runtimeMs > limitHours * 3600000) {
                violations.push({
                    req,
                    limitHours,
                    runtimeMs
                });
            }
        }
        return violations;
    }

    function autoNormalizeTimestamp(value) {
        let n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return 0;
        if (n < 1e12) n *= 1000;
        return n;
    }

    function autoSquadReturnTimestamp(squad) {
        if (!squad || squad.__msp_simulated) return 0;
        const values = [
            squad.return_time, squad.return_timestamp, squad.returnTime,
            squad.end_time, squad.end_timestamp, squad.ends_at, squad.finish_time
        ];
        for (const value of values) {
            const ts = autoNormalizeTimestamp(value);
            if (ts > 0) return ts;
        }
        return 0;
    }

    function autoCollectServerReturns(villages) {
        const found = [];
        const byVillage = new Map();
        const now = Date.now();

        for (const village of villages || []) {
            const villageId = String(village?.village_id ?? '');
            if (!villageId) continue;
            const returns = new Map();

            for (let category = 1; category <= 4; category++) {
                const squad = village?.options?.[category]?.scavenging_squad;
                const ts = autoSquadReturnTimestamp(squad);
                if (ts > now) {
                    found.push(ts);
                    returns.set(category, ts);
                }
            }

            // Optimistische Belegung aus diesem Autopilot ergänzen, falls die
            // frisch geladene Serverstruktur die Rückkehrzeit noch nicht enthält.
            for (let category = 1; category <= 4; category++) {
                if (returns.has(category)) continue;
                const key = autoBusyKey(villageId, category);
                const ts = Number(AUTO.busy.get(key) || 0);
                if (ts > now) {
                    found.push(ts);
                    returns.set(category, ts);
                }
            }

            if (returns.size) byVillage.set(villageId, returns);
        }

        AUTO.serverBusyUntil = found;
        AUTO.serverReturnByVillage = byVillage;
    }

    function autoBundleDecision(village, now = Date.now()) {
        const free = autoFreeCategories(village).sort((a,b) => a-b);
        if (!free.length || !(AUTO.bundleWindowMs > 0)) return null;

        const villageId = String(village?.village_id ?? '');
        const returns = AUTO.serverReturnByVillage.get(villageId);
        if (!returns || !returns.size) return null;

        const limit = now + AUTO.bundleWindowMs;
        const soon = [];
        for (const [category, tsRaw] of returns.entries()) {
            const ts = Number(tsRaw) || 0;
            if (ts > now && ts <= limit) soon.push({ category:Number(category), ts });
        }
        if (!soon.length) return null;

        // Bis zur letzten Kategorie warten, die innerhalb des Bündelungsfensters
        // frei wird. Danach wird mit der dann realen Uhrzeit vollständig neu geplant.
        const waitUntil = Math.max(...soon.map(x => x.ts));
        return {
            free,
            waitUntil,
            returningCategories: soon.sort((a,b) => a.ts - b.ts)
        };
    }

    function autoMergePreview(target, source) {
        if (!target || !source) return;
        target.requests += source.requests || 0;
        target.skippedNoRally += source.skippedNoRally || 0;
        target.skippedNoTroops += source.skippedNoTroops || 0;
        target.skippedNoCategory += source.skippedNoCategory || 0;
        for (const id of source.villagesUsed || []) target.villagesUsed.add(id);
        for (const [unit, amount] of Object.entries(source.unitTotals || {})) target.unitTotals[unit] = (target.unitTotals[unit] || 0) + amount;
        (source.categoryTotals || []).forEach((row, i) => {
            if (!target.categoryTotals[i] || !row) return;
            target.categoryTotals[i].requests += row.requests || 0;
            target.categoryTotals[i].units += row.units || 0;
        });
    }

    function autoCalculateVillageWithFallback(village, times, preview) {
        const free = autoFreeCategories(village).sort((a,b)=>a-b);
        if (!free.length) return { free, used: [], dropped: [], minFarmSpace: null };

        const originalCategories = [...config.categories];
        const originalRequests = squadRequests;
        const originalPremium = squadRequestsPremium;
        let chosen = null;

        // Immer zuerst alle freien Kategorien. Reicht die Mindestgröße nicht,
        // fällt jeweils die schlechteste (= niedrigste) Kategorie weg.
        for (let start = 0; start < free.length; start++) {
            const active = free.slice(start);
            config.categories = [1,2,3,4].map(c => active.includes(c));
            squadRequests = [];
            squadRequestsPremium = [];
            const tempPreview = createEmptyPreview(times);
            calculateVillage(village, times, tempPreview);
            const trial = squadRequests.slice();
            const trialPremium = squadRequestsPremium.slice();
            const spaces = trial.map(autoFarmSpaceForRequest);
            const everyActivePlanned = trial.length === active.length && active.every(c => trial.some(r => Number(r.option_id) === c));
            const allLargeEnough = spaces.length > 0 && spaces.every(v => v >= 10);
            if (everyActivePlanned && allLargeEnough) {
                chosen = { active, trial, trialPremium, spaces, tempPreview };
                break;
            }
        }

        squadRequests = originalRequests;
        squadRequestsPremium = originalPremium;
        config.categories = originalCategories;

        if (!chosen) return { free, used: [], dropped: free.slice(), minFarmSpace: null };
        squadRequests.push(...chosen.trial);
        squadRequestsPremium.push(...chosen.trialPremium);
        autoMergePreview(preview, chosen.tempPreview);
        return {
            free,
            used: chosen.active.slice(),
            dropped: free.filter(c => !chosen.active.includes(c)),
            minFarmSpace: Math.min(...chosen.spaces)
        };
    }


    function autoReadStopDeadlineInput() {
        const date = String($('#mspAutoStopDate').val() || '');
        const time = String($('#mspAutoStopTime').val() || '');
        return parseLocalDateTime(date, time);
    }

    function autoFreezeDeadlinesAtStart() {
        serverDateMs = parseServerDate();
        const mode = $('input[name="mspTimeMode"]:checked').val();
        const now = serverDateMs;

        AUTO.planMode = mode === 'runtime' ? 'runtime' : 'return';
        AUTO.maxRaidHours = Math.max(0.1, safeFloat($('#mspAutoMaxRaidHours').val(), AUTO.maxRaidHours, 0.1));
        localStorage.setItem('msp_automate_max_raid_hours', String(AUTO.maxRaidHours));

        if (AUTO.planMode === 'runtime') {
            AUTO.runtimeOffHours = safeFloat($('#mspOffRuntime').val(), NaN, 0.01);
            AUTO.runtimeDefHours = safeFloat($('#mspDefRuntime').val(), NaN, 0.01);
            AUTO.deadlineOffAt = 0;
            AUTO.deadlineDefAt = 0;
            AUTO.deadlineLabel = 'feste Maximal-Laufzeit je neuem Auftrag';
        } else {
            AUTO.deadlineOffAt = parseLocalDateTime($('#mspOffDate').val(), $('#mspOffTime').val());
            AUTO.deadlineDefAt = parseLocalDateTime($('#mspDefDate').val(), $('#mspDefTime').val());
            AUTO.deadlineLabel = 'feste Rückkehrgrenze der Aufträge';
        }

        const stopAt = autoReadStopDeadlineInput();
        if (!Number.isFinite(stopAt) || stopAt <= now) {
            throw new Error('„Autopilot läuft bis“ muss in der Zukunft liegen.');
        }
        AUTO.stopDeadlineAt = stopAt;
        localStorage.setItem('msp_automate_stop_date', String($('#mspAutoStopDate').val() || ''));
        localStorage.setItem('msp_automate_stop_time', String($('#mspAutoStopTime').val() || ''));

        return {
            offAt: AUTO.deadlineOffAt,
            defAt: AUTO.deadlineDefAt,
            stopAt: AUTO.stopDeadlineAt,
            mode: AUTO.planMode,
            maxRaidHours: AUTO.maxRaidHours
        };
    }

    function autoFrozenTimes() {
        serverDateMs = parseServerDate();
        const now = serverDateMs;
        let off, def;

        if (AUTO.planMode === 'runtime') {
            off = Number(AUTO.runtimeOffHours);
            def = Number(AUTO.runtimeDefHours);
        } else {
            off = Number.isFinite(AUTO.deadlineOffAt) && AUTO.deadlineOffAt > 0
                ? (AUTO.deadlineOffAt - now) / 3600000
                : -1;
            def = Number.isFinite(AUTO.deadlineDefAt) && AUTO.deadlineDefAt > 0
                ? (AUTO.deadlineDefAt - now) / 3600000
                : -1;
        }

        const hardMax = Number(AUTO.maxRaidHours);
        if (Number.isFinite(hardMax) && hardMax > 0) {
            if (off > 0) off = Math.min(off, hardMax);
            if (def > 0) def = Math.min(def, hardMax);
        }

        return { off, def };
    }

    function autoFormatDeadline(ts) {
        if (!Number.isFinite(ts) || ts <= 0) return '—';
        return new Date(ts).toLocaleString('de-DE', {
            day:'2-digit', month:'2-digit',
            hour:'2-digit', minute:'2-digit', second:'2-digit'
        });
    }

    function autoDeadlineReached() {
        if (!AUTO.stopDeadlineAt) return false;
        return parseServerDate() >= AUTO.stopDeadlineAt;
    }

    function autoStopAtDeadline() {
        if (!AUTO.running) return;
        const when = autoFormatDeadline(AUTO.stopDeadlineAt);
        autoLog(`🛑 Autopilot-Endzeit erreicht (${when}) · Autopilot wird vollständig beendet.`);
        autoStop(true);
        $('#mspAutoState').text(`🛑 Deadline erreicht · Autopilot beendet · 🚀 ${AUTO.launched} · 🔄 ${AUTO.cycles}`);
        $('#mspAutoNext').text('Nächster Check: —');
    }

    function autoNextDelay() {
        const now = Date.now();
        const future = [...AUTO.busy.values(), ...(AUTO.serverBusyUntil || [])]
            .filter(v => v > now)
            .sort((a,b)=>a-b);
        if (!future.length) return AUTO.fallbackDelayMs;
        return Math.max(AUTO.minDelayMs, future[0] - now + 3000);
    }

    function autoSchedule(delayMs) {
        clearTimeout(AUTO.timer);
        if (!AUTO.running) return;

        if (autoDeadlineReached()) {
            autoStopAtDeadline();
            return;
        }

        let delay = Math.max(AUTO.minDelayMs, Number(delayMs) || AUTO.fallbackDelayMs);
        const now = Date.now();

        // Niemals über die einmalig eingefrorene Deadline hinaus schlafen.
        // Ist die nächste reguläre Rückkehr später, wacht Automate exakt an der
        // Deadline auf und beendet sich, statt auf den Folgetag umzuschalten.
        if (AUTO.stopDeadlineAt > now) {
            delay = Math.min(delay, Math.max(250, AUTO.stopDeadlineAt - now));
        }

        const next = new Date(now + delay);
        const label = next.toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
        $('#mspAutoNext').text(`Nächster Check: ${label}`);
        AUTO.timer = setTimeout(function () {
            if (autoDeadlineReached()) {
                autoStopAtDeadline();
                return;
            }
            autoCycle();
        }, delay);
    }

    function autoBuildPlan(villages, times, simulateBusy) {
        if (simulateBusy) autoOverlayBusy(villages);

        // Bündelungsentscheidung braucht die aktuell bekannten Rückkehrzeiten,
        // inklusive bereits laufender Server-Aufträge und eigener optimistischer Jobs.
        autoCollectServerReturns(villages);

        currentScavengeInfo = villages;
        squadRequests = [];
        squadRequestsPremium = [];
        const preview = createEmptyPreview(times);
        const decisions = new Map();
        const now = Date.now();
        AUTO.waitingVillages = new Map();

        for (const village of villages) {
            const bundle = autoBundleDecision(village, now);
            if (bundle) {
                const id = String(village.village_id);
                const decision = {
                    free: bundle.free.slice(),
                    used: [],
                    dropped: [],
                    minFarmSpace: null,
                    heldForBundle: true,
                    waitUntil: bundle.waitUntil,
                    returningCategories: bundle.returningCategories.slice()
                };
                decisions.set(id, decision);
                AUTO.waitingVillages.set(id, decision);
                continue;
            }

            const decision = autoCalculateVillageWithFallback(village, times, preview);
            decisions.set(String(village.village_id), decision);
        }

        const runtimeChecked = autoEnforceRuntimeLimits(
            squadRequests.slice(),
            squadRequestsPremium.slice(),
            villages,
            times
        );
        squadRequests = runtimeChecked.requests.slice();
        squadRequestsPremium = runtimeChecked.premiumRequests.slice();

        if (runtimeChecked.clamped) {
            autoLog(`  ⏱ Laufzeit-Schutz · ${runtimeChecked.clamped} Auftrag/-aufträge auf die zulässige Maximaldauer verkleinert.`);
        }
        if (runtimeChecked.rejected) {
            autoLog(`  ⛔ Laufzeit-Schutz · ${runtimeChecked.rejected} Auftrag/-aufträge verworfen, weil selbst die Mindestgröße die Zeitgrenze nicht sicher einhalten konnte.`);
        }

        return {
            villages,
            preview,
            decisions,
            requests: squadRequests.slice(),
            premiumRequests: squadRequestsPremium.slice()
        };
    }

    function autoRequestSignature(req) {
        const counts = req?.candidate_squad?.unit_counts || {};
        const units = Object.keys(counts).sort().map(k => `${k}:${Number(counts[k]) || 0}`).join(',');
        return `${req?.village_id}:${req?.option_id}:${units}`;
    }

    function autoSamePlan(a, b) {
        const aa = (a || []).map(autoRequestSignature).sort();
        const bb = (b || []).map(autoRequestSignature).sort();
        return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
    }

    function autoSendGroupPromise(group, index, total) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error(`Keine eindeutige Serverantwort für Versandgruppe ${index + 1}/${total}. Autopilot wird aus Sicherheitsgründen gestoppt.`));
            }, 12000);
            try {
                TribalWars.post(
                    'scavenge_api',
                    { ajaxaction: 'send_squads' },
                    { squad_requests: group },
                    () => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timeout);
                        AUTO.sentGroups++;
                        resolve();
                    },
                    false
                );
            } catch (error) {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(error);
            }
        });
    }

    async function autoSendRequests(requests) {
        const groups = chunk(requests, APP.maxSquadsPerGroup);
        for (let i = 0; i < groups.length; i++) {
            autoUpdateStatus(`sendet Gruppe ${i + 1}/${groups.length} …`);
            autoLog(`  📤 Versandgruppe ${i + 1}/${groups.length} · ${groups[i].length} Sammelauftrag/-aufträge`);
            await autoSendGroupPromise(groups[i], i, groups.length);
        }
    }

    async function autoCycle() {
        if (!AUTO.running || AUTO.cycleRunning) return;

        if (autoDeadlineReached()) {
            autoStopAtDeadline();
            return;
        }

        AUTO.cycleRunning = true;
        try {
            readFormIntoConfig();
            config.categories = [true,true,true,true];
            saveConfig();

            // Planungsziel und Autopilot-Ende sind getrennt:
            // - Laufzeitmodus bleibt bei jedem Zyklus dieselbe Maximaldauer.
            // - Rückkehrmodus zählt bis zur einmalig eingefrorenen Rückkehrgrenze herunter.
            // Zusätzlich gilt immer die harte Maximaldauer je Raubzug.
            const times = autoFrozenTimes();

            if (AUTO.planMode === 'return' && times.off <= 0 && times.def <= 0) {
                autoLog('Keine neue Planung mehr: die Rückkehrgrenze für Off und Def ist erreicht.');
                autoSchedule(autoNextDelay());
                return;
            }

            const validation = validateForm(times);
            if (validation && AUTO.planMode !== 'return') {
                throw new Error(validation);
            }

            AUTO.cycles++;
            autoUpdateStatus('prüft …');
            autoLog(`Zyklus ${AUTO.cycles} · Check gestartet · Sammeldaten werden frisch eingelesen.`);

            let villages = await loadAllVillagePages();
            let plan = autoBuildPlan(villages, times, AUTO.mode === 'sim');

            // Im echten Modus unmittelbar vor dem Versand ein zweites Mal frisch lesen
            // und neu planen. Nur dieser zweite, aktuelle Plan darf gesendet werden.
            if (AUTO.mode === 'live' && plan.requests.length) {
                autoLog('  🛡 Sicherheitscheck · Serverdaten werden direkt vor dem Versand erneut eingelesen.');
                const firstRequests = plan.requests.slice();
                villages = await loadAllVillagePages();
                plan = autoBuildPlan(villages, times, false);
                if (!autoSamePlan(firstRequests, plan.requests)) {
                    autoLog(`  ↻ Plan hat sich beim Sicherheitscheck geändert · ${firstRequests.length} → ${plan.requests.length} Auftrag/-aufträge · es wird ausschließlich der neue Plan verwendet.`);
                } else {
                    autoLog('  ✓ Sicherheitscheck · Plan unverändert.');
                }
            }

            // Die globalen Requests auf den finalen Plan setzen, damit die bestehende
            // Analyse-/Berechnungslogik konsistent bleibt.
            squadRequests = plan.requests.slice();
            squadRequestsPremium = plan.premiumRequests.slice();
            currentScavengeInfo = villages;

            const byVillage = new Map();
            for (const req of squadRequests) {
                const id = String(req.village_id);
                if (!byVillage.has(id)) byVillage.set(id, []);
                byVillage.get(id).push(Number(req.option_id));
            }

            let freeTotal = 0, plannedTotal = 0, reducedVillages = 0, bundledVillages = 0;
            for (const village of villages) {
                const id = String(village.village_id);
                const decision = plan.decisions.get(id) || {free:[],used:[],dropped:[]};
                const free = decision.free || [];
                const used = decision.used || [];
                freeTotal += free.length;
                plannedTotal += used.length;

                if (decision.heldForBundle) {
                    bundledVillages++;
                    const waitText = new Date(decision.waitUntil).toLocaleTimeString('de-DE', {
                        hour:'2-digit', minute:'2-digit', second:'2-digit'
                    });
                    const returning = (decision.returningCategories || [])
                        .map(item => `Kat. ${item.category}`)
                        .join(', ');
                    autoLog(
                        `  ⏳ ${villageCoords(village) || village.village_name || id} · ${free.length} frei · ${returning || 'weitere Kategorie'} innerhalb ${Math.round(AUTO.bundleWindowMs / 60000)} Min. zurück → Dorf wird bis ${waitText} gebündelt und dann komplett frisch neu geplant.`
                    );
                    continue;
                }

                if (decision.dropped?.length) {
                    reducedVillages++;
                    AUTO.droppedCategories += decision.dropped.length;
                    const reason = used.length
                        ? `Mindestgröße 10 Bauernhofplätze / Truppen reichen nicht für alle`
                        : `kein gültiger Auftrag mit mindestens 10 Bauernhofplätzen`;
                    autoLog(`  ↳ ${villageCoords(village) || village.village_name || id} · ${free.length} frei → ${used.length} genutzt · Kategorie ${decision.dropped.join(', ')} entfernt · ${reason}`);
                }
            }

            if (!squadRequests.length) {
                autoLog(`Keine freien Kategorien – aktuell nichts zu starten · ${freeTotal} freie Kategorie(n) geprüft.`);
            } else {
                const now = Date.now();
                let earliestReturn = Infinity;
                const busyEntries = [];
                for (const req of squadRequests) {
                    const village = villages.find(v => String(v.village_id) === String(req.village_id));
                    const runtimeMs = autoActualRuntimeMs(req, village);
                    const until = now + runtimeMs;
                    earliestReturn = Math.min(earliestReturn, until);
                    busyEntries.push([autoBusyKey(req.village_id, req.option_id), until]);
                }

                if (AUTO.mode === 'live') {
                    const violations = autoFinalRuntimeGuard(squadRequests, villages, times);
                    if (violations.length) {
                        const worst = violations
                            .sort((a,b) => b.runtimeMs - a.runtimeMs)[0];
                        const actual = safetyRuntimeLabel(worst.runtimeMs / 3600000);
                        const limit = safetyRuntimeLabel(worst.limitHours);
                        throw new Error(`Laufzeit-Schutz hat ${violations.length} Auftrag/-aufträge blockiert. Längster Auftrag ${actual}, erlaubt ${limit}. Es wurde NICHT gesendet.`);
                    }
                    await autoSendRequests(squadRequests);
                }

                // Erst nach erfolgreichem Versand bzw. in der Simulation als belegt merken.
                for (const [key, until] of busyEntries) AUTO.busy.set(key, until);
                AUTO.launched += squadRequests.length;
                const returnText = Number.isFinite(earliestReturn)
                    ? new Date(earliestReturn).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'})
                    : '—';
                const verb = AUTO.mode === 'live' ? 'wurden jetzt gestartet' : 'wären jetzt gestartet worden';
                autoLog(`${squadRequests.length} Sammelauftrag/-aufträge ${verb} · ${byVillage.size} Dörfer · ${reducedVillages} Dorf/Dörfer mit Kategorie-Fallback · ${bundledVillages} Dorf/Dörfer gebündelt · früheste Rückkehr ${returnText}.`);
            }

            const occupied = AUTO.busy.size;
            const occupiedLabel = AUTO.mode === 'live'
                ? `unterwegs lokal/server: ${occupied}/${occupied}`
                : `simuliert unterwegs: ${occupied}`;
            autoLog(`Status · Dörfer ${villages.length} · frei geprüft ${freeTotal} · geplant ${plannedTotal} · gebündelt ${bundledVillages} · ${occupiedLabel}`);
            autoUpdateStatus();
            autoSchedule(autoNextDelay());
        } catch (error) {
            console.error('[MassScavenge+ Automate]', error);
            autoLog(`Fehler beim Aktualisieren: ${error.message}`);
            if (AUTO.mode === 'live') {
                autoLog('🛑 Echter Autopilot aus Sicherheitsgründen gestoppt. Es wird NICHT automatisch erneut gesendet.');
                autoStop(true);
            } else {
                autoSchedule(AUTO.fallbackDelayMs);
            }
        } finally {
            AUTO.cycleRunning = false;
        }
    }



    function autoStart(mode = 'sim') {
        try {
            if (AUTO.running) {
                autoLog('Start abgelehnt: Automate läuft bereits.');
                return;
            }

            AUTO.mode = mode === 'live' ? 'live' : 'sim';
            readFormIntoConfig();

            // Automate verwaltet die Kategorien selbst.
            config.categories = [true, true, true, true];

            const times = getEffectiveTimes();
            const validation = validateForm(times);
            if (validation) {
                autoLog(`❌ Start nicht möglich: ${validation}`);
                autoUpdateStatus('Start blockiert');
                notifyError(validation);
                return;
            }

            // Genau einmal beim Start auf ein konkretes Datum einfrieren.
            // Danach kann aus „Heute 22:30“ niemals nach Mitternacht
            // automatisch „neues Heute 22:30“ werden.
            const frozenDeadline = autoFreezeDeadlinesAtStart();
            if (frozenDeadline.stopAt <= parseServerDate()) {
                autoLog(`❌ Start nicht möglich: Die gewählte Autopilot-Endzeit ${autoFormatDeadline(frozenDeadline.stopAt)} ist bereits erreicht.`);
                autoUpdateStatus('Deadline bereits erreicht');
                notifyError('Die gewählte Autopilot-Deadline ist bereits erreicht.');
                return;
            }

            const beginRun = function () {
                try {
                    AUTO.running = true;
                    AUTO.busy.clear();
                    AUTO.serverBusyUntil = [];
                    AUTO.serverReturnByVillage = new Map();
                    AUTO.waitingVillages = new Map();
                    AUTO.log = [];
                    AUTO.startedAt = Date.now();
                    AUTO.cycles = 0;
                    AUTO.launched = 0;
                    AUTO.sentGroups = 0;
                    AUTO.droppedCategories = 0;
                    AUTO.runtimeClamped = 0;
                    AUTO.runtimeRejected = 0;

                    clearInterval(AUTO.statusTimer);
                    AUTO.statusTimer = setInterval(() => autoUpdateStatus(), 1000);

                    $('#mspAutoSimStart,#mspAutoLiveStart').prop('disabled', true);
                    $('#mspAutoStop').prop('disabled', false);
                    autoUpdateStatus('startet …');

                    if (AUTO.mode === 'live') {
                        autoLog('🔴 Echter Autopilot gestartet. Sammelaufträge werden automatisch gesendet.');
                        autoLog('🛡 Sicherheitsmodus aktiv: direkt vor jedem Versand wird frisch neu geplant; bei unklarer Serverantwort stoppt der Autopilot.');
                    } else {
                        autoLog('Simulation gestartet. Es werden KEINE echten Sammelaufträge gesendet.');
                    }

                    if (AUTO.planMode === 'runtime') {
                        autoLog(`⏱ Planungsmodus Laufzeit · Off ${safetyRuntimeLabel(AUTO.runtimeOffHours)} · Def ${safetyRuntimeLabel(AUTO.runtimeDefHours)} · harte Maximaldauer je Raubzug ${safetyRuntimeLabel(AUTO.maxRaidHours)}.`);
                    } else {
                        autoLog(`⏰ Rückkehrgrenze eingefroren · Off ${autoFormatDeadline(AUTO.deadlineOffAt)} · Def ${autoFormatDeadline(AUTO.deadlineDefAt)} · zusätzlich max. ${safetyRuntimeLabel(AUTO.maxRaidHours)} je Raubzug.`);
                    }
                    autoLog(`🛑 Autopilot läuft bis ${autoFormatDeadline(AUTO.stopDeadlineAt)} und startet danach keine neuen Aufträge mehr.`);

                    autoCycle();
                } catch (error) {
                    console.error('[MassScavenge+ Automate Begin]', error);
                    AUTO.running = false;
                    $('#mspAutoSimStart,#mspAutoLiveStart').prop('disabled', false);
                    $('#mspAutoStop').prop('disabled', true);
                    const message = error?.message || String(error);
                    autoLog(`❌ Startfehler: ${message}`);
                    autoUpdateStatus('Startfehler');
                    try { notifyError(`Autopilot konnte nicht gestartet werden: ${message}`); } catch (_) {}
                }
            };

            if (AUTO.mode === 'live') {
                if (!confirmExtremeRuntime(times, 'Autopilot')) {
                    autoLog('Echter Autopilot wurde bei der Laufzeitwarnung abgebrochen.');
                    return;
                }

                // Kein zusätzlicher Bestätigungsdialog mehr: Klick auf „Autopilot starten“
                // startet nach den normalen Validierungs-/Laufzeitprüfungen direkt.
                beginRun();
                return;
            }

            beginRun();
        } catch (error) {
            console.error('[MassScavenge+ Automate Start]', error);
            const message = error?.message || String(error);
            autoLog(`❌ Startfehler: ${message}`);
            autoUpdateStatus('Startfehler');
            try { notifyError(`Autopilot konnte nicht gestartet werden: ${message}`); } catch (_) {}
            AUTO.running = false;
            $('#mspAutoSimStart,#mspAutoLiveStart').prop('disabled', false);
            $('#mspAutoStop').prop('disabled', true);
        }
    }

    function autoStop(fromError = false) {
        const runtime = AUTO.startedAt ? autoDuration(Date.now() - AUTO.startedAt) : '00:00:00';
        const wasRunning = AUTO.running;
        const mode = AUTO.mode;
        AUTO.running = false;
        clearTimeout(AUTO.timer);
        clearInterval(AUTO.statusTimer);
        AUTO.statusTimer = null;
        AUTO.timer = null;
        $('#mspAutoSimStart,#mspAutoLiveStart').prop('disabled', false);
        $('#mspAutoStop').prop('disabled', true);
        $('#mspAutoState').text(`⏹ Gestoppt · ⏱ ${runtime} · 🚀 ${AUTO.launched} · 🔄 ${AUTO.cycles}`);
        $('#mspAutoNext').text('Nächster Check: —');
        if (wasRunning && !fromError) {
            const label = mode === 'live' ? 'Echter Autopilot' : 'Simulation';
            autoLog(`${label} gestoppt · Laufzeit ${runtime} · ${AUTO.launched} Sammelaufträge ${mode === 'live' ? 'gesendet' : 'simuliert'} · ${AUTO.cycles} Zyklen · ${AUTO.droppedCategories} Kategorien durch Fallback entfernt.`);
        }

        AUTO.deadlineOffAt = 0;
        AUTO.deadlineDefAt = 0;
        AUTO.stopDeadlineAt = 0;
        AUTO.deadlineLabel = '';
    }

    async function autoCopyLog() {
        const text = AUTO.log.join('\n');
        try {
            await navigator.clipboard.writeText(text);
            notifySuccess('Automate-Protokoll kopiert.');
        } catch (_) {
            const ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
            notifySuccess('Automate-Protokoll kopiert.');
        }
    }

    function applyAutomateSlimUi() {
        const root = $(`#${APP.id}`);
        if (!root.length) return;

        // In Automate entscheidet das Script selbst über die Sammelkategorien
        // und berechnet/versendet im eigenen Zyklus; Simulation und Live-Modus teilen dieselbe Planung.
        $('#mspCategoriesPanel').remove();
        $('#mspCalculatePanel').remove();
        $('#mspPreviewPanel').remove();
        $('#mspAnalysisPanel').remove();
        $('#mspQuickModal').remove();

        // Symbolnamen ersetzen die alte technische Nummerierung.
        $('#mspTroopsPanel > .msp-panel-title').first().contents().first()[0].textContent = '👥 Truppen & Reserven ';
        $('#mspDistributionPanel > .msp-panel-title').first().contents().first()[0].textContent = '⚖️ Verteilung ';
        $('#mspTimePanel > .msp-panel-title').first().contents().first()[0].textContent = '🕰️ Zeitsteuerung ';
        $('#mspVillagesPanel > .msp-panel-title').first().contents().first()[0].textContent = '🏠 Dörfer ';

        // Zeitsteuerung bewusst nach oben.
        $('#mspTimePanel').insertBefore($('#mspTroopsPanel'));

        $('#mspVillageSummary').html('<span class="msp-village-chip">Automate lädt die Dörfer bei jedem Zyklus frisch. Die optionale Dorfwahl bleibt erhalten.</span>');
        $('#mspStatusCategories').text('Kategorien: automatisch');
        updateDistributionPanelTitle();
    }


    function renderAutoStopQuickButtons() {
        const box = $('#mspAutoStopQuickButtons');
        if (!box.length) return;
        box.empty();

        (config.stopQuickButtons || []).forEach((item, index) => {
            box.append($('<button>', {
                type: 'button',
                class: 'msp-btn msp-btn-secondary msp-auto-stop-preset',
                text: item.label,
                'data-index': index,
                title: 'Autopilot-Endzeit setzen'
            }));
        });
    }

    function openAutoStopQuickSettingsModal() {
        $('#mspAutoStopQuickModal').remove();
        let draft = (config.stopQuickButtons || []).map(item => ({ ...item }));

        const renderRows = () => {
            const grid = $('#mspAutoStopQuickGrid');
            if (!grid.length) return;

            const rows = draft.map((item, index) => `
                <div class="msp-q-order" style="display:flex;gap:2px;align-items:center;justify-content:center;">
                    <button type="button" class="msp-auto-stop-q-up" data-index="${index}" title="Nach oben" ${index === 0 ? 'disabled' : ''}>↑</button>
                    <button type="button" class="msp-auto-stop-q-down" data-index="${index}" title="Nach unten" ${index === draft.length - 1 ? 'disabled' : ''}>↓</button>
                </div>
                <input type="text" class="msp-auto-stop-q-label" data-index="${index}" maxlength="24" placeholder="Buttonname" title="Frei wählbarer Buttonname" value="${escapeHtml(item.label)}">
                <select class="msp-auto-stop-q-type" data-index="${index}">
                    <option value="hours" ${item.type === 'hours' ? 'selected' : ''}>+X Stunden</option>
                    <option value="today" ${item.type === 'today' ? 'selected' : ''}>Heute um</option>
                    <option value="tomorrow" ${item.type === 'tomorrow' ? 'selected' : ''}>Morgen um</option>
                    <option value="next" ${item.type === 'next' ? 'selected' : ''}>Nächster Zeitpunkt</option>
                </select>
                <input type="${item.type === 'hours' ? 'number' : 'time'}"
                    class="msp-auto-stop-q-value" data-index="${index}"
                    ${item.type === 'hours' ? 'min="0.1" step="0.1"' : ''}
                    value="${escapeHtml(String(item.value))}">
                <button type="button" class="msp-auto-stop-q-delete" data-index="${index}" title="Button entfernen">×</button>
            `).join('');

            grid.html(`
                <div class="msp-quick-settings-head">↕</div>
                <div class="msp-quick-settings-head">Buttonname</div>
                <div class="msp-quick-settings-head">Logik</div>
                <div class="msp-quick-settings-head">Wert</div>
                <div></div>
                ${rows}
            `);
        };

        const modal = $(`
            <div id="mspAutoStopQuickModal" class="msp-quick-modal-overlay">
                <div class="msp-modal-box" style="max-width:620px;">
                    <div class="msp-modal-head">
                        <span>Autopilot-Schnellbuttons einstellen</span>
                        <button class="msp-btn msp-btn-danger msp-btn-icon" id="mspAutoStopQuickClose">✕</button>
                    </div>
                    <div class="msp-modal-body">
                        <p style="margin-top:0;font-size:11px;">
                            Diese Buttons ändern <b>nur das Autopilot-Ende</b> und sind unabhängig von den normalen Laufzeit-/Rückkehr-Schnellbuttons. Den <b>Buttonnamen</b> kannst du frei vergeben.
                        </p>
                        <div class="msp-quick-settings-grid msp-auto-stop-quick-grid" id="mspAutoStopQuickGrid"></div>
                        <div class="msp-q-add-row">
                            <button class="msp-btn msp-btn-secondary" id="mspAutoStopQuickAdd" type="button">+ Button hinzufügen</button>
                            <button class="msp-btn msp-btn-secondary" id="mspAutoStopQuickDefaults" type="button">Standard</button>
                        </div>
                    </div>
                    <div class="msp-modal-foot">
                        <button class="msp-btn msp-btn-secondary" id="mspAutoStopQuickCancel" type="button">Abbrechen</button>
                        <button class="msp-btn msp-btn-primary" id="mspAutoStopQuickSave" type="button">Speichern</button>
                    </div>
                </div>
            </div>
        `).appendTo('body');

        const readRow = index => {
            if (!draft[index]) return;
            const type = String($(`.msp-auto-stop-q-type[data-index="${index}"]`).val() || 'hours');
            draft[index] = {
                label: String($(`.msp-auto-stop-q-label[data-index="${index}"]`).val() || '').trim(),
                type,
                value: String($(`.msp-auto-stop-q-value[data-index="${index}"]`).val() || '')
            };
        };

        renderRows();

        modal.on('input change', '.msp-auto-stop-q-label,.msp-auto-stop-q-value', function () {
            readRow(Number($(this).data('index')));
        });

        modal.on('change', '.msp-auto-stop-q-type', function () {
            const index = Number($(this).data('index'));
            readRow(index);
            if (draft[index]) {
                draft[index].value = draft[index].type === 'hours' ? '2' : '22:30';
                if (!draft[index].label) draft[index].label = draft[index].type === 'hours' ? '+2h' : '22:30';
            }
            renderRows();
        });

        modal.on('click', '.msp-auto-stop-q-up,.msp-auto-stop-q-down', function () {
            const index = Number($(this).data('index'));
            if (!Number.isInteger(index) || !draft[index]) return;
            const target = index + ($(this).hasClass('msp-auto-stop-q-up') ? -1 : 1);
            if (target < 0 || target >= draft.length) return;
            [draft[index], draft[target]] = [draft[target], draft[index]];
            renderRows();
        });

        modal.on('click', '.msp-auto-stop-q-delete', function () {
            const index = Number($(this).data('index'));
            if (!Number.isInteger(index) || !draft[index]) return;
            draft.splice(index, 1);
            renderRows();
        });

        $('#mspAutoStopQuickAdd').on('click', function () {
            if (draft.length >= 12) return notifyError('Maximal 12 Autopilot-Schnellbuttons sind möglich.');
            draft.push({ label: '+2h', type: 'hours', value: '2' });
            renderRows();
        });

        $('#mspAutoStopQuickDefaults').on('click', function () {
            draft = defaultConfig().stopQuickButtons.map(item => ({ ...item }));
            renderRows();
        });

        $('#mspAutoStopQuickClose,#mspAutoStopQuickCancel').on('click', () => modal.remove());

        $('#mspAutoStopQuickSave').on('click', function () {
            // v1.3.6: aktuelle Eingabefelder vor dem Speichern vollständig übernehmen.
            draft.forEach((item, index) => {
                const label = String($(`.msp-auto-stop-q-label[data-index="${index}"]`).val() || '').trim();
                const type = String($(`.msp-auto-stop-q-type[data-index="${index}"]`).val() || item.type || 'hours');
                const value = String($(`.msp-auto-stop-q-value[data-index="${index}"]`).val() || item.value || '');
                draft[index] = {
                    ...item,
                    label: label || item.label || (type === 'hours' ? '+2h' : 'Zeit'),
                    type,
                    value
                };
            });
            draft.forEach((_, i) => readRow(i));

            for (const item of draft) {
                if (!item.label) return notifyError('Bitte jedem Autopilot-Schnellbutton eine Bezeichnung geben.');
                if (item.type === 'hours') {
                    if (!(Number(item.value) > 0)) return notifyError('Bei „+X Stunden“ muss der Wert größer als 0 sein.');
                } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(item.value))) {
                    return notifyError('Bitte eine gültige Uhrzeit im Format HH:MM verwenden.');
                }
            }

            config.stopQuickButtons = draft.map(item => ({
                label: String(item.label).slice(0, 24),
                type: item.type,
                value: String(item.value)
            }));
            saveConfig();
            renderAutoStopQuickButtons();
            modal.remove();
            notifySuccess('Autopilot-Schnellbuttons gespeichert.');
        });
    }

    function applyAutoStopPreset(type, value) {
        serverDateMs = parseServerDate();
        const now = new Date(serverDateMs);
        let target = null;

        if (type === 'hours') {
            const hours = Number(value);
            if (!(hours > 0)) return;
            target = new Date(serverDateMs + hours * 3600000);
        } else {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) return;
            const [hour, minute] = String(value).split(':').map(Number);
            target = new Date(now);
            target.setHours(hour, minute, 0, 0);

            if (type === 'tomorrow') {
                target.setDate(target.getDate() + 1);
            } else if (type === 'next') {
                if (target.getTime() <= serverDateMs) target.setDate(target.getDate() + 1);
            } else if (type === 'today' && target.getTime() <= serverDateMs) {
                notifyError(`„Heute ${value}“ liegt bereits in der Vergangenheit.`);
                return;
            }
        }

        const parts = dateParts(target);
        $('#mspAutoStopDate').val(parts.date);
        $('#mspAutoStopTime').val(parts.time);
        localStorage.setItem('msp_automate_stop_date', parts.date);
        localStorage.setItem('msp_automate_stop_time', parts.time);
        updateAutomateDeadlineBadge();
    }

    function updateAutomateDeadlineBadge() {
        serverDateMs = parseServerDate();
        const stopAt = autoReadStopDeadlineInput();
        if (Number.isFinite(stopAt) && stopAt > serverDateMs) {
            const d = new Date(stopAt);
            const stopLabel = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
            $('#mspAutoStopSummary').text(`🛑 Stop ${stopLabel}`);
            $('#mspAutoDeadlineRemaining').text(`noch ${safetyRuntimeLabel((stopAt - serverDateMs) / 3600000)}`);
        } else {
            $('#mspAutoStopSummary').text('🛑 Stop —');
            $('#mspAutoDeadlineRemaining').text('Ende wählen');
        }
    }

    function initAutomateStopInputs() {
        serverDateMs = parseServerDate();
        let date = localStorage.getItem('msp_automate_stop_date') || '';
        let time = localStorage.getItem('msp_automate_stop_time') || '';

        let stored = parseLocalDateTime(date, time);
        if (!(stored > serverDateMs)) {
            // Als erste sinnvolle Vorgabe die aktuell eingestellte späteste Rückkehrzeit übernehmen.
            const offAt = parseLocalDateTime($('#mspOffDate').val(), $('#mspOffTime').val());
            const defAt = parseLocalDateTime($('#mspDefDate').val(), $('#mspDefTime').val());
            const candidate = Math.max(
                Number.isFinite(offAt) ? offAt : 0,
                Number.isFinite(defAt) ? defAt : 0
            );
            const fallback = candidate > serverDateMs
                ? new Date(candidate)
                : new Date(serverDateMs + 8 * 3600000);
            const parts = dateParts(fallback);
            date = parts.date;
            time = parts.time;
        }

        $('#mspAutoStopDate').val(date);
        $('#mspAutoStopTime').val(time);
        updateAutomateDeadlineBadge();
    }

    function initAutomateSimulation() {
        const root = $(`#${APP.id}`);
        if (!root.length || $('#mspAutoPanel').length) return;

        const panel = $(`
            <div class="msp-panel" id="mspAutoPanel" style="border:2px solid #8b6914;">
                <div class="msp-panel-title">
                    🤖 MassScavenge Automate v${APP.version}
                    <span class="msp-section-note">Simulation + Autopilot</span>
                </div>
                <div class="msp-panel-content">
                    <div class="msp-auto-actions">
                        <button class="msp-btn msp-btn-secondary" id="mspAutoSimStart">🧪 Simulation starten</button>
                        <button class="msp-btn msp-btn-success" id="mspAutoLiveStart">▶ Autopilot starten</button>
                        <button class="msp-btn msp-btn-danger" id="mspAutoStop" disabled>■ Stoppen</button>
                        <button class="msp-btn msp-btn-secondary" id="mspAutoCopy">📋 Protokoll kopieren</button>
                        <button class="msp-btn msp-btn-secondary" id="mspAutoDetailsToggle">▾ Details</button>
                    </div>

                    <div class="msp-auto-statusbar">
                        <div class="msp-auto-status-main">
                            <b id="mspAutoState">⚪ Bereit · ⏱ 00:00:00</b>
                            <small id="mspAutoNext">Nächster Check: —</small>
                        </div>
                        <div class="msp-auto-stat"><b id="mspAutoLaunchedStat">🚀 0</b><small>gestartet</small></div>
                        <div class="msp-auto-stat"><b id="mspAutoCycleStat">🔄 0</b><small>Zyklen</small></div>
                        <div class="msp-auto-stat"><b id="mspAutoBusyStat">📦 0</b><small>unterwegs</small></div>
                        <div class="msp-auto-stat msp-auto-bundle-stat">
                            <b>⏳ Bündeln</b>
                            <small><input id="mspAutoBundleMinutes" type="number" min="0" max="60" step="1"
                                value="${Math.round(AUTO.bundleWindowMs / 60000)}"> Min.</small>
                        </div>
                        <div class="msp-auto-stat msp-auto-stop-summary">
                            <b id="mspAutoStopSummary">🛑 Stop —</b>
                            <small id="mspAutoDeadlineRemaining">Ende wählen</small>
                        </div>
                    </div>

                    <div class="msp-auto-details">
                        <div class="msp-auto-info green">
                            <b>✓ Verteilungskern v2.9.9</b><br>
                            „Ausgeglichen“ sichert zuerst mindestens 10 Bauernhofplätze je verwendeter Kategorie und verteilt danach die übrige Tragkraft.
                        </div>
                        <div class="msp-auto-info">
                            <b>⏳ Bündelung pro Dorf</b><br>
                            Kommen weitere Kategorien innerhalb des Fensters zurück, wartet nur dieses Dorf und wird anschließend frisch neu geplant.
                        </div>
                        <div class="msp-auto-info blue">
                            <b>🛡 Live-Sicherheit</b><br>
                            Vor jedem echten Versand werden Dörfer, Kategorien und Truppen erneut geladen. Bei unklarer Antwort stoppt der Autopilot.
                        </div>
                        <div class="msp-auto-info red" style="grid-column:1/-1;">
                            <b>⏰ Zwei getrennte Zeitgrenzen</b> · „Autopilot bis“ bestimmt nur, wie lange das Script neue Aufträge starten darf. „Max. je Raubzug“ ist eine harte Obergrenze für jeden einzelnen Auftrag. Rückkehrzeiten bleiben zusätzlich als eigene Planungsgrenze bestehen.
                        </div>
                    </div>

                    <div class="msp-auto-log-head">
                        <b>📋 Protokoll</b>
                        <span>laufende Diagnose</span>
                    </div>
                    <pre id="mspAutoLog" style="height:210px;overflow:auto;white-space:pre-wrap;background:#1f1f1f;color:#eee;padding:8px;margin:0;font:11px/1.4 Consolas,monospace;"></pre>
                </div>
            </div>`);

        root.find('.msp-body').prepend(panel);

        $('#mspAutoSimStart').on('click', () => autoStart('sim'));
        $('#mspAutoLiveStart').on('click', () => autoStart('live'));
        $('#mspAutoStop').on('click', autoStop);
        $('#mspAutoCopy').on('click', autoCopyLog);

        $('#mspAutoDetailsToggle').on('click', function () {
            const open = !$('#mspAutoPanel').hasClass('msp-auto-details-open');
            $('#mspAutoPanel').toggleClass('msp-auto-details-open', open);
            $(this).text(open ? '▴ Details' : '▾ Details');
        });

        $('#mspAutoBundleMinutes').on('change input', function () {
            const minutes = Math.max(0, Math.min(60, Number($(this).val()) || 0));
            $(this).val(minutes);
            AUTO.bundleWindowMs = minutes * 60000;
            localStorage.setItem('msp_automate_bundle_minutes', String(minutes));
            if (AUTO.running) {
                autoLog(`⚙ Bündelungsfenster auf ${minutes} Min. geändert · gilt ab der nächsten frischen Planung.`);
            }
        });

        renderAutoStopQuickButtons();

        $('#mspAutoStopQuickButtons').on('click', '.msp-auto-stop-preset', function () {
            const index = Number($(this).data('index'));
            const item = config.stopQuickButtons?.[index];
            if (!item) return;
            applyAutoStopPreset(item.type, item.value);
        });

        $('#mspAutoStopQuickSettingsBtn').on('click', openAutoStopQuickSettingsModal);

        $('#mspAutoStopDate,#mspAutoStopTime').on('input change', function () {
            localStorage.setItem('msp_automate_stop_date', String($('#mspAutoStopDate').val() || ''));
            localStorage.setItem('msp_automate_stop_time', String($('#mspAutoStopTime').val() || ''));
            updateAutomateDeadlineBadge();
        });

        $('#mspAutoMaxRaidHours').on('input change', function () {
            const value = Math.max(0.1, Math.min(48, Number($(this).val()) || 4));
            $(this).val(value);
            AUTO.maxRaidHours = value;
            localStorage.setItem('msp_automate_max_raid_hours', String(value));
        });

        initAutomateStopInputs();
        updateAutomateDeadlineBadge();
    }

    function init() {
        if (!ensurePage()) return;
        serverDateMs = parseServerDate();
        readCategoryNamesFromPage();
        config = loadConfig();
        renderApp();
        applyAutomateSlimUi();
        prepareCollapsiblePanels();
        bindUiComfortEvents();
        startSafePositionGuard();
        updateTopStatus();
        startSessionTicker();
        initAutomateSimulation();
        log('gestartet', config);
    }

    init();
})();

})();
