module.exports = function(RED) {
    const EventEmitter = require('events').EventEmitter;
    require('events').EventEmitter.defaultMaxListeners = 850;
    const https = require('https');
    //const http = require('http');
    const fs = require('fs');
    const path = require('path');
    // Robust bool-tolkning (Node-RED kan ibland ge true/false som strängar)
    const vvAiIsTrue = (v) => {
        if (v === true || v === 1) return true;
        if (typeof v === 'string') {
            const s = v.trim().toLowerCase();
            return (s === 'true' || s === '1' || s === 'on' || s === 'yes');
        }
        return false;
    };
    const vvAiIsFalse = (v) => {
        if (v === false || v === 0) return true;
        if (typeof v === 'string') {
            const s = v.trim().toLowerCase();
            return (s === 'false' || s === '0' || s === 'off' || s === 'no');
        }
        return false;
    };
    const nibeData = new EventEmitter()
    const nibe = require('nibepi')
    var serialPort = "";
    var tcp_host = "";
    var tcp_port = "";
    let text = require('./language-SE.json')
    let translate = require('./translate.json')
    var series = "";
    var systems = {};
    let adjust = [];
    let hP;
    let weatherOffset = {};
    let indoorOffset = {};
    let priceOffset = {};
    let savedGraph = {};
    let savedData = {};

    // The VV-AI learning profile lives with the rest of NibePi's state, not in
    // the installed package directory. __dirname is inside the container image,
    // so the 168-hour profile was destroyed on every container recreate - and on
    // a read-only SD Pi the directory is not writable at all. /etc/nibepi is the
    // same directory the core uses for config.json and graph.json, and is already
    // a mounted volume in the Docker setup.
    const VV_AI_STORE_DIR = process.env.NIBEPI_CONFIG_DIR || '/etc/nibepi';
    const VV_AI_STORE_FILE = path.join(VV_AI_STORE_DIR, 'vv_ai_profile.json');
    // Where it used to live, for the one-time migration below. On a bare Pi this
    // path is persistent, so existing installs have a real learned profile here.
    const VV_AI_LEGACY_FILE = path.join(__dirname, 'vv_ai_profile.json');
    let vvAiMigrationChecked = false;
    let vvAiStore = null;
    let vvAiPriceCache = null; // VV-AI: prislista i RAM (ingen SD-skrivning)
    let vvLastBt6 = null;
    let vvInEvent = false;
    // BT6-inlärning: tappet mäts topp-till-botten över hela eventet.
    let vvEventStartTs = null;
    let vvEventPeak = null;     // högsta BT6 sedan senast avslutade event
    let vvEventTrough = null;   // lägsta BT6 i pågående event
    let vvEventTroughTs = null; // när bottennoteringen sattes
    let vvEventPeakTs = null;   // när BT6 senast stod på toppen
    let vvEventHourDeg = null;  // timme (0-167) -> grader tappade, för bokföringen
    let vvChargeActive = false; // pumpen laddar varmvatten just nu
    let vvChargeSettleUntil = 0;// BT6 får lugna sig så länge efter en laddning

    // Hur långt BT6 ska falla under toppen för att räknas som ett påbörjat tapp.
    // 0.3 °C räckte för att varje steg i stilleståndsförlusten skulle öppna
    // ett event: toppen följer bara BT6 uppåt, så en tank som kyls av ~0.5 °C/h
    // korsade tröskeln var 40:e minut och stängde fyra minuter senare som
    // förkastad. Vid 1.0 °C sker det var ~2:a timme i stället. Riktiga tapp
    // påverkas inte: de två första verkliga tappen mätte 9.7 och 24.0 °C, och
    // minDrop (3 °C) styr oförändrat vad som faktiskt lärs in.
    const VV_DRAW_START_DELTA = 1.0;              // °C
    // Ingen ny bottennotering på så här länge => tappet anses avslutat. Fyra
    // minuter styckade en kväll av oregelbunden förbrukning i fem bitar, alla
    // under minDrop: 23 sep föll BT6 5.3 °C på 1 h 42 min och bokfördes som
    // 1.6 + 0.6 + 0.9 + 0.4 + 1.8, varav ingenting lärdes in. Femton minuter
    // tål pauser inom samma tappomgång.
    const VV_DRAW_IDLE_CLOSE_MS = 15 * 60 * 1000;
    // BT6 har stigit så här mycket över botten => återvärmning igång, avsluta.
    const VV_DRAW_RECOVER_DELTA = 0.5;            // °C
    // Stillestånds- och cirkulationsförlust skiljs från tappning på hastighet,
    // inte på längd. Uppmätt på sex dygn: tankens egen förlust under de lugnaste
    // timmarna (03-06, 731 fönster) har medianen 0.50 °C/h, 90:e percentilen
    // 0.70 och maximum 1.20. Diskmaskinens program, som HA kunde tidsstämpla,
    // ligger på 1.65-2.1 °C/h. Tröskeln ligger i glappet.
    const VV_DRAW_MIN_RATE = 1.2;                 // °C/h
    // Egen, lägre tröskel för rebasen. Med samma värde som VV_DRAW_MIN_RATE åt
    // rebasen upp långsamma men verkliga kvällstapp innan de hann stängas.
    const VV_DRAW_REBASE_RATE = 0.9;              // °C/h
    // Hur länge ett event får krypa under VV_DRAW_REBASE_RATE innan dess origo
    // flyttas fram till nuläget i stället för att avsvalningen krediteras ett
    // senare tapp.
    const VV_DRAW_REBASE_MS = 30 * 60 * 1000;
    // Efter en laddning står BT6 kvar på laddkretsens temperatur en stund.
    // Detektionen börjar om först när den hunnit jämna ut sig.
    const VV_CHARGE_SETTLE_MS = 10 * 60 * 1000;
    // Ren säkerhetsbroms så att ett event inte kan leva hur länge som helst.
    // Gränsen var 90 min och gjorde dubbelt arbete: den användes också för att
    // förkasta stillestånd, och förkastade därmed verkliga kvällstapp som tagit
    // mer än 90 minuter. Den bedömningen görs nu på VV_DRAW_MIN_RATE.
    const VV_DRAW_MAX_MS = 360 * 60 * 1000;

    // Skyddar mot överlappande vvAiTick(): cron startar en ny tick varje minut
    // utan att invänta den förra, och alla vv*-variabler ovan är delade.
    let vvTickRunning = false;

    let vvLastAiControl = false;
    let vvManualHwMode = null;
    let vvManualHwPeriod = null;
    let vvLastManualSchedule = false; // tidsstyrning VV – tidigare läge (on/off)
    let vvManualHwPeriodSchedule = null; // cache för hw_period när tidsstyrning används


    // Dagens "sedda" timmar sparas numera till disk. Efter en omstart kan de vara
    // trasiga eller höra till ett annat datum, så normalisera innan de används.
    // Saknas eller är nyckeln ogiltig tas båda bort, vilket ger exakt det gamla
    // beteendet: dygnsskiftet initieras om utan att decaya något.
    function vvAiNormaliseSeen(store) {
        if (!store) return;
        store.meta = store.meta || {};
        const m = store.meta;
        if (typeof m.vvAiSeenTodayKey !== 'string' ||
            !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(m.vvAiSeenTodayKey)) {
            delete m.vvAiSeenTodayKey;
            delete m.vvAiSeenToday;
            return;
        }
        if (!Array.isArray(m.vvAiSeenToday) || m.vvAiSeenToday.length !== 168) {
            m.vvAiSeenToday = new Array(168).fill(false);
        } else {
            m.vvAiSeenToday = m.vvAiSeenToday.map((v) => v === true);
        }
    }

    function ensureVvAiStore() {
        // One-time migration from the old location. Only runs when the new file is
        // absent, so it never overwrites a profile already learned at the new path.
        // The old file is left in place as a fallback rather than deleted - on a
        // read-only SD card the delete would fail anyway.
        if (!vvAiMigrationChecked) {
            vvAiMigrationChecked = true;
            try {
                if (VV_AI_LEGACY_FILE !== VV_AI_STORE_FILE &&
                    !fs.existsSync(VV_AI_STORE_FILE) && fs.existsSync(VV_AI_LEGACY_FILE)) {
                    const legacy = fs.readFileSync(VV_AI_LEGACY_FILE, 'utf8');
                    const parsed = JSON.parse(legacy);
                    if (parsed && Array.isArray(parsed.profile) && parsed.profile.length === 168) {
                        fs.writeFileSync(VV_AI_STORE_FILE, legacy, 'utf8');
                        nibe.log(`VV-AI: flyttade inlarningsprofilen till ${VV_AI_STORE_FILE}`, 'hotwater', 'info');
                    }
                }
            } catch (err) {
                nibe.log(`VV-AI migration error: ${err}`, 'hotwater', 'error');
            }
        }
        if (vvAiStore && Array.isArray(vvAiStore.profile) && vvAiStore.profile.length === 168) {
            if (!Array.isArray(vvAiStore.tempPlan) || vvAiStore.tempPlan.length !== 168) {
                vvAiStore.tempPlan = new Array(168).fill(0);
            }
            if (!Array.isArray(vvAiStore.modePlan) || vvAiStore.modePlan.length !== 168) {
                vvAiStore.modePlan = new Array(168).fill(0);
            }
            vvAiStore.meta = vvAiStore.meta || {};
            vvAiNormaliseSeen(vvAiStore);
            return vvAiStore;
        }
        try {
            const raw = fs.readFileSync(VV_AI_STORE_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.profile) && parsed.profile.length === 168) {
                vvAiStore = parsed;
                if (!Array.isArray(vvAiStore.tempPlan) || vvAiStore.tempPlan.length !== 168) {
                    vvAiStore.tempPlan = new Array(168).fill(0);
                }
                if (!Array.isArray(vvAiStore.modePlan) || vvAiStore.modePlan.length !== 168) {
                    vvAiStore.modePlan = new Array(168).fill(0);
                }
                vvAiStore.meta = vvAiStore.meta || {};
                vvAiNormaliseSeen(vvAiStore);
                return vvAiStore;
            }
        } catch (err) {
            nibe.log(`VV-AI load error: ${err}`, 'hotwater', 'error');
        }
        vvAiStore = {
            profile: new Array(168).fill(0),
            tempPlan: new Array(168).fill(0),
            modePlan: new Array(168).fill(0),
            meta: {}
        };
        try {
            fs.writeFileSync(VV_AI_STORE_FILE, JSON.stringify(vvAiStore, null, 2), 'utf8');
        } catch (err) {
            nibe.log(`VV-AI init save error: ${err}`, 'hotwater', 'error');
        }
        return vvAiStore;
    }


    // Bygger ett 48h-prisfönster för VV-AI utifrån vvAiPriceCache.
    // Resultat: array med objekt { ts, price_ore } sorterad på stigande ts.
    function vvAiBuildPriceHorizon(tsNow, priceCache) {
        try {
            if (!priceCache || !Array.isArray(priceCache) || priceCache.length === 0) {
                return null;
            }
            const start = new Date(tsNow);
            start.setHours(0, 0, 0, 0);
            const startMs = start.getTime();
            const endMs = startMs + 48 * 3600 * 1000;

            const window = [];
            for (const p of priceCache) {
                if (!p || !p.startsAt) continue;
                const t = new Date(p.startsAt).getTime();
                if (!Number.isFinite(t)) continue;
                if (t < startMs || t > endMs) continue;
                const total = Number(p.total);
                if (!Number.isFinite(total)) continue;
                const priceOre = Number((total * 100).toFixed(2)); // SEK/kWh -> öre/kWh
                window.push({ ts: t, price_ore: priceOre });
            }

            if (window.length === 0) {
                return null;
            }
            window.sort((a, b) => a.ts - b.ts);
            return window;
        } catch (e) {
            // Om något går fel här vill vi inte störa övrig VV-AI-logik.
            return null;
        }
    }



    // Skrivningen är asynkron och kan numera triggas flera gånger i samma tick
    // (inlärt tapp + dygnsskifte). Två parallella fs.writeFile mot samma fil kan
    // ge en trasig JSON, så skrivningarna serialiseras och görs atomiskt.
    let vvAiWriteInFlight = false;
    let vvAiWritePending = false;

    function saveVvAiStore(force) {
        if (!vvAiStore) return;
        try {
            vvAiStore.meta = vvAiStore.meta || {};
            const now = Date.now();
            const last = (vvAiStore.meta && typeof vvAiStore.meta.lastSaveTs === 'number')
                ? vvAiStore.meta.lastSaveTs
                : 0;

            // Spara som mest en gång per timme för att undvika att blockera Node-RED varje minut.
            // force=true används när ett inlärt tapp just skrivits in i profilen – den
            // skrivningen får inte tappas bort om containern startas om inom timmen.
            if (!force && now - last < 60 * 60 * 1000) {
                return;
            }
            if (vvAiWriteInFlight) {
                // Skriv om så fort den pågående skrivningen är klar.
                vvAiWritePending = true;
                return;
            }
            vvAiStore.meta.lastSaveTs = now;

            // Bygg ett persist-objekt utan kortlivade/pris-relaterade meta-fält.
            const persist = {
                profile: (Array.isArray(vvAiStore.profile) && vvAiStore.profile.length === 168)
                    ? vvAiStore.profile
                    : new Array(168).fill(0),
                tempPlan: (Array.isArray(vvAiStore.tempPlan) && vvAiStore.tempPlan.length === 168)
                    ? vvAiStore.tempPlan
                    : new Array(168).fill(0),
                modePlan: (Array.isArray(vvAiStore.modePlan) && vvAiStore.modePlan.length === 168)
                    ? vvAiStore.modePlan
                    : new Array(168).fill(0),
                meta: {}
            };

            const srcMeta = vvAiStore.meta || {};
            // vvAiSeenTodayKey/vvAiSeenToday MÅSTE överleva en omstart. Utan dem
            // nollställs dagens sedda timmar, och vid nästa dygnsskifte decayas
            // timmar som faktiskt hade tapp. lastDecayKey gör skiftet spårbart.
            const keepMetaKeys = [
                'lastPlanBuild', 'lastLearnTs', 'lastDropDeg', 'lastIndex',
                'vvAiSeenTodayKey', 'vvAiSeenToday', 'lastDecayKey', 'lastDecayTs'
            ];
            for (const key of keepMetaKeys) {
                if (Object.prototype.hasOwnProperty.call(srcMeta, key)) {
                    persist.meta[key] = srcMeta[key];
                }
            }

            // Skriv till temporärfil och byt namn: rename i samma katalog är atomiskt,
            // så en omstart mitt i en skrivning aldrig lämnar en halv profil på disk.
            const tmpFile = VV_AI_STORE_FILE + '.tmp';
            vvAiWriteInFlight = true;
            fs.writeFile(tmpFile, JSON.stringify(persist, null, 2), 'utf8', (err) => {
                if (err) {
                    vvAiWriteInFlight = false;
                    vvAiWritePending = false;
                    nibe.log(`VV-AI store write error: ${err}`, 'hotwater', 'error');
                    return;
                }
                fs.rename(tmpFile, VV_AI_STORE_FILE, (err2) => {
                    vvAiWriteInFlight = false;
                    if (err2) {
                        nibe.log(`VV-AI store rename error: ${err2}`, 'hotwater', 'error');
                    }
                    if (vvAiWritePending) {
                        vvAiWritePending = false;
                        saveVvAiStore(true);
                    }
                });
            });
        } catch (err) {
            nibe.log(`VV-AI store save error: ${err}`, 'hotwater', 'error');
        }
    }
    function getVvAlpha(hw) {
        let rate = Number(hw.vv_ai_learning_rate);
        const useSlider = (hw.vv_ai_learning_rate_enable === true);
        if (!useSlider || !Number.isFinite(rate) || rate <= 0) {
            rate = 10;
        }
        if (rate < 1) rate = 1;
        if (rate > 10) rate = 10;
        return rate / 100;
    }

    function vvAiPad2(n) { return String(n).padStart(2, '0'); }
    function vvAiLocalDateKeyFromTs(ts) {
        const d = new Date(ts);
        return `${d.getFullYear()}-${vvAiPad2(d.getMonth() + 1)}-${vvAiPad2(d.getDate())}`;
    }

    function vvAiApplyDailyDecayIfNeeded(store, hw, newKey) {
            if (!store) return;
            store.meta = store.meta || {};
            const meta = store.meta;

            // Hjälpare: YYYY-MM-DD → lokal Date (midnatt lokal tid)
            function vvAiDateKeyToLocalDate(key) {
                if (typeof key !== 'string') return null;
                const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(key.trim());
                if (!m) return null;
                const y = Number(m[1]);
                const mo = Number(m[2]);
                const d = Number(m[3]);
                if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
                const dt = new Date(y, mo - 1, d);
                if (!dt || isNaN(dt.getTime())) return null;
                return dt;
            }

            function vvAiApplyDecayForLocalDate(dt, seenArr, decayFactor) {
                if (!dt || isNaN(dt.getTime())) return;

                // Veckodag för denna kalenderdag → index i profilen (måndag=0)
                let dow = dt.getDay(); // 0=sön .. 6=lör
                const dayIndex = (dow + 6) % 7; // 0=mån .. 6=sön
                const startIdx = dayIndex * 24;
                const endIdx = startIdx + 24;

                const seen = (Array.isArray(seenArr) && seenArr.length === 168)
                    ? seenArr
                    : new Array(168).fill(false);

                if (Array.isArray(store.profile) && store.profile.length === 168) {
                    for (let i = startIdx; i < endIdx; i++) {
                        if (!seen[i]) {
                            const oldVal = Number(store.profile[i]) || 0;
                            const decayed = oldVal * decayFactor;
                            store.profile[i] = Number(decayed.toFixed(3));
                        }
                    }
                }
            }

            // init
            if (!meta.vvAiSeenTodayKey) {
                meta.vvAiSeenTodayKey = newKey;
                meta.vvAiSeenToday = new Array(168).fill(false);
                return;
            }

            if (meta.vvAiSeenTodayKey === newKey) {
                // samma dag – inget att göra här
                if (!Array.isArray(meta.vvAiSeenToday) || meta.vvAiSeenToday.length !== 168) {
                    meta.vvAiSeenToday = new Array(168).fill(false);
                }
                return;
            }

            // Ny dag: decaya ENDAST den gamla dagens 24 slots (veckodag*24..+23) som inte setts.
            const alpha = getVvAlpha(hw || {});
            const decayFactor = 1 - alpha; // ex: alpha=0.05 => 5% per "passerad dag" på ej använda timmar

            const seenOld = (Array.isArray(meta.vvAiSeenToday) && meta.vvAiSeenToday.length === 168)
                ? meta.vvAiSeenToday
                : new Array(168).fill(false);

            const oldKey = meta.vvAiSeenTodayKey;
            const oldDate = vvAiDateKeyToLocalDate(oldKey);
            const newDate = vvAiDateKeyToLocalDate(newKey);

            if (!oldDate || !newDate) {
                // Fallback: om datum inte går att tolka, kör gamla beteendet (decay på alla 168 unseen)
                if (Array.isArray(store.profile) && store.profile.length === 168) {
                    for (let i = 0; i < 168; i++) {
                        if (!seenOld[i]) {
                            const oldVal = Number(store.profile[i]) || 0;
                            const decayed = oldVal * decayFactor;
                            store.profile[i] = Number(decayed.toFixed(3));
                        }
                    }
                }
            } else {
                // 1) Decay för dagen som just avslutades (oldKey) – endast 24 slots för den veckodagen
                vvAiApplyDecayForLocalDate(oldDate, seenOld, decayFactor);

                // 2) Om vi hoppat över dagar (t.ex. systemet stod still): decaya varje missad kalenderdag en gång
                //    (ingen "seen"-info finns för missade dagar, så de räknas som osedda)
                const d = new Date(oldDate.getTime());
                d.setDate(d.getDate() + 1);

                let guard = 0; // säkerhetsbroms
                while (d.getTime() < newDate.getTime() && guard < 32) {
                    vvAiApplyDecayForLocalDate(d, null, decayFactor);
                    d.setDate(d.getDate() + 1);
                    guard++;
                }
            }

            // reset för nya dagen
            meta.vvAiSeenTodayKey = newKey;
            meta.vvAiSeenToday = new Array(168).fill(false);
            meta.lastDecayKey = newKey;
            meta.lastDecayTs = Date.now();

            // Skriv igenom direkt. Annars ligger dygnsskiftet bara i RAM tills nästa
            // timvisa sparning, och en omstart däremellan skulle läsa det gamla datumet
            // och decaya samma dygn en gång till.
            saveVvAiStore(true);
        }

function vvAiMarkSeenToday(store, hw, idx, ts) {
            if (!store || !Number.isInteger(idx) || idx < 0 || idx >= 168) return;
            store.meta = store.meta || {};
            const key = vvAiLocalDateKeyFromTs(ts || Date.now());
            vvAiApplyDailyDecayIfNeeded(store, hw, key);
            if (!Array.isArray(store.meta.vvAiSeenToday) || store.meta.vvAiSeenToday.length !== 168) {
                store.meta.vvAiSeenToday = new Array(168).fill(false);
            }
            store.meta.vvAiSeenToday[idx] = true;
        }

    function getVvMinDrop(hw) {
        const useSlider = (hw.vv_ai_min_drop_bt6_enable === true);
        let d = Number(hw.vv_ai_min_drop);
        // Om slidern inte är aktiv eller värdet är ogiltigt/<=0 → använd backend-standard 3°C
        if (!useSlider || !Number.isFinite(d) || d <= 0) {
            d = 3; // default 3 °C
        }
        return d;
    }

    function getWeekHourIndex(ts) {
        const d = new Date(ts);
        const dow = d.getDay(); // 0=sun .. 6=sat
        const dayIndex = (dow + 6) % 7; // 0=mon..6=sun
        const hour = d.getHours();
        return dayIndex * 24 + hour; // 0..167
    }

    function registerVvDraw(cfgHotwater, dropDeg, ts) {
        if (!Number.isFinite(dropDeg) || dropDeg <= 0.1) {
            return;
        }
        const store = ensureVvAiStore();
        const idx = getWeekHourIndex(ts);
        vvAiMarkSeenToday(store, cfgHotwater || {}, idx, ts);
        if (!Array.isArray(store.profile) || store.profile.length !== 168) {
            store.profile = new Array(168).fill(0);
        }
        const alpha = getVvAlpha(cfgHotwater || {});
        const oldVal = Number(store.profile[idx]) || 0;
        const measurement = dropDeg;
        const blended = oldVal * (1 - alpha) + measurement * alpha;
        store.profile[idx] = Number(blended.toFixed(3));
        store.meta = store.meta || {};
        store.meta.lastLearnTs = ts;
        store.meta.lastDropDeg = dropDeg;
        store.meta.lastIndex = idx;
        saveVvAiStore(true);
    }


    // Väljer den timme under eventet då FLEST grader faktiskt drogs, och
    // returnerar en tidsstämpel i den. Tappet bokfördes tidigare på timmen då
    // botten nåddes, men när ett event spänner över en hel tappomgång ligger
    // botten typiskt en timme efter förbrukningen - och planeraren värmer FÖRE
    // peaktimmen, så en timme för sent är värre än ett för litet värde. Mot sex
    // dygns HA-data återger den här regeln timmarna 19, 21, 69, 104 och 108 som
    // den gamla koden hittade, medan bottentimmen sköt dem till 20, 22 och 32.
    function vvSteepestHourTs(fallbackTs) {
        if (!vvEventHourDeg) {
            return fallbackTs;
        }
        let bestTs = null;
        let bestDeg = -1;
        for (const key of Object.keys(vvEventHourDeg)) {
            const slot = vvEventHourDeg[key];
            if (slot && slot.deg > bestDeg) {
                bestDeg = slot.deg;
                bestTs = slot.ts;
            }
        }
        return (bestTs === null) ? fallbackTs : bestTs;
    }

    // Stänger och utvärderar ett pågående tapp-event. Bröts ut ur vvAiTick när
    // laddningsspärren behövde kunna stänga ett event mitt i: logiken får inte
    // finnas i två exemplar som kan glida isär.
    function vvCloseDrawEvent(cfgHotwater, minDrop, current, ts, why) {
        const span = vvEventPeak - vvEventTrough;
        const fallMs = ts - (vvEventPeakTs || vvEventStartTs || ts);
        const rate = fallMs > 0 ? (span / (fallMs / 3600000)) : Infinity;
        const tooSlow = rate < VV_DRAW_MIN_RATE;
        const drop = tooSlow ? 0 : span;
        const durMin = Math.round((ts - (vvEventStartTs || ts)) / 60000);
        const bt6Span = `BT6 ${vvEventPeak.toFixed(1)} → ${vvEventTrough.toFixed(1)} °C`;

        if (Number.isFinite(drop) && drop >= minDrop) {
            const learnTs = vvSteepestHourTs(vvEventTroughTs || ts);
            registerVvDraw(cfgHotwater, drop, learnTs);
            nibe.log(`VV-tapp registrerat: ${drop.toFixed(1)} °C (${bt6Span}), ` +
                `${durMin} min, ${rate.toFixed(1)} °C/h, ` +
                `timme ${getWeekHourIndex(learnTs)}/167, avslut: ${why}`,
                'hotwater', 'debug');
        } else if (tooSlow) {
            nibe.log(`VV-tapp förkastat (stillestånds-/cirkulationsförlust): ` +
                `${span.toFixed(1)} °C (${bt6Span}) på ${durMin} min ` +
                `= ${rate.toFixed(1)} °C/h < ${VV_DRAW_MIN_RATE} °C/h`,
                'hotwater', 'debug');
        } else {
            nibe.log(`VV-tapp förkastat: ${span.toFixed(1)} °C < tröskel ${minDrop} °C ` +
                `(${bt6Span}), ${durMin} min, avslut: ${why}`,
                'hotwater', 'debug');
        }

        vvInEvent = false;
        vvEventStartTs = null;
        vvEventTrough = null;
        vvEventTroughTs = null;
        vvEventHourDeg = null;
        vvEventPeak = current;
        vvEventPeakTs = ts;
    }

    // Nattspärr för VV-plan: AI-planerad värmning får aldrig ligga mellan 00:00 och 03:00.
    // (Min-temp-failsafe kan fortfarande trigga om du har den på.)
    // Delas av vvAiBuildPlan och vvAiTick.
    const VV_NIGHT_BLOCK_FROM_H = 0;
    const VV_NIGHT_BLOCK_TO_H = 3;

    async function vvAiBuildPlan(store, hw) {
        try {
            if (!store) return;
            if (!Array.isArray(store.profile) || store.profile.length !== 168) {
                return;
            }
            // Daglig decay på timmar utan event (kopplad till vv_ai_learning_rate)
            vvAiApplyDailyDecayIfNeeded(store, hw || {}, vvAiLocalDateKeyFromTs(Date.now()));
            const profile = store.profile.map(v => {
                const n = Number(v);
                return Number.isFinite(n) && n > 0 ? n : 0;
            });

            const tempPlan = new Array(168).fill(0);
            const modePlan = new Array(168).fill(0);


            const daySum = new Array(7).fill(0);
            const dayMax = new Array(7).fill(0);

            for (let i = 0; i < 168; i++) {
                const v = profile[i];

                // Räkna tidiga natt-timmar (00:00–02:00) till föregående dag
                const hour = i % 24;
                const dayRaw = Math.floor(i / 24);
                const day = (hour < 2) ? ((dayRaw + 6) % 7) : dayRaw;

                daySum[day] += v;
                if (v > dayMax[day]) dayMax[day] = v;
            }

            // Trösklar för hur "tung" dagen är (i °C BT6-drop)
            let smallThr = Number(hw.vv_ai_day_small_threshold);
            if (!Number.isFinite(smallThr) || smallThr <= 0) smallThr = 1.0;

            let mediumThr = Number(hw.vv_ai_day_medium_threshold);
            if (!Number.isFinite(mediumThr) || mediumThr <= smallThr) mediumThr = 3.0;

            let largeThr = Number(hw.vv_ai_day_large_threshold);
            if (!Number.isFinite(largeThr) || largeThr <= mediumThr) largeThr = 6.0;

            // Elprisstyrning + prisfönster (används både för plan och graf)
            const priceControlEnabled = vvAiIsTrue(hw && hw.vv_ai_use_price_enable);

            // Prisfönster: standard 7h från backend, eller användarens eget värde om vv_ai_price_window_enable = true.
            const priceWindowOverrideEnabled = vvAiIsTrue(hw && hw.vv_ai_price_window_enable);
            let priceWindowHours = 7;
            if (priceWindowOverrideEnabled) {
                let tmpHours = hw ? Number(hw.vv_ai_price_window_hours) : NaN;
                if (Number.isFinite(tmpHours) && tmpHours > 0) {
                    if (tmpHours > 24) tmpHours = 24;
                    priceWindowHours = tmpHours;
                }
            }

            // Förvärmning & fönsterlängd
            const preheatEnabled = vvAiIsTrue(hw && hw.vv_ai_preheat_enable);
            let preheatHours = Number(hw.vv_ai_preheat_hours);
            if (!Number.isFinite(preheatHours) || preheatHours < 0) preheatHours = 0;
            if (preheatHours > 12) preheatHours = 12;

            // Om preheat-switchen är AV vill vi ändå köra en standard-förvärmning
            // på 2 timmar före planerat VV-uttag. När switchen är PÅ används
            // sliderns värde (0–12 h).
            if (!preheatEnabled) {
                // När elprisstyrning är PÅ vill vi att default-preheat matchar sökfönstret,
                // annars blir prislogiken begränsad till bara de timmar som VV-planen redan täcker.
                preheatHours = 2;
            }
            // Clamp igen om vi satte defaulten ovan (priceWindowHours kan vara större än 12)
            if (preheatHours > 12) preheatHours = 12;

            // Elpris-tabell (0..167) om vvAiTick redan byggt den (annars null)
            const priceByIndex = (store && store.meta && Array.isArray(store.meta.vvPriceByIndex))
                ? store.meta.vvPriceByIndex
                : null;


            // vv_ai_heat_window_hours finns kvar för framtida bruk men
            // används inte längre för att flytta fönstret; fönstret definieras
            // av preheat (start) och peaktimmen (slut).
            let windowLen = Number(hw.vv_ai_heat_window_hours);
            if (!Number.isFinite(windowLen) || windowLen <= 0) windowLen = 1;
            if (windowLen > 8) windowLen = 8;

            // Stopptemperaturer för Eco / Normal / Lyx.
// Primär källa: vv_stop_eco/normal/lux i hw-objektet (uppdateras av vvAiTick från hP['hw_stop_0/1/2']).
// Fallback: läs direkt från Nibe om vv_stop_* saknas.
            let ecoStop = NaN;
            let normalStop = NaN;
            let luxStop = NaN;

            // 1) Läs från hw.vv_stop_* om de finns
            if (hw) {
                const tEco = Number(hw.vv_stop_eco);
                if (Number.isFinite(tEco)) ecoStop = tEco;

                const tNormal = Number(hw.vv_stop_normal);
                if (Number.isFinite(tNormal)) normalStop = tNormal;

                const tLux = Number(hw.vv_stop_lux);
                if (Number.isFinite(tLux)) luxStop = tLux;
            }

            // 2) Fallback: läs direkt från Nibe (samma index som vvAiTick: 0=Eco, 1=Normal, 2=Lux)
            if (!Number.isFinite(ecoStop)) {
                try {
                    const rEco = await getNibeData(hP['hw_stop_0']).catch(() => undefined);
                    if (rEco && typeof rEco.data === 'number' && Number.isFinite(rEco.data)) {
                        ecoStop = rEco.data;
                    }
                } catch (e) {
                    // ignorerar, ecoStop får ev. förbli NaN
                }
            }

            if (!Number.isFinite(normalStop)) {
                try {
                    const rNormal = await getNibeData(hP['hw_stop_1']).catch(() => undefined);
                    if (rNormal && typeof rNormal.data === 'number' && Number.isFinite(rNormal.data)) {
                        normalStop = rNormal.data;
                    }
                } catch (e) {
                    // ignorerar, normalStop får ev. förbli NaN
                }
            }

            if (!Number.isFinite(luxStop)) {
                try {
                    const rLux = await getNibeData(hP['hw_stop_2']).catch(() => undefined);
                    if (rLux && typeof rLux.data === 'number' && Number.isFinite(rLux.data)) {
                        luxStop = rLux.data;
                    }
                } catch (e) {
                    // ignorerar, luxStop får ev. förbli NaN
                }
            }

            // Om vi fortfarande saknar någon stopptemperatur efter fallback
            // lämnas den som NaN, och tempPlan blir då 0 för det läget.
// Min-temp-golv: används bara om vv_ai_min_temp_enable är true
            // Min-temp-golv: anses aktiverad så länge vv_ai_min_temp_enable inte är falskt.
            // (Node-RED kan skicka true, 1, "true" osv.)
            const minTempEnabled = !!(hw && hw.vv_ai_min_temp_enable !== false);
            const rawMinTemp = hw ? Number(hw.vv_ai_min_temp) : NaN;
            const minTemp = Number.isFinite(rawMinTemp) ? rawMinTemp : NaN;

            for (let day = 0; day < 7; day++) {
                const sum = daySum[day];

                // Ingen värmning alls om dagen är "nästan tom"
                if (sum < smallThr) continue;

                let dayMode = 0;
                if (sum < mediumThr) {
                    dayMode = 1; // liten dag
                } else if (sum < largeThr) {
                    dayMode = 2; // normal dag
                } else {
                    dayMode = 3; // tung dag
                }

                if (dayMode === 0) continue;

                
                const base = day * 24;

                // Hitta dagens huvud-peak (max) som tidigare
                let maxV = 0;
                let mainHour = -1;

                // Extra: hitta ev. en andra peak (för 2 uppvärmningar) baserat på profilen.
                // Användaren vill ha tröskel >3°C (inte 2°C).
                // Peak-tröskel (profilvärde per timme) för att räkna en timme som "peak-kandidat".
// Default = 3.0 (backend).
// Om vv_ai_mode_thresholds_enable=true så kan den styras via slidern vv_ai_day_peaks_threshold.
let PEAK_THR = 3.0;
if (hw && hw.vv_ai_mode_thresholds_enable) {
    const userPeakThr = Number(hw.vv_ai_day_peaks_threshold);
    if (Number.isFinite(userPeakThr) && userPeakThr > 0) {
        PEAK_THR = userPeakThr;
    }
}
                const MIN_PEAK_GAP_H = 6; // minst 6h mellan peaks för att räknas som två "tillfällen"

                const peakCandidates = [];
                // Nattspärr 00–03: om en "peak" råkar ligga på natten så väljer vi istället
                // bästa (högsta) uttags-timmen senare samma dag (06–23). Då får vi plan även om
                // användarbeteendet råkar ligga runt midnatt, utan att värma på natten.
                for (let h = 0; h < 24; h++) {
                    if (h >= VV_NIGHT_BLOCK_FROM_H && h < VV_NIGHT_BLOCK_TO_H) continue;

                    const v = profile[base + h];

                    if (v > maxV) {
                        maxV = v;
                        mainHour = h;
                    }

                    if (v >= PEAK_THR) {
                        peakCandidates.push({ h, v });
                    }
                }
if (mainHour < 0) continue;

                // Välj en andra peak: största v som ligger minst MIN_PEAK_GAP_H från huvud-peak
                let secondHour = -1;
                let secondV = -1;

                for (const p of peakCandidates) {
                    if (p.h === mainHour) continue;
                    if (Math.abs(p.h - mainHour) < MIN_PEAK_GAP_H) continue;
                    if (p.v > secondV) {
                        secondV = p.v;
                        secondHour = p.h;
                    }
                }

                // Om vi hittar två tydliga peaks samma dag:
                // då vill användaren INTE köra Lyx – clamp:a max till Normal (2).
                if (secondHour >= 0 && dayMode === 3) {
                    dayMode = 2;
                }

                const ph = preheatHours;

                // Bygg uppvärmningsfönster för 1 eller 2 peaks (värm fram till start av peak-timmen).
                const peakHours = (secondHour >= 0)
                    ? [mainHour, secondHour].sort((a, b) => a - b)
                    : [mainHour];

                for (const peakHour of peakHours) {
                    // Default-fönster (utan pris):
                    // Vi jobbar i 1h-buckets: timme h betyder intervallet [h, h+1).
                    // Målet är att tanken ska vara varm VID STARTEN av förväntat VV-uttag (peak-timmen),
                    // dvs vi värmer fram till peakHour (inte peakHour+1).
                    const minHeatLen = Math.max(1, ph); // minst 1h även om ph=0

                    let startHour = 0;
                    let endHour = 0;

                    if (peakHour <= 0) {
                        // Peak vid 00:00 kan inte förvärmas "före" inom samma dygn – kör minsta möjliga fönster i början av dagen.
                        startHour = 0;
                        endHour = 1;
                    } else {
                        endHour = peakHour; // SLUT = start av peak-timmen
                        startHour = peakHour - minHeatLen;
                        if (startHour < 0) startHour = 0;
                    }

                    // Om elprisstyrning är aktiv: välj en billig START inom priceWindowHours före peak,
                    // men lås alltid SLUTET till peak-start (endHour = peakHour) så planen sträcker sig hela vägen fram.
                    // Dessutom: start får aldrig bli senare än (peakHour - minHeatLen), annars hinner vi inte värma klart före peak.
                    if (priceControlEnabled && priceByIndex && peakHour > 0) {
                        const lookback = Math.max(minHeatLen, Math.floor(priceWindowHours));
                        const winStart = Math.max(0, peakHour - lookback);

                        // Sista tillåtna start så att hela blocket (minHeatLen timmar) får plats före peakHour
                        const winEnd = Math.min(Math.max(0, peakHour - minHeatLen), 23);
                        if (winEnd >= winStart) {
                            let bestStart = null;
                            let bestSum = Infinity;

                            for (let s = winStart; s <= winEnd; s++) {
                                let sum = 0;
                                let ok = true;

                                for (let k = 0; k < minHeatLen; k++) {
                                    const ore = priceByIndex[base + s + k];
                                    if (ore === null || !Number.isFinite(ore)) { ok = false; break; }
                                    sum += ore;
                                }
                                if (!ok) continue;

                                // Tie-break: om lika billigt, välj den som ligger SENARE (närmast peak)
                                if (sum < bestSum || (sum === bestSum && (bestStart === null || s > bestStart))) {
                                    bestSum = sum;
                                    bestStart = s;
                                }
                            }

                            if (bestStart !== null) {
                                startHour = bestStart;
                                endHour = Math.min(peakHour, bestStart + minHeatLen); // FIX: håll fönstret = minHeatLen
                            }
                        }
                    }

                    for (let h = startHour; h < endHour; h++) {
                        if (h >= VV_NIGHT_BLOCK_FROM_H && h < VV_NIGHT_BLOCK_TO_H) continue;
                        const idx = base + h;
                        modePlan[idx] = dayMode;
                        if (dayMode === 1 && Number.isFinite(ecoStop)) {
                            tempPlan[idx] = ecoStop;
                        } else if (dayMode === 2 && Number.isFinite(normalStop)) {
                            tempPlan[idx] = normalStop;
                        } else if (dayMode === 3 && Number.isFinite(luxStop)) {
                            tempPlan[idx] = luxStop;
                        }
                    }
                }
            }
            // Min-temp-failsafe: fyller "mellanrummen" när vv_ai_min_temp_enable = true.
            // Själva VV-fönstren (Eco/Normal/Lux) lämnas orörda.
            if (minTempEnabled && Number.isFinite(minTemp)) {
                for (let i = 0; i < 168; i++) {
                    const v = Number(tempPlan[i]);
                    if (!Number.isFinite(v) || v <= 0) {
                        tempPlan[i] = minTemp;
                    }
                }
            }

            store.tempPlan = tempPlan;
            store.modePlan = modePlan;
            store.meta = store.meta || {};
            store.meta.lastPlanBuild = Date.now();
        } catch (e) {
            nibe.log(`VV-AI plan build error: ${e}`, 'hotwater', 'error');
        }
    }


function hotwaterAiBuildGraph(store, hw) {
        try {
            if (!store) return null;

            // --- VV-AI: prisstyrning / prisfönster (behövs för att kunna bygga grafen) ---
            // OBS: Node-RED kan spara true/false som strängar, så vi använder vvAiIsTrue().
            const priceControlEnabled = vvAiIsTrue(hw && hw.vv_ai_use_price_enable);

            // Prisfönster: standard 7h, men kan styras av slider om vv_ai_price_window_enable = true.
            const priceWindowOverrideEnabled = vvAiIsTrue(hw && hw.vv_ai_price_window_enable);
            let priceWindowHours = 7;
            if (priceWindowOverrideEnabled) {
                let tmpHours = hw ? Number(hw.vv_ai_price_window_hours) : NaN;
                if (Number.isFinite(tmpHours) && tmpHours > 0) {
                    if (tmpHours > 24) tmpHours = 24;
                    priceWindowHours = tmpHours;
                }
            }

            const profile = (store && Array.isArray(store.profile) && store.profile.length === 168)
                ? store.profile
                : new Array(168).fill(0);
            const tempPlan = (store && Array.isArray(store.tempPlan) && store.tempPlan.length === 168)
                ? store.tempPlan
                : new Array(168).fill(0);
            const modePlan = (store && Array.isArray(store.modePlan) && store.modePlan.length === 168)
                ? store.modePlan
                : new Array(168).fill(0);

            const profileSeries = [];
            const tempSeries = [];
            const modeSeries = [];
            const priceSeries = [];
            // Ny serie: VV-pris (billigast) = markerar de valda uppvärmningstimmarna
            const priceWindowHeatSeries = [];

            // Tidsstyrd VV-graf: om vv_manual_schedule_enable är aktiv visar vi
            // ÖPPET fönster (VV tillåten) + valt VV-läge i stället för AI-planen.
            const scheduleEnabled = vvAiIsTrue(hw && hw.vv_manual_schedule_enable);
            const fromMin = hw && Number(hw.vv_manual_schedule_from_min);
            const toMin = hw && Number(hw.vv_manual_schedule_to_min);
            const scheduleMode = hw && Number(hw.vv_manual_schedule_mode);

            const validWindow =
                Number.isFinite(fromMin) && Number.isFinite(toMin) &&
                fromMin >= 0 && fromMin < 1440 &&
                toMin >= 0 && toMin < 1440 &&
                fromMin !== toMin;

            const scheduleGraphActive = scheduleEnabled && validWindow && Number.isFinite(scheduleMode);
            // Elprisstyrning/prisfönster är redan beräknat ovan (priceControlEnabled + priceWindowHours).
            // Stopptemperaturer för Eco / Normal / Lux.
            // Primär källa: vv_stop_eco/normal/lux i hw-objektet (uppdateras av vvAiTick från hP['hw_stop_0/1/2']).
            let stopEco = NaN;
            let stopNormal = NaN;
            let stopLux = NaN;

            if (hw) {
                const tEco = Number(hw.vv_stop_eco);
                if (Number.isFinite(tEco)) stopEco = tEco;

                const tNormal = Number(hw.vv_stop_normal);
                if (Number.isFinite(tNormal)) stopNormal = tNormal;

                const tLux = Number(hw.vv_stop_lux);
                if (Number.isFinite(tLux)) stopLux = tLux;
            }

            // Bygg en 168-längds tabell med elpris (öre/kWh) per timindex 0..167.
            // Försök i första hand använda vvPriceByIndex från vvAiTick (som redan
            // bygger från vvPriceHorizon och sparar min/max i meta).
            let priceByIndex = new Array(168).fill(null);
            let minPrice = NaN;
            let maxPrice = NaN;

            if (store && store.meta &&
                Array.isArray(store.meta.vvPriceByIndex) &&
                store.meta.vvPriceByIndex.length === 168 &&
                Number.isFinite(store.meta.vvPriceMin) &&
                Number.isFinite(store.meta.vvPriceMax) &&
                store.meta.vvPriceMax > store.meta.vvPriceMin) {

                priceByIndex = store.meta.vvPriceByIndex.slice();
                minPrice = Number(store.meta.vvPriceMin);
                maxPrice = Number(store.meta.vvPriceMax);
            } else if (store && store.meta && Array.isArray(store.meta.vvPriceHorizon)) {
                minPrice = Infinity;
                maxPrice = -Infinity;

                for (const p of store.meta.vvPriceHorizon) {
                    if (!p) continue;
                    const tsVal = Number(p.ts);
                    const priceOre = Number(p.price_ore);
                    if (!Number.isFinite(tsVal) || !Number.isFinite(priceOre)) continue;

                    const dt = new Date(tsVal);
                    if (!dt || isNaN(dt.getTime())) continue;

                    // Kartlägg verklig veckodag/timme → index 0..167 (måndag = 0)
                    let day = dt.getDay(); // 0 = söndag .. 6 = lördag
                    day = (day + 6) % 7;   // gör måndag = 0
                    const hour = dt.getHours();
                    const idx = day * 24 + hour;
                    if (idx < 0 || idx >= 168) continue;

                    priceByIndex[idx] = priceOre;
                    if (priceOre < minPrice) minPrice = priceOre;
                    if (priceOre > maxPrice) maxPrice = priceOre;
                }

                if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || maxPrice <= minPrice) {
                    for (let i = 0; i < 168; i++) priceByIndex[i] = null;
                    minPrice = NaN;
                    maxPrice = NaN;
                }
            } else {
                // Ingen prisdata – lämna prisserierna som nollor.
                priceByIndex = new Array(168).fill(null);
                minPrice = NaN;
                maxPrice = NaN;
            }

const priceGraphActive = !!priceControlEnabled;

// VV-pris (grön): markera endast de 2 billigaste SAMMANHÄNGANDE timmarna (en 2h-klump)
// inom prisfönstret före dagens peak (mätt via VV-profilens högsta timme).
// Detta är en ren graf-mask: VV-planen (orange) kan vara längre, men grön visar "när vi tänker värma".
const vvPriceHeatMask = new Array(168).fill(false);

if (priceGraphActive && !scheduleGraphActive && Array.isArray(priceByIndex) && priceByIndex.length === 168) {
    // Bygg "VV-pris billigast" utifrån den FAKTISKA VV-planen (modePlan/tempPlan).
    // Dvs: för varje dags sammanhängande VV-plan-fönster (>=2 timmar) väljer vi den billigaste
    // 2-timmars-klumpen INOM fönstret. Då kan vi aldrig hamna i läget "VV-plan finns men ingen VV-pris",
    // även om en natt-peak har flyttats bort i planeringen.
    //
    // Nattspärr: markera inte timmar 00:00–03:00 (0,1,2). (Planen försöker också undvika detta.)
    const NIGHT_BLOCK_FROM_H = 0;
    const NIGHT_BLOCK_TO_H = 3; // exklusiv

    const pickCheapest2hInRun = (run) => {
        // run = [{idx, price, temp}] där idx är absolutindex 0..167, och idx ökar med 1
        if (!Array.isArray(run) || run.length < 2) return null;

        let bestStart = null;
        let bestCost = Infinity;

        for (let i = 0; i <= run.length - 2; i++) {
            const idx1 = run[i].idx;
            const idx2 = run[i + 1].idx;

            const h1 = idx1 % 24;
            const h2 = idx2 % 24;

            if (h1 >= NIGHT_BLOCK_FROM_H && h1 < NIGHT_BLOCK_TO_H) continue;
            if (h2 >= NIGHT_BLOCK_FROM_H && h2 < NIGHT_BLOCK_TO_H) continue;

            const p1 = run[i].price;
            const p2 = run[i + 1].price;
            if (!Number.isFinite(p1) || !Number.isFinite(p2)) continue;

            const cost = p1 + p2;

            // Tie-break: välj senare block om samma kostnad
            if (cost < bestCost || (cost === bestCost && (bestStart === null || idx1 > bestStart))) {
                bestCost = cost;
                bestStart = idx1;
            }
        }

        return bestStart;
    };

    for (let day = 0; day < 7; day++) {
        const base = day * 24;

        // Ta ut timmar i denna dag som faktiskt är VV-plan (mode/temp > 0) och har prisdata.
        const planHours = [];
        for (let h = 0; h < 24; h++) {
            const idx = base + h;
            const m = Number(modePlan[idx]) || 0;
            const t = Number(tempPlan[idx]) || 0;
            const pr = priceByIndex[idx];

            if (m > 0 && t > 0 && pr !== null && Number.isFinite(pr)) {
                planHours.push({ idx, price: pr, temp: t });
            }
        }

        if (planHours.length < 2) continue;

        // Bygg sammanhängande "runs" (idx ska vara +1)
        let run = [planHours[0]];
        for (let i = 1; i < planHours.length; i++) {
            const prev = planHours[i - 1];
            const cur = planHours[i];
            if (cur.idx === prev.idx + 1) {
                run.push(cur);
            } else {
                // Välj billigaste 2h i tidigare run
                const best = pickCheapest2hInRun(run);
                if (best !== null) {
                    vvPriceHeatMask[best] = true;
                    vvPriceHeatMask[best + 1] = true;
                }
                run = [cur];
            }
        }

        // sista run
        const best = pickCheapest2hInRun(run);
        if (best !== null) {
            vvPriceHeatMask[best] = true;
            vvPriceHeatMask[best + 1] = true;
        }
    }
}
for (let i = 0; i < 168; i++) {
                const x = i;
                const p = Number(profile[i]) || 0;
                const t = Number(tempPlan[i]) || 0;
                const m = Number(modePlan[i]) || 0;

                // Visa VV-profil i 0–100-skala i grafen (lagrad profil är fortfarande i °C)
                const pPct = p * 15;
                profileSeries.push({ x, y: Number(pPct.toFixed(1)) });

                if (scheduleGraphActive) {
                    // Beräkna "mittpunkten" på timmen i minuter (0–1439)
                    const hour = i % 24;
                    const minuteMid = hour * 60 + 30;

                    // Blockeringsfönster: där VV INTE får gå
                    // Om fromMin < toMin: block [fromMin, toMin)
                    // Om fromMin > toMin (över midnatt): block [fromMin, 24h) U [0, toMin)
                    let inBlocked = false;
                    if (fromMin < toMin) {
                        // Enkel: block [fromMin, toMin)
                        inBlocked = (minuteMid >= fromMin && minuteMid < toMin);
                    } else {
                        // Över midnatt: block [fromMin, 24h) U [0, toMin)
                        inBlocked = (minuteMid >= fromMin || minuteMid < toMin);
                    }

                    const inOpenWindow = !inBlocked;

                    let planY = 0;
                    let modeY = 0;

                    if (inOpenWindow && scheduleMode > 0) {
                        modeY = scheduleMode;

                        if (scheduleMode === 1 && Number.isFinite(stopEco)) {
                            planY = stopEco;
                        } else if (scheduleMode === 2 && Number.isFinite(stopNormal)) {
                            planY = stopNormal;
                        } else if (scheduleMode === 3 && Number.isFinite(stopLux)) {
                            planY = stopLux;
                        }
                    }

                    tempSeries.push({ x, y: planY });
                    modeSeries.push({ x, y: modeY });
                } else {
                    // Standard: visa AI-planen (tempPlan och modePlan) som tidigare
                    tempSeries.push({ x, y: Number(t.toFixed(1)) });
                    modeSeries.push({ x, y: m });
                }

                // Elpris (relativ skala 0–100) – bara visuellt i grafen.
                // Om vi saknar pris för timmen → y=null (visas som glapp, inte som "0"/billigast).
                let priceY = null;
                const val = priceByIndex[i];
                if (val !== null && Number.isFinite(val) &&
                    Number.isFinite(minPrice) && Number.isFinite(maxPrice) && maxPrice > minPrice) {
                    const norm = (val - minPrice) / (maxPrice - minPrice);
                    priceY = Number((norm * 100).toFixed(1));
                }
                priceSeries.push({ x, y: priceY });

                // VV-prisfönster (graf):

                // VV-pris (graf):
                // "VV-pris billigast" = 2 sammanhängande timmar (mask) som valts som billigast i dagens prisfönster.
                // Vi visar endast dessa timmar som "på" (höjd = planens stopptemp), annars 0.
                let heatY = 0;

                if (priceGraphActive && !scheduleGraphActive) {
                    const planMode = m;
                    const planTemp = t;

                    // Visa bara när vi faktiskt har en VV-plan + prisdata på timmen
                    if (planMode > 0 && planTemp > 0 && val !== null && Number.isFinite(val)) {
                        if (vvPriceHeatMask[i] === true) {
                            heatY = Number(planTemp.toFixed(1));
                        }
                    }
                }

                priceWindowHeatSeries.push({ x, y: heatY });

}

            const series = ["VV-plan", "VV-profil", "VV-läge"];
            const data = [tempSeries, profileSeries, modeSeries];
            const labels = ["VV-plan", "VV-profil", "VV-läge"];

            // Visa elpris-serien endast när elprisstyrning för VV är aktiv.
            if (priceGraphActive) {
                series.push("Elpris (relativ)");
                data.push(priceSeries);
                labels.push("Elpris (relativ)");
            }

            // Lägg bara till VV-pris-serien när elprisstyrning är aktiv.
            if (priceGraphActive && !scheduleGraphActive) {
                // Lägg som FÖRSTA serie så den ritas överst i ui_chart
                series.unshift("VV-pris billigast");
                data.unshift(priceWindowHeatSeries);
                labels.unshift("VV-pris billigast");
            }

            const sendArray = [{
                series,
                data,
                labels
            }];

            // System 1 för nu – kan utökas senare om vi kör fler system.
            const system = (hw && typeof hw.system === 'number') ? hw.system : 1;

            return { values: sendArray, system };
        } catch (e) {
            nibe.log(`VV-AI graph build error: ${e}`, 'hotwater', 'error');
            return null;
        }
    }




async function vvAiTick() {
        // Cron kör vvAiTick() utan await varje minut. En tick som drar över en
        // minut (6 awaits mot värmepumpen) skulle annars köra parallellt med
        // nästa och förstöra tappdetekteringens delade tillstånd.
        if (vvTickRunning) {
            nibe.log('VV-AI: föregående tick pågår fortfarande – hoppar över denna', 'hotwater', 'debug');
            return;
        }
        vvTickRunning = true;
        try {
            const config = nibe.getConfig() || {};
            const hw = config.hotwater || {};

            const learningEnabled = (hw.enable_vv_learning === true);
            const manualScheduleEnabled = (hw.vv_manual_schedule_enable === true);
            const aiControlEnabled = (hw.enable_vv_ai_control === true);
            const priceControlEnabled = vvAiIsTrue(hw.vv_ai_use_price_enable);

            // Prisfönster: antingen standard 7h från backend,
            // eller användarens eget värde om vv_ai_price_window_enable = true.
            const priceWindowOverrideEnabled = vvAiIsTrue(hw.vv_ai_price_window_enable);
            let priceWindowHours = 7;
            if (priceWindowOverrideEnabled) {
                let tmpHours = hw ? Number(hw.vv_ai_price_window_hours) : NaN;
                if (Number.isFinite(tmpHours) && tmpHours > 0) {
                    if (tmpHours > 24) tmpHours = 24;
                    priceWindowHours = tmpHours;
                }
            }

            // Om varken VV-AI, tidsstyrning eller VV-AI-styrning är aktiverad
            // och vi inte har en pågående tidsstyrning att städa upp efter, gör vi ingenting.
            if (!learningEnabled && !manualScheduleEnabled && !aiControlEnabled && !vvLastManualSchedule) {
                return;
            }

			// Läs stopp-temperaturer för Eco / Normal / Lux direkt från Nibe (hP-nycklar)
			// hw_stop_0 = Eco, hw_stop_1 = Normal, hw_stop_2 = Lux.
			// Dessa läggs bara i hw-objektet i RAM – ingen skrivning till configfilen.
			try {
				const [stopEco, stopNormal, stopLux] = await Promise.all([
					getNibeData(hP['hw_stop_0']).catch(() => undefined),
					getNibeData(hP['hw_stop_1']).catch(() => undefined),
					getNibeData(hP['hw_stop_2']).catch(() => undefined),
				]);

				if (stopEco && typeof stopEco.data === 'number' && Number.isFinite(stopEco.data)) {
					hw.vv_stop_eco = stopEco.data;
				}
				if (stopNormal && typeof stopNormal.data === 'number' && Number.isFinite(stopNormal.data)) {
					hw.vv_stop_normal = stopNormal.data;
				}
				if (stopLux && typeof stopLux.data === 'number' && Number.isFinite(stopLux.data)) {
					hw.vv_stop_lux = stopLux.data;
				}
			} catch (e) {
				// Om läsningen misslyckas låter vi vv_stop_* vara oförändrade,
				// då blir tempPlan=0 och grafen visar bara profil/VV-läge.
			}


            const store = ensureVvAiStore();
            store.meta = store.meta || {};
            store.meta.vvUsePrice = (priceControlEnabled === true);
            const ts = Date.now();

            // Bygg ett 48h-prisfönster för VV-AI (endast i RAM, ingen SD-skrivning)
            if (vvAiPriceCache && Array.isArray(vvAiPriceCache) && vvAiPriceCache.length > 0) {
                const priceHorizon = vvAiBuildPriceHorizon(ts, vvAiPriceCache);
                if (priceHorizon && priceHorizon.length > 0) {
                    store.meta.vvPriceHorizon = priceHorizon;
                } else {
                    store.meta.vvPriceHorizon = null;
                }
            } else {
                store.meta.vvPriceHorizon = null;
            }


            // Bygg en veckobaserad prisindex-tabell (0..167) + min/max för VV-AI-styrning
            const priceByIndex = new Array(168).fill(null);
            let minPrice = Infinity;
            let maxPrice = -Infinity;

            if (store.meta.vvPriceHorizon && Array.isArray(store.meta.vvPriceHorizon) && store.meta.vvPriceHorizon.length > 0) {
                for (const p of store.meta.vvPriceHorizon) {
                    if (!p) continue;
                    const tsVal = Number(p.ts);
                    const priceOre = Number(p.price_ore);
                    if (!Number.isFinite(tsVal) || !Number.isFinite(priceOre)) continue;

                    const dt = new Date(tsVal);
                    if (!dt || isNaN(dt.getTime())) continue;

                    // Kartlägg verklig veckodag/timme → index 0..167 (måndag = 0)
                    let day = dt.getDay(); // 0 = söndag .. 6 = lördag
                    day = (day + 6) % 7;   // gör måndag = 0
                    const hour = dt.getHours();
                    const idx = day * 24 + hour;
                    if (idx < 0 || idx >= 168) continue;

                    priceByIndex[idx] = priceOre;
                    if (priceOre < minPrice) minPrice = priceOre;
                    if (priceOre > maxPrice) maxPrice = priceOre;
                }

                if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || maxPrice <= minPrice) {
                    for (let i = 0; i < 168; i++) {
                        priceByIndex[i] = null;
                    }
                    minPrice = NaN;
                    maxPrice = NaN;
                }
            } else {
                for (let i = 0; i < 168; i++) {
                    priceByIndex[i] = null;
                }
                minPrice = NaN;
                maxPrice = NaN;
            }

            store.meta.vvPriceByIndex = priceByIndex;
            store.meta.vvPriceMin = minPrice;
            store.meta.vvPriceMax = maxPrice;

            // Lokal datumsträng för "dag-stängning" (YYYY-MM-DD) i lokal tid
            const nowLocal = new Date(ts);
            const todayStr = nowLocal.getFullYear() + '-' +
                String(nowLocal.getMonth() + 1).padStart(2, '0') + '-' +
                String(nowLocal.getDate()).padStart(2, '0');

            // Initiera meta-fält för dagstängning och min-temp-failsafe
            if (typeof store.meta.hwClosedDate !== 'string') {
                store.meta.hwClosedDate = null;
            }
            if (!Number.isFinite(store.meta.hwClosedUntilIdx)) {
                store.meta.hwClosedUntilIdx = -1;
            }
            if (typeof store.meta.vvMinActive !== 'boolean') {
                store.meta.vvMinActive = false;
            }
            if (!Number.isFinite(store.meta.vvMinTarget)) {
                store.meta.vvMinTarget = null;
            }

            let bt6;
            try {
                bt6 = await getNibeData(hP['bt6']).catch(() => undefined);
            } catch (e) {
                bt6 = undefined;
            }
            if (!bt6 || bt6.data === undefined || !Number.isFinite(Number(bt6.data))) {
                vvLastBt6 = null;
                vvInEvent = false;
                vvEventPeak = null;
                vvEventPeakTs = null;
                vvEventTrough = null;
                vvEventTroughTs = null;
                vvEventStartTs = null;
                await vvAiBuildPlan(store, hw);
            store.meta.lastTick = ts;
                saveVvAiStore();
                return;
            }

            const current = Number(bt6.data);
            const minDrop = getVvMinDrop(hw);

            // Laddar pumpen varmvatten just nu? BT6 sitter på LADDKRETSEN, inte i
            // tanken: när laddpumpen startar passerar vatten från tankens botten
            // givaren, så BT6 störtdyker och klättrar sedan tillbaka till exakt
            // samma värde. 18 sep gav det ett "tapp" på 24 °C på 12 minuter som
            // återhämtades till 99 % inom timmen - medan BT7 i tanktoppen STEG,
            // eftersom tanken värmdes. Det är brantare och renare än något
            // verkligt tapp och blev det största värdet i hela profilen. Utan den
            // här spärren lär sig profilen pumpens laddningar i stället för
            // hushållets förbrukning.
            let prioRaw;
            try {
                const prio = await getNibeData(hP['prio']).catch(() => undefined);
                prioRaw = (prio && prio.data !== undefined) ? prio.data : undefined;
            } catch (e) {
                prioRaw = undefined;
            }
            // 43086 Prio: 10 av, 20 varmvatten, 30 värme, 40/41 pool, 50 transfer,
            // 60 kyla. Går värdet inte att tolka behandlas det som "laddar inte",
            // så att ett saknat register inte tystar inlärningen helt.
            const prioNum = Number(prioRaw);
            const vvCharging = Number.isFinite(prioNum)
                ? (prioNum === 20)
                : (typeof prioRaw === 'string' && /varmvatten|hot\s*water/i.test(prioRaw));

            if (vvCharging || vvChargeSettleUntil > ts) {
                if (vvCharging && !vvChargeActive) {
                    vvChargeActive = true;
                    // Ett tapp som pågår när laddningen startar ska UTVÄRDERAS,
                    // inte kastas. Fallet före laddningen är den verkliga
                    // förbrukningen, och det är den som utlöste laddningen -
                    // pumpen startar ju på att BT6 gått under sin starttemperatur.
                    // Kastas eventet i stället försvinner nästan varje tapp: över
                    // sex dygn behölls 1 av 17 när de kastades, 13 när de
                    // utvärderades.
                    if (vvInEvent) {
                        vvCloseDrawEvent(hw, minDrop, current, ts, 'laddning startade');
                    }
                }
                if (vvCharging) {
                    vvChargeSettleUntil = ts + VV_CHARGE_SETTLE_MS;
                }
                // Under laddningen, och en stund efter, mäter BT6 laddkretsen och
                // inte tanken. Nolla allt så att detektionen börjar om på ett
                // färskt värde när den lugnat sig.
                vvInEvent = false;
                vvEventStartTs = null;
                vvEventTrough = null;
                vvEventTroughTs = null;
                vvEventHourDeg = null;
                vvEventPeak = null;
                vvEventPeakTs = null;
                vvLastBt6 = null;
            } else if (vvLastBt6 === null || vvEventPeak === null) {
                vvChargeActive = false;
                vvLastBt6 = current;
                vvEventPeak = current;
                vvEventPeakTs = ts;
                vvEventTrough = null;
                vvEventTroughTs = null;
                vvEventStartTs = null;
                vvEventHourDeg = null;
                vvInEvent = false;
            } else if (!vvInEvent) {
                vvChargeActive = false;
                // Utanför event: toppen följer BT6 uppåt (tanken laddas). >= och
                // inte >, så att vvEventPeakTs följer med när tanken står stilla
                // på toppvärdet - annars räknas en lång stiltje in i
                // fallhastigheten för tappet som kommer efteråt.
                if (current >= vvEventPeak) {
                    vvEventPeak = current;
                    vvEventPeakTs = ts;
                }
                // Starta event när BT6 fallit märkbart under toppen.
                if ((vvEventPeak - current) >= VV_DRAW_START_DELTA) {
                    vvInEvent = true;
                    vvEventStartTs = ts;
                    vvEventTrough = current;
                    vvEventTroughTs = ts;
                    vvEventHourDeg = {};
                    nibe.log(`VV-tapp påbörjat: BT6 ${current.toFixed(1)} °C, ` +
                        `${(vvEventPeak - current).toFixed(1)} °C under topp ${vvEventPeak.toFixed(1)} °C`,
                        'hotwater', 'debug');
                }
                vvLastBt6 = current;
            } else {
                vvChargeActive = false;
                // I event: följ botten. Varje ny bottennotering håller eventet levande.
                if (vvEventTrough === null || current < vvEventTrough) {
                    vvEventTrough = current;
                    vvEventTroughTs = ts;
                }

                // Grader per timme, till bokföringen. Se vvSteepestHourTs.
                if (Number.isFinite(vvLastBt6) && current < vvLastBt6) {
                    const hIdx = getWeekHourIndex(ts);
                    if (!vvEventHourDeg) {
                        vvEventHourDeg = {};
                    }
                    const slot = vvEventHourDeg[hIdx] || { deg: 0, ts: ts };
                    slot.deg += (vvLastBt6 - current);
                    vvEventHourDeg[hIdx] = slot;
                }

                // Fallhastigheten mäts från när BT6 senast stod på toppen, inte
                // från eventets start: spannet innehåller redan fallet som öppnade
                // eventet, så en start-relativ hastighet blir för hög. Ett läckage
                // på 1.2 °C/h såg då ut som 3.6 °C och lärdes in.
                const fallMs = ts - (vvEventPeakTs || vvEventStartTs || ts);
                const spanNow = vvEventPeak - vvEventTrough;
                const rate = fallMs > 0 ? (spanNow / (fallMs / 3600000)) : Infinity;

                const sinceNewLow = ts - (vvEventTroughTs || vvEventStartTs || ts);
                const recovered = (current - vvEventTrough) >= VV_DRAW_RECOVER_DELTA;
                const tooLong = (ts - (vvEventStartTs || ts)) >= VV_DRAW_MAX_MS;

                if (!recovered &&
                    (ts - (vvEventStartTs || ts)) >= VV_DRAW_REBASE_MS &&
                    rate < VV_DRAW_REBASE_RATE) {
                    // Eventet har krupit i en halvtimme: avsvalning, inte tappning.
                    // Flytta fram origo i stället för att stänga, annars krediteras
                    // avsvalningen ett senare tapp - fyra timmars stillestånd följt
                    // av en 5 °C-dusch bokfördes som 7 °C.
                    vvEventStartTs = ts;
                    vvEventPeak = current;
                    vvEventPeakTs = ts;
                    vvEventTrough = current;
                    vvEventTroughTs = ts;
                    vvEventHourDeg = {};
                } else if (recovered || sinceNewLow >= VV_DRAW_IDLE_CLOSE_MS || tooLong) {
                    const idleMin = Math.round(VV_DRAW_IDLE_CLOSE_MS / 60000);
                    const maxMin = Math.round(VV_DRAW_MAX_MS / 60000);
                    const why = recovered
                        ? 'återhämtning'
                        : (sinceNewLow >= VV_DRAW_IDLE_CLOSE_MS
                            ? `ingen ny botten på ${idleMin} min`
                            : `tidsgräns ${maxMin} min`);
                    vvCloseDrawEvent(hw, minDrop, current, ts, why);
                }
                vvLastBt6 = current;
            }

            await vvAiBuildPlan(store, hw);

            let bt7;
            try {
                bt7 = await getNibeData(hP['bt7']).catch(() => undefined);
            } catch (e) {
                bt7 = undefined;
            }

            const bt6Now = (bt6 && bt6.data !== undefined && Number.isFinite(Number(bt6.data)))
                ? Number(bt6.data)
                : NaN;
            const bt7Now = (bt7 && bt7.data !== undefined && Number.isFinite(Number(bt7.data)))
                ? Number(bt7.data)
                : NaN;

            let hourIndex = 0;
            let minutesOfDay = 0;
            try {
                const d = new Date(ts);
                let day = d.getDay(); // 0 = sön .. 6 = lör
                const hour = d.getHours();
                const minute = d.getMinutes();
                minutesOfDay = hour * 60 + minute;
                // Gör måndag = 0
                day = (day + 6) % 7;
                hourIndex = day * 24 + hour;
                if (hourIndex < 0 || hourIndex > 167) hourIndex = 0;
            } catch (e) {
                hourIndex = 0;
                minutesOfDay = 0;
            }

            let planTemp = null;
            if (Array.isArray(store.tempPlan) && store.tempPlan.length === 168) {
                const v = Number(store.tempPlan[hourIndex]);
                if (Number.isFinite(v) && v > 0) {
                    planTemp = v;
                }
            }

                        let planMode = 0;
            if (Array.isArray(store.modePlan) && store.modePlan.length === 168) {
                const m = Number(store.modePlan[hourIndex]);
                if (Number.isFinite(m) && m > 0) {
                    planMode = m;
                }
            }


            // VV-AI / Tidsstyrning / Min-temp:
            // Vi håller hw_period alltid på 0 (blockerad) och styr VV-produktion via startHW=4 (Tillfällig lyx),
            // och stoppar genom att sätta startHW=0 när BT7 nått måltemperaturen.
            //
            // Prioritet:
            // 1) Min-temp (BT7 < vv_ai_min_temp)
            // 2) Tidsstyrning (utanför blockfönster)
            // 3) VV-AI veckoplan (endast under planerade timmar och tills dagen "stängts")
            try {
                const hwPeriodKey = hP && hP['hw_period'];
                const startHWKey = hP && hP['startHW'];
                const hwModeKey = hP && hP['hw_mode'];

                // --- Konfliktskydd: ömsesidigt uteslutande lägen ---
                // - Tidsstyrning kräver VV-AI-styrning AV.
                // - VV-AI-styrning får inte vara PÅ om "Varmvattenreglering" (enable_hw_priority / enable_autoluxury) är PÅ.
                let conf = null;
                let confDirty = false;
                try {
                    conf = nibe.getConfig() || {};
                    conf.hotwater = conf.hotwater || {};
                } catch (e) {
                    conf = null;
                }

                if (conf && conf.hotwater) {
                    const hwConf = conf.hotwater;

                    const aiOn = (hwConf.enable_vv_ai_control === true);
                    const scheduleOn = (hwConf.vv_manual_schedule_enable === true);
                    const learningOn = (hwConf.enable_vv_learning === true);
                    const hwRegOn = (hwConf.enable_hw_priority === true) || (hwConf.enable_autoluxury === true);

                    const minTempOn = (hwConf.vv_ai_min_temp_enable === true);

                    if (scheduleOn && aiOn) {
                        // Om båda är PÅ: stäng av tidsstyrning (kräver att AI är AV)
                        hwConf.vv_manual_schedule_enable = false;
                        confDirty = true;
                    }
                    // OBS: VV-lärande får vara PÅ samtidigt som tidsstyrning.
                    // Lärandet påverkar bara profilen (BT6) och skriver inga HW-kommandon.
                    if (aiOn && hwRegOn) {
                        // Varmvattenreglering prioriterar: stäng av VV-AI-styrning
                        hwConf.enable_vv_ai_control = false;
                        confDirty = true;
                    }
                    if (confDirty) {
                        try { nibe.setConfig(conf); } catch (e) { /* ignore */ }
                    }
                }

                // Använd de "effektiva" flagsen (efter ev. auto-avaktivering)
                const hwEff = (conf && conf.hotwater) ? conf.hotwater : hw;
                const scheduleEnabled = (hwEff && hwEff.vv_manual_schedule_enable === true);
                const aiControlEnabled = (hwEff && hwEff.enable_vv_ai_control === true);
                const learningEnabled = (hwEff && hwEff.enable_vv_learning === true);
                const hwRegEnabled = (hwEff && ((hwEff.enable_hw_priority === true) || (hwEff.enable_autoluxury === true)));

                const minTempEnabled = (aiControlEnabled && hwEff && hwEff.vv_ai_min_temp_enable === true);

                // Säkerhet: tidsstyrning körs aldrig om VV-AI-styrning är aktivt
                const scheduleOk = scheduleEnabled && !aiControlEnabled;
                const aiOk = aiControlEnabled && !hwRegEnabled;

                // För tidsstyrning behöver vi veta om vi är i BLOCK-fönstret just nu.
                // BLOCK = VV ska INTE tillverkas (hw_period=0). UTANFÖR BLOCK = VV tillåten (hw_period återställs).
                let scheduleValid = false;
                let scheduleBlockedNow = false;
                let scheduleModeNow = 0;
                let scheduleFromMinNow = NaN;
                let scheduleToMinNow = NaN;

                if (scheduleOk) {
                    scheduleFromMinNow = Number(hw && hw.vv_manual_schedule_from_min);
                    scheduleToMinNow = Number(hw && hw.vv_manual_schedule_to_min);
                    scheduleModeNow = Number(hw && hw.vv_manual_schedule_mode);

                    const validFrom = Number.isFinite(scheduleFromMinNow) && scheduleFromMinNow >= 0 && scheduleFromMinNow <= 1440;
                    const validTo = Number.isFinite(scheduleToMinNow) && scheduleToMinNow >= 0 && scheduleToMinNow <= 1440;
                    const validMode = Number.isFinite(scheduleModeNow) && scheduleModeNow > 0;

                    if (validFrom && validTo && validMode && scheduleFromMinNow !== scheduleToMinNow) {
                        scheduleValid = true;

                        if (scheduleFromMinNow < scheduleToMinNow) {
                            scheduleBlockedNow = (minutesOfDay >= scheduleFromMinNow && minutesOfDay < scheduleToMinNow);
                        } else {
                            // korsar midnatt
                            scheduleBlockedNow = (minutesOfDay >= scheduleFromMinNow || minutesOfDay < scheduleToMinNow);
                        }
                    }
                }
               // --- Variabler för tidsstyrning (manual schedule) ---
                let vvManualScheduleActive = false;
                let vvManualScheduleBlocked = false;
                let vvManualScheduleBaseline = 20;


// --- HW-period vid tidsstyrning ---
                // Vi håller hw_period=0 när vi vill BLOCKERA VV (t.ex. i block-fönstret).
                // När vi ska STARTA VV i öppet fönster:
                //   1) startHW=4 (trigger)
                //   2) efter 5s: hw_period = baseline (20/25 eller sparat värde)
                // Baseline hålls kvar tills fönstret stänger, då går vi tillbaka till hw_period=0.
                let periodJustWritten = false;
                if (hwPeriodKey) {
                    let currentPeriod = NaN;
                    try {
                        const hwPerRes = await getNibeData(hwPeriodKey).catch(() => undefined);
                        if (hwPerRes && hwPerRes.data !== undefined && Number.isFinite(Number(hwPerRes.data))) {
                            currentPeriod = Number(hwPerRes.data);
                        }
                    } catch (e) {
                        currentPeriod = NaN;
                    }

                    // Om vi ser ett rimligt baseline-värde (>0) och saknar backup: spara det i config.hotwater.
                    // Detta ger oss ett "original" att falla tillbaka på efter reboot/strömavbrott.
                    if (Number.isFinite(currentPeriod) && currentPeriod > 0) {
                        try {
                            const c = nibe.getConfig() || {};
                            c.hotwater = c.hotwater || {};
                            const prev = Number(c.hotwater.vv_backup_hw_period);
                            if (!Number.isFinite(prev) || prev <= 0) {
                                c.hotwater.vv_backup_hw_period = currentPeriod;
                                nibe.setConfig(c);
                            }
                        } catch (e) { /* ignore */ }

                        // Om tidsstyrning är aktiverad: spara också baseline för tidsstyrning (persist i config.hotwater)
                        // (endast första gången, för att undvika onödiga skrivningar).
                        if (scheduleEnabled) {
                            try {
                                const c2 = nibe.getConfig() || {};
                                c2.hotwater = c2.hotwater || {};
                                const prev2 = Number(c2.hotwater.vv_backup_hw_period_schedule);
                                if (!Number.isFinite(prev2) || prev2 <= 0) {
                                    c2.hotwater.vv_backup_hw_period_schedule = currentPeriod;
                                    nibe.setConfig(c2);
                                }
                            } catch (e) { /* ignore */ }
                        }
                    }

                    // Baseline (prioritet: schedule-backup, annars generell backup, annars 20)
                    let base = NaN;
                    try {
                        const c3 = nibe.getConfig() || {};
                        const hwCfg = c3 && c3.hotwater ? c3.hotwater : {};
                        base = Number(hwCfg.vv_backup_hw_period_schedule || hwCfg.vv_backup_hw_period);
                    } catch (e) { base = NaN; }
                    if (!Number.isFinite(base) || base <= 0) base = 20;

                    vvManualScheduleBaseline = base;

                    const scheduleActive = (scheduleOk && scheduleValid);
                    vvManualScheduleActive = scheduleActive;
                    vvManualScheduleBlocked = scheduleBlockedNow;

                    if (!store.meta) store.meta = {};
                    let armed = (store.meta.vvManualSchedPeriodArmed === true);
                    const pendingAtRaw = store.meta.vvManualSchedPeriodPendingAt;
                    const pendingAt = (typeof pendingAtRaw === 'number' && Number.isFinite(pendingAtRaw)) ? pendingAtRaw : NaN;
                    const hasPending = Number.isFinite(pendingAt);

                    // HW-period:
                    // - VV-AI/min-temp: vi vill normalt hålla hw_period=0 för att Nibe inte ska planera bakom ryggen.
                    // - Tidsstyrning: 0 i block-fönster, annars 0 tills vi startar (startHW=4) och 5s efter det släpper vi till baseline.
                    let desiredPeriod = 0;

                    if (!scheduleActive) {
                        // ON -> OFF: återställ baseline så Nibe inte lämnas blockerad av tidsstyrningen
                        if (vvLastManualSchedule) {
                            desiredPeriod = base;
                        } else {
                            desiredPeriod = 0;
                        }
                        // reset state
                        store.meta.vvManualSchedPeriodArmed = false;
                        delete store.meta.vvManualSchedPeriodPendingAt;
                        delete store.meta.vvManualSchedPeriodPendingVal;
                        armed = false;
                    } else {
                        if (scheduleBlockedNow) {
                            desiredPeriod = 0;
                            store.meta.vvManualSchedPeriodArmed = false;
                            delete store.meta.vvManualSchedPeriodPendingAt;
                            delete store.meta.vvManualSchedPeriodPendingVal;
                            armed = false;
                        } else {
                            // öppet fönster
                            const nowTs2 = Date.now();
                            if (!armed && hasPending && nowTs2 >= pendingAt) {
                                desiredPeriod = base;
                                store.meta.vvManualSchedPeriodArmed = true;
                                delete store.meta.vvManualSchedPeriodPendingAt;
                                delete store.meta.vvManualSchedPeriodPendingVal;
                                armed = true;
                            } else {
                                desiredPeriod = armed ? base : 0;
                            }
                        }
                    }

                    // Om vi inte kan läsa nu – anta att period redan är i önskat läge (undvik spam).
                    if (!Number.isFinite(currentPeriod)) {
                        currentPeriod = desiredPeriod;
                    }

                    if (currentPeriod !== desiredPeriod) {
                        nibe.setData(hwPeriodKey, desiredPeriod);
                        periodJustWritten = true; // undvik att skriva startHW samma tick om vi precis skrivit period
                    }
                    vvLastManualSchedule = scheduleActive;
                }


// --- Styr VV via startHW=4/0 (Tillfällig lyx) + BT7-target ---
                // Vi triggar startHW=4 när vi vill värma (min-temp / plan), och sätter startHW=0 när BT7 >= target.
                // Ingen hysteresis: target är alltid det vi räknar fram (min-temp eller stopptemp).
                if (startHWKey && (aiOk || scheduleOk || minTempEnabled) && !periodJustWritten) {                    // För startHW är det bättre att bara trigga vid förändring (inte spam-skriva).
                    // Vi håller därför senaste skickade värde i RAM (store.meta) och skriver bara vid byte.
                    if (!store.meta) store.meta = {};
                    let lastSentStartHW = Number.isFinite(Number(store.meta.vvStartHWLast)) ? Number(store.meta.vvStartHWLast) : 0;

                    // Stopptemperaturer (för target)
                    const ecoStop = Number(hw && hw.vv_stop_eco);
                    const normalStop = Number(hw && hw.vv_stop_normal);
                    const luxStop = Number(hw && hw.vv_stop_lux);

                    let wantHeat = false;
                    let wantHeatFromSchedule = false;
                    let targetTemp = null;
                    let shouldCloseToday = false;

                    // 1) Min-temp-failsafe (BT7 < vv_ai_min_temp)
                    // Vi värmer till (minTemp + 4°C), och stoppar exakt när BT7 når target.
                    let vvMinActive = (store && store.meta && typeof store.meta.vvMinActive === 'boolean') ? store.meta.vvMinActive : false;
                    let vvMinTarget = (store && store.meta) ? store.meta.vvMinTarget : null;
                    if (!Number.isFinite(vvMinTarget)) vvMinTarget = null;

                    const minTemp = Number(hw && hw.vv_ai_min_temp);
                    const margin = 4;

                    if (minTempEnabled && Number.isFinite(bt7Now)) {
                        if (!vvMinActive && Number.isFinite(minTemp) && bt7Now < minTemp) {
                            let t = minTemp + margin;
                            if (Number.isFinite(luxStop) && t > luxStop) t = luxStop;
                            vvMinTarget = Number.isFinite(t) ? t : null;
                            vvMinActive = (vvMinTarget !== null);
                        }

                        if (vvMinActive && vvMinTarget !== null) {
                            targetTemp = vvMinTarget;
                            wantHeat = (Number.isFinite(bt7Now) && bt7Now < targetTemp);
                            if (Number.isFinite(bt7Now) && bt7Now >= targetTemp) {
                                vvMinActive = false;
                                vvMinTarget = null;
                            }
                        }

                        if (store && store.meta) {
                            store.meta.vvMinActive = vvMinActive;
                            store.meta.vvMinTarget = vvMinTarget;
                        }
                    }

                    // 2) Tidsstyrning: utanför blockfönster värmer vi till vald stopptemp när BT7 ligger under target
                    if (!wantHeat && scheduleOk && Number.isFinite(bt7Now)) {
                        const fromMin = Number(hw && hw.vv_manual_schedule_from_min);
                        const toMin = Number(hw && hw.vv_manual_schedule_to_min);
                        const scheduleMode = Number(hw && hw.vv_manual_schedule_mode);

                        const validFrom = Number.isFinite(fromMin) && fromMin >= 0 && fromMin <= 1440;
                        const validTo = Number.isFinite(toMin) && toMin >= 0 && toMin <= 1440;
                        const validMode = Number.isFinite(scheduleMode) && scheduleMode > 0;

                        if (validFrom && validTo && validMode && fromMin !== toMin) {
                            let blocked = false;
                            if (fromMin < toMin) {
                                blocked = (minutesOfDay >= fromMin && minutesOfDay < toMin);
                            } else {
                                blocked = (minutesOfDay >= fromMin || minutesOfDay < toMin);
                            }

                            if (!blocked) {
                                let t = NaN;
                                if (scheduleMode === 1) t = ecoStop;
                                else if (scheduleMode === 2) t = normalStop;
                                else if (scheduleMode === 3) t = luxStop;

                                if (!Number.isFinite(t)) {
                                    t = Number.isFinite(luxStop) ? luxStop : NaN;
                                }

                                if (Number.isFinite(t)) {
                                    targetTemp = t;
                                    wantHeat = (bt7Now < targetTemp);
                                    if (wantHeat) wantHeatFromSchedule = true;
                                }
                            }
                        }
                    }
                    // Elprisreglering (vv_ai_use_price_enable):
                    // När prisstyrning är aktiv vill vi INTE låta VV-AI-planen värma "var som helst".
                    // Plan-värmning (prio 3) får bara ske under de 2 billigaste SAMMANHÄNGANDE timmarna
                    // inom prisfönstret före dagens peak (baserat på VV-profilen).
                    // Min-temp (prio 1) och tidsstyrning (prio 2) påverkas inte.
                    let vvAiCheapHeatAllowedThisHour = true;
                    if (priceControlEnabled && !manualScheduleEnabled) {
                        try {
                            const lookback = Math.max(2, Math.floor(priceWindowHours)); // minst 2h
                            const baseDay = Math.floor(hourIndex / 24) * 24;

                            // Hitta upp till 2 peaks för dagen (>=3.0) med minst 6h mellan.
                            // Om inga peaks uppfyller tröskeln, fall back till dagens max-timme.
                            const PEAK_THR = 3.0;
                            const MIN_SEP_H = 6;

                            const candidates = [];

                            let maxHourAny = -1;

                            let maxValAny = -Infinity;

                            let maxHourAllowed = -1;

                            let maxValAllowed = -Infinity;


                            if (Array.isArray(store.profile) && store.profile.length === 168) {

                                for (let h = 0; h < 24; h++) {

                                    const v = Number(store.profile[baseDay + h]);

                                    if (!Number.isFinite(v)) continue;


                                    // Fallback-peak (om inga peaks >= PEAK_THR):

                                    // - ANY: bästa timmen oavsett nattspärr (sista nödfall)

                                    // - ALLOWED: bästa timmen utanför nattspärr (normalt)

                                    if (v > maxValAny) {

                                        maxValAny = v;

                                        maxHourAny = h;

                                    }

                                    if (h >= VV_NIGHT_BLOCK_TO_H && v > maxValAllowed) {

                                        maxValAllowed = v;

                                        maxHourAllowed = h;

                                    }


                                    // Peaks: ignorera timmar i nattspärren, annars kan prisfönstret hamna före 00:00 och aldrig matcha planen.

                                    if (v >= PEAK_THR && h >= VV_NIGHT_BLOCK_TO_H) {

                                        candidates.push({ h, v });

                                    }

                                }

                            }
let peakHours = [];
                            if (candidates.length > 0) {
                                candidates.sort((a, b) => b.v - a.v);
                                for (const c of candidates) {
                                    if (peakHours.length === 0) {
                                        peakHours.push(c.h);
                                    } else if (Math.abs(c.h - peakHours[0]) >= MIN_SEP_H) {
                                        peakHours.push(c.h);
                                    }
                                    if (peakHours.length >= 2) break;
                                }
                            }
                            if (peakHours.length === 0) {
                                const fallbackHour = (maxHourAllowed >= 0) ? maxHourAllowed : maxHourAny;
                                if (fallbackHour >= 0) {
                                    peakHours = [fallbackHour];
                                }
                            }

                            // Om vi saknar peak (ovanligt), tillåt plan-värmning som fallback
                            if (!Array.isArray(peakHours) || peakHours.length === 0) {
                                vvAiCheapHeatAllowedThisHour = true;
                            } else {
                                // Tillåt plan-värmning om timmen ingår i någon av dagens 2h-block (en per peak),
                                // med fallback: om blocket redan passerat tillåt sista 2h före respektive peak.
                                let allowed = false;

                                for (const peakHour of peakHours) {
                                    // Sök i [peakHour-lookback, peakHour) alltså timmarna före peak-timmen
                                    const windowStart = baseDay + Math.max(0, peakHour - lookback);
                                    const windowEndExclusive = baseDay + Math.max(2, peakHour); // måste ha minst 2h

                                    let bestStart = null;
                                    let bestSum = Infinity;

                                    // 2h-par måste sluta innan peakHour (dvs start <= peakHour-2)
                                    const lastStart = baseDay + Math.min(peakHour - 2, 22);
                                    if (lastStart < windowStart) {
                                        continue;
                                    }

                                    for (let i = windowStart; i <= lastStart; i++) {
                                        const i2 = i + 1;

                                        // Vi tillåter bara par som faktiskt ligger i VV-planen (mode/temp > 0)
                                        const m1 = (store.modePlan && Number(store.modePlan[i])) || 0;
                                        const m2 = (store.modePlan && Number(store.modePlan[i2])) || 0;
                                        const t1 = (store.tempPlan && Number(store.tempPlan[i])) || 0;
                                        const t2 = (store.tempPlan && Number(store.tempPlan[i2])) || 0;
                                        if (m1 <= 0 || m2 <= 0 || t1 <= 0 || t2 <= 0) continue;

                                        const p1 = Number(priceByIndex[i]);
                                        const p2 = Number(priceByIndex[i2]);
                                        if (!Number.isFinite(p1) || !Number.isFinite(p2)) continue;

                                        const sum = p1 + p2;

                                        // Tie-break: om lika billigt, välj den som ligger SENARE (närmast peak)
                                        if (sum < bestSum || (sum === bestSum && (bestStart === null || i > bestStart))) {
                                            bestSum = sum;
                                            bestStart = i;
                                        }
                                    }

                                    // Om vi inte kan beräkna billigast (saknar pris), tillåt fallback
                                    if (bestStart === null) {
                                        allowed = true;
                                        continue;
                                    }

                                    const cheapAllowed = (hourIndex === bestStart || hourIndex === bestStart + 1);

                                    const peakAbs = baseDay + peakHour;
                                    const fallbackStart = peakAbs - 2; // 2h före peak
                                    const fallbackAllowed = (hourIndex === fallbackStart || hourIndex === fallbackStart + 1)
                                        && hourIndex > (bestStart + 1) // billigaste blocket passerat
                                        && hourIndex < peakAbs;        // inte efter peak-start

                                    if (cheapAllowed || fallbackAllowed) {
                                        allowed = true;
                                    }
                                }

                                vvAiCheapHeatAllowedThisHour = allowed;
                            }
} catch (e) {
                            vvAiCheapHeatAllowedThisHour = true; // safe fallback
                        }
                    }

                    // 3) VV-AI-veckoplan (en "klump" per dag, dagstängning via store.meta.hwClosedDate)
                    if (!wantHeat && aiOk && Number.isFinite(bt7Now) && planMode > 0 && planTemp !== null && (!priceControlEnabled || vvAiCheapHeatAllowedThisHour)) {
                        const currentClosedDate = (store && store.meta && typeof store.meta.hwClosedDate === 'string')
                            ? store.meta.hwClosedDate
                            : null;
                                                const closedUntilIdx = (store && store.meta && Number.isFinite(store.meta.hwClosedUntilIdx))
                            ? store.meta.hwClosedUntilIdx
                            : -1;

                        // Om dag bytts sedan vi stängde en klump – nollställ index.
                        if (store && store.meta && currentClosedDate !== todayStr && store.meta.hwClosedUntilIdx !== -1) {
                            store.meta.hwClosedUntilIdx = -1;
                        }

                        const closedToday = (currentClosedDate === todayStr) && (hourIndex <= closedUntilIdx);

                        if (!closedToday) {
                            targetTemp = planTemp;
                            wantHeat = (bt7Now < targetTemp);

                                                        // Om vi redan är över target: stäng nuvarande "klump" (block) för idag,
                            // men tillåt senare uppvärmning samma dag om det finns en ny klump (t.ex. 2 peaks).
                            if (bt7Now >= targetTemp) {
                                let endIdx = hourIndex;
                                try {
                                    const hourInDay = nowLocal.getHours();
                                    const dayStartIdx = hourIndex - hourInDay;
                                    const endLimit = dayStartIdx + 23;
                                    while (endIdx < endLimit && store && Array.isArray(store.tempPlan) &&
                                           Number.isFinite(store.tempPlan[endIdx + 1]) && store.tempPlan[endIdx + 1] > 0) {
                                        endIdx++;
                                    }
                                } catch (e) {
                                    // ignore
                                }

                                if (store && store.meta) {
                                    store.meta.hwClosedDate = todayStr;
                                    store.meta.hwClosedUntilIdx = endIdx;
                                }
                                wantHeat = false;
                            }
                        }
                    }

                    // Rate-limit skrivningar till startHW (minst ~1s mellan)
                    const nowTs = Date.now();
                    const lastWrite = (store && store.meta && Number.isFinite(store.meta.lastStartHWWriteTs))
                        ? store.meta.lastStartHWWriteTs
                        : 0;
                    const canWrite = (nowTs - lastWrite) >= 1100;

                    if (wantHeat) {
                        if (canWrite && lastSentStartHW !== 4) {
                            nibe.setData(startHWKey, 4); // Tillfällig lyx (trigger) = starta VV
                            if (store && store.meta) {
                                store.meta.lastStartHWWriteTs = nowTs;
                                store.meta.vvStartHWLast = 4;
                            }

                            // Tidsstyrning: efter startHW=4, vänta 5s och släpp hw_period till baseline (om vi inte redan gjort det)
                            if (wantHeatFromSchedule && vvManualScheduleActive && !vvManualScheduleBlocked && store && store.meta) {
                                const armed = (store.meta.vvManualSchedPeriodArmed === true);
                                const pendingRaw = store.meta.vvManualSchedPeriodPendingAt;
                                const pending = (typeof pendingRaw === 'number' && Number.isFinite(pendingRaw)) ? pendingRaw : NaN;
                                if (!armed && !Number.isFinite(pending)) {
                                    store.meta.vvManualSchedPeriodPendingAt = Date.now() + 5000;
                                    store.meta.vvManualSchedPeriodPendingVal = vvManualScheduleBaseline;
                                }
                            }
                        }
                    } else {
                        if (canWrite && lastSentStartHW !== 0) {
                            nibe.setData(startHWKey, 0); // stoppa/återställ till normal
                            if (store && store.meta) {
                                store.meta.lastStartHWWriteTs = nowTs;
                                store.meta.vvStartHWLast = 0;
                            }
                        }
                    }

                    if (shouldCloseToday && store && store.meta) {
                        store.meta.hwClosedDate = todayStr;
                    }
                }
            } catch (e) {
                nibe.log(`VV-AI: fel vid hw_period/startHW-styrning: ${e}`, 'hotwater', 'error');
            }

vvLastAiControl = (hw.enable_vv_ai_control === true);

            if (Number.isFinite(bt7Now) && planTemp !== null) {
            }

            store.meta.lastBt6 = bt6Now;
            store.meta.lastBt7 = bt7Now;

            // Uppdatera senaste VV-AI tick-tid
            store.meta.lastTick = ts;

            // Skicka graf till pluginHotwaterAI varje minut (ingen throttle)
            const graph = hotwaterAiBuildGraph(store, hw);
            if (graph) {
                graph.bt6 = Number.isFinite(bt6Now) ? bt6Now : null;
                graph.bt7 = Number.isFinite(bt7Now) ? bt7Now : null;
                graph.timestamp = ts;
                graph.hourIndex = hourIndex;
                nibeData.emit('pluginHotwaterAI', graph);
            }

            if (learningEnabled) {
                saveVvAiStore();
            }

        } catch (err) {
            nibe.log(`VV-AI tick error: ${err}`, 'hotwater', 'error');
        } finally {
            vvTickRunning = false;
        }
    }
    const SunCalc = require('suncalc');
    const suncalc = (data) => {
        var times = SunCalc.getTimes(data.timestamp, data.lat, data.lon);
        return times;
    }
    const toTimestamp = (strDate) => {
        var datum = Date.parse(strDate);
        return Number((datum).toFixed());
    }
    const isMissingValue = (value) => {
        return value === undefined || value === null || value === 9999 || value === 9999.0 || value === '9999';
    }
    const getTimeString = (timeSeries) => {
        if(timeSeries === undefined || timeSeries === null) return undefined;
        return timeSeries.validTime || timeSeries.time;
    }
    const getParamValue = (timeSeries, candidates = [], fallback = undefined) => {
        if(timeSeries === undefined || timeSeries === null) return fallback;
        if(timeSeries.data !== undefined && timeSeries.data !== null) {
            for(const key of candidates) {
                if(Object.prototype.hasOwnProperty.call(timeSeries.data, key) && !isMissingValue(timeSeries.data[key])) {
                    return timeSeries.data[key];
                }
            }
        }
        if(Array.isArray(timeSeries.parameters)) {
            for(const key of candidates) {
                const found = timeSeries.parameters.find(param => param && param.name == key);
                if(found && Array.isArray(found.values) && found.values.length > 0 && !isMissingValue(found.values[0])) {
                    return found.values[0];
                }
            }
        }
        return fallback;
    }
    const initiateCore = (host,port,cb) => {
        nibe.initiateCore(host,port, (err,data) => {
            if(err) console.log(err);
            nibe.core = data;
            cb(null,true);
        });
    }
    let timer = {};
    function updateConfig(category,parameter,data) {
        let config = nibe.getConfig();
        if(config[category]!==undefined && config[category][parameter]!==undefined) {
            if(config[category][parameter]!==data) {
                config[category][parameter] = data;
                // Config has changed
                nibeData.emit(`config_${category}`,config[category]);
                nibe.setConfig(config);
            }
        }
    }
    const curveAdjust = (type,system,data) => {
        let curveadjust;
        if(hP!==undefined) {
            curveadjust = hP['curveadjust_'+system];
        }
        var newSystem = true;
        for( var i = 0; i < adjust.length; i++){
            if(adjust[i].system===system) {
                let newType = true;
                let newData = false;
                for( var o = 0; o < adjust[i].data.length; o++){
                    if(adjust[i].data[o].name===type) {
                        adjust[i].data[o].data = data;
                        newType = false;
                        newData = true;
                    }
                }
                if(newType===true) {
                    adjust[i].data.push({name:type,data:data});
                }
                if(newData===true) {
                    // Set new curveadjust
                    let out = 0;
                    let run = false;
                    if(timer[system]!==undefined && timer[system]._idleTimeout>0) {
                        clearTimeout(timer[system]);
                        run = true;
                    } else {
                        run = true;
                    }
                    if(run===true) {
                        timer[system] = setTimeout((i) => {
                            for( var o = 0; o < adjust[i].data.length; o++){
                                out = out+adjust[i].data[o].data;
                            }
                            out = out;
                            nibe.reqData(curveadjust).then(result => {
                                let config = nibe.getConfig();
                                if(config.home===undefined) {
                                    config.home = {};
                                    nibe.setConfig(config);
                                }
                                if(config.home['adjust_'+system]!==undefined) {
                                    out = out+Number(config.home['adjust_'+system]);
                                }
                                if(out>10) out = 10;
                                if(out<-10) out = -10;
                                if(out>(result.data+0.75)) {
                                    out = Math.round(out);
                                    if(result.data!==(out)) {
                                        nibe.setData(curveadjust,out,(err,result) => {
                                            if(err) return console.log(err);
                                            let save = {
                                                titel:"Curveadjustment",
                                                register:'curveadjust',
                                                info:"NibePis total adjustment of the curve",
                                                raw_data:out,
                                                data:out,
                                                unit:"°C",
                                                icon_name:"fa-thermometer-three-quarters"
                                            }
                                            savedData['curveadjust'] = save;
                                            saveDataGraph('curveadjust',Date.now(),save.raw_data)
                                        });
                                    }
                                } else if(out<(result.data-0.75)) {
                                    out = Math.round(out);
                                    if(result.data!==(out)) {
                                        nibe.setData(curveadjust,out,(err,result) => {
                                            if(err) return console.log(err);
                                            let save = {
                                                titel:"Curveadjustment",
                                                register:'curveadjust',
                                                info:"NibePis total adjustment of the curve",
                                                raw_data:out,
                                                data:out,
                                                unit:"°C",
                                                icon_name:"fa-thermometer-three-quarters"
                                            }
                                            savedData['curveadjust'] = save;
                                            saveDataGraph('curveadjust',Date.now(),save.raw_data)
                                        });
                                    }
                                }
                            }).catch(console.log)

                        }, 5000,i);
                    }
                }
                newSystem = false;
            }
        }
        if(newSystem===true) {
            adjust.push({system:system,data:[{name:type,data:data}]})
            curveAdjust(type,system,data);
        }
    }
    const getList = [];
    function clearList(plugin,system) {
        const promise = new Promise((resolve,reject) => {
            for( var i = 0; i < getList.length; i++){
                if(getList[i].system===system) {
                    for( var j = 0; j < getList[i].registers.length; j++){
                        if(getList[i].registers[j].plugin!==undefined) {
                            let len = getList[i].registers[j].plugin.length;
                            for( var k = 0; k <len ; k++){
                                if(getList[i].registers[j].plugin[k]===plugin) {
                                    getList[i].registers[j].plugin.splice(k,1);
                                    if(getList[i].registers[j].plugin.length===0) {
                                        getList[i].registers.splice(j,1);
                                    }
                                }
                            }
                        }

                    }
                }
            }

            resolve(true);
        });
        return promise;
    }
    async function initiatePlugin(arrData,plugin,system="s1") {
        let arr = arrData.slice();
        const promise = new Promise((resolve,reject) => {
            clearList(plugin,system).then(result => {
                var newSystem = true;

                for( var i = 0; i < arr.length; i++){
                    if(arr[i].register===undefined) {
                        arr[i].register = hP[arr[i].topic];
                    }
                    for( var o = 0; o < getList.length; o++){

                        if(getList[o].system===system) {
                            // System exists, moving on.
                            newSystem = false;
                                // Looking for the register from the incoming array.
                                let regI = getList[o].registers.findIndex(regI => regI.register == arr[i].register);
                                if(regI===-1) {
                                    // Register dont exist, adding new register.
                                    let newArr = arr[i];
                                    // Adding the plugin name to the first array
                                    newArr.plugin = [plugin];
                                    getList[o].registers.push(newArr);
                                } else {
                                    // The register already exists, checking if the plugin is already added and gets the index.
                                    let regP = getList[o].registers[regI].plugin.findIndex(regP => regP == plugin);
                                    if(getList[o].registers[regI].name===undefined) getList[o].registers[regI].name = arr[i].name;
                                    if(getList[o].registers[regI].topic===undefined) getList[o].registers[regI].topic = arr[i].topic;
                                    if(regP===-1) {
                                        getList[o].registers[regI].plugin.push(plugin);
                                    } else {

                                    }
                                }

                        }
                    }
                }
                let checkReg = hP['supply_'+system];
                function checkRMU() {
                    if(plugin=="rmu") {
                        nibe.reqData(hP['startHW_rmu_'+system]).then(data => {
                            if(data!==undefined) {
                                let regN = getList.findIndex(regN => regN.system == 's1');
                                if(regN!==-1) {
                                for( var i = 0; i < arr.length; i=i+1){
                                    let regI = getList[regN].registers.findIndex(regI => regI.register == arr[i].register);
                                    if(regI===-1) {
                                        let newArr = arr[i];
                                        newArr.plugin = [plugin];
                                        getList[regN].registers.push(newArr);
                                    } else {
                                        if(getList[regN].registers[regI].topic===undefined) getList[regN].registers[regI].topic = arr[i].topic;
                                        if(getList[regN].registers[regI].name===undefined) getList[regN].registers[regI].name = arr[i].name;
                                        let regP = getList[regN].registers[regI].plugin.findIndex(regP => regP == plugin);
                                        if(regP===-1) {
                                            getList[regN].registers[regI].plugin.push(plugin);
                                        } else {

                                        }
                                    }
                                    }
                                }
                                resolve(true)
                            } else {
                                return reject(false);
                            }
                        }).catch((err) => {
                            return reject(false)
                        })
                    } else {
                        //sendError('System',`System S${system.replace('s','')} ${text.sys_not_connected}`);
                        //return reject(false);
                    }
                }
                if(newSystem===true) {
                    let regN = getList.findIndex(regN => regN.system == system);
                    if(regN===-1) {
                        checkRMU();
                        nibe.reqData(checkReg).then(data => {
                            if(data.data<-3276) {
                                checkRMU();
                                return reject(false);
                            } else {
                                systems[system] = true;
                                if(plugin=="fan") {
                                    nibe.reqData(hP.bs1_flow).then(data => {
                                        if(data.data<-3276) {
                                            return reject(false);
                                        } else {
                                            let regN = getList.findIndex(regN => regN.system == system);
                                if(regN===-1) {
                                    getList.push({system:system,registers:[]});
                                    for( var i = 0; i < arr.length; i=i+1){
                                        let regI = getList.findIndex(regI => regI.system == system);
                                        let newArr = arr[i];
                                        newArr.plugin = [plugin];
                                        getList[regI].registers.push(newArr);
                                    }
                                } else {
                                    for( var i = 0; i < arr.length; i=i+1){
                                    let regI = getList[regN].registers.findIndex(regI => regI.register == arr[i].register);
                                    if(regI===-1) {
                                        let newArr = arr[i];
                                        newArr.plugin = [plugin];
                                        getList[regN].registers.push(newArr);
                                    } else {
                                        if(getList[regN].registers[regI].topic===undefined) getList[regN].registers[regI].topic = arr[i].topic;
                                        if(getList[regN].registers[regI].name===undefined) getList[regN].registers[regI].name = arr[i].name;
                                        let regP = getList[regN].registers[regI].plugin.findIndex(regP => regP == plugin);
                                        if(regP===-1) {
                                            getList[regN].registers[regI].plugin.push(plugin);
                                        } else {

                                        }
                                    }
                                    }
                                }
                                resolve(true)
                                        }
                                    },(error => {
                                        return reject(false);
                                    }));
                            } else {
                                let regN = getList.findIndex(regN => regN.system == system);
                                if(regN===-1) {
                                    getList.push({system:system,registers:[]});
                                    for( var i = 0; i < arr.length; i=i+1){
                                        let regI = getList.findIndex(regI => regI.system == system);
                                        let newArr = arr[i];
                                        newArr.plugin = [plugin];
                                        getList[regI].registers.push(newArr);
                                    }
                                } else {
                                    for( var i = 0; i < arr.length; i=i+1){
                                    let regI = getList[regN].registers.findIndex(regI => regI.register == arr[i].register);
                                    if(regI===-1) {
                                        let newArr = arr[i];
                                        newArr.plugin = [plugin];
                                        getList[regN].registers.push(newArr);
                                    } else {
                                        if(getList[regN].registers[regI].topic===undefined) getList[regN].registers[regI].topic = arr[i].topic;
                                        if(getList[regN].registers[regI].name===undefined) getList[regN].registers[regI].name = arr[i].name;
                                        let regP = getList[regN].registers[regI].plugin.findIndex(regP => regP == plugin);
                                        if(regP===-1) {
                                            getList[regN].registers[regI].plugin.push(plugin);
                                        } else {

                                        }
                                    }
                                    }
                                }
                                resolve(true)
                            }

                            }
                        }).catch((err) => {
                            checkRMU();
                            return reject(false);
                        });

                    } else {
                        checkRMU();
                        nibe.reqData(checkReg).then(data => {
                            if(data.data<-3276) {
                                checkRMU();
                                return reject(false);
                            } else {
                                systems[system] = true;
                                if(plugin=="fan") {
                                    nibe.reqData(hP.bs1_flow).then(data => {
                                        if(data.data<-3276) {
                                            return reject(false);
                                        } else {
                                            resolve(true)
                                        }
                                    }).catch((err) => {
                                        return reject(false);
                                    });
                            } else {
                                resolve(true)
                            }
                            }
                        }).catch((err) => {
                            checkRMU();
                            return reject(false);
                        });

                    }
                } else {
                    checkRMU();
                    nibe.reqData(checkReg).then(data => {
                        if(data.data<-3276) {
                            checkRMU();
                            return reject(false);
                        } else {
                            systems[system] = true;
                            if(plugin=="fan") {
                                nibe.reqData(hP.bs1_flow).then(data => {
                                    if(data.data<-3276) {
                                        return reject(false);
                                    } else {

                                    }
                                },(error => {
                                    return reject(false);
                                }));
                        } else {
                            resolve(true)
                        }
                        }
                    }).catch((err) => {
                        checkRMU();
                        return reject(false);
                    });

                }
        })
    });
    return promise;
}
    async function updateData(hourly=false) {
        let timeNow = Date.now();
        /*
        Check emitters
        let events = nibeData.eventNames()
        console.log(JSON.stringify(events,null,2));
        for (const item of events) {
            let count = nibeData.listenerCount(item)
            console.log(`Eventname: ${item}, Count: ${count}`);
        }*/
        for (const item of getList) {
            const array = [];
            let result = {timestamp:timeNow};
            result.system = item.system;
            if(weatherOffset[item.system]===undefined) weatherOffset[item.system] = 0;
            if(indoorOffset[item.system]===undefined) indoorOffset[item.system] = 0;
            if(priceOffset[item.system]===undefined) priceOffset[item.system] = 0;
            result.indoorOffset = indoorOffset[item.system];
            result.weatherOffset = weatherOffset[item.system];
            result.priceOffset = priceOffset[item.system];
            for( var i = 0; i < item.registers.length; i++){
                if(item.registers[i].source!==undefined) {
                    if(item.registers[i].source=="mqtt") {
                        await nibe.getMQTTData(item.registers[i].register).then(atad => {
                            let data = Object.assign({}, atad);
                            let config = nibe.getConfig();
                            let sensor_timeout;
                            if(config.home===undefined) {
                                config.home = {};
                                nibe.setConfig(config);
                            }
                            if(config.home.sensor_timeout!==undefined && config.home.sensor_timeout!=="" && config.home.sensor_timeout!==0) {
                                sensor_timeout = data.timestamp+(config.home.sensor_timeout*60000);
                            } else if(config.home.sensor_timeout===0 || config.home.sensor_timeout===undefined || config.home.sensor_timeout==="") {
                                sensor_timeout = timeNow;
                            } else {
                                sensor_timeout = data.timestamp+(60*60000);
                            }
                            if(timeNow>sensor_timeout) {
                                sendError(text.extra_sensor,`${text.extra_sensor} ${item.registers[i].name} ${text.not_updated}`)
                            } else {
                                data.system = item.system;
                                data.timestamp = timeNow;
                                data.name = item.registers[i].name;
                                data.topic = item.registers[i].register;
                                result[item.registers[i].register] = data;
                                array.push(data)
                            }

                        },(error => {
                            sendError(text.extra_sensor,`${text.extra_sensor} ${item.registers[i].name} ${text.no_values}`)
                        }));
                    } else if(item.registers[i].source=="tibber") {
                        console.log('Tibber Data request');
                    } else if(item.registers[i].source=="nibe") {
                            await getNibeData(item.registers[i].register).then(atad => {
                                let data = Object.assign({}, atad);
                                data.system = item.system;
                                data.name = item.registers[i].name;
                                data.topic = item.registers[i].topic;
                                result[item.registers[i].topic] = data;
                                array.push(data)
                            }).catch(console.log)
                    }
                }
            }
            runIndoor(result,array);
            runPrice(result,array);
            runRMU(result,array);
            if(hourly===true) {
                result.array = array;
                runWeather(result);
            } else {
                result.array = array;
                if(nibe.getConfig().weather['enable_'+item.system]===true) {
                    nibeData.emit('pluginWeather',result);
                }
            }
            nibeData.emit('updateGraph');
        }
      }
        const checkWind = (array,hours) => {
        var output = {};
        let config = nibe.getConfig();
        if(config.weather===undefined) {
            config.weather = {};
            nibe.setConfig(config);
        }
          if(config.weather.wind_enable!==undefined && config.weather.wind_enable===true) {

            var wind_speed_arr = [];
            var wind_gust_arr = [];
            var temp_arr = [];
            var feel_arr = [];
            var direction_arr = [];
            const limit = Math.min(49, (Array.isArray(array) ? array.length : 0));
            for( var o = 0; o < limit; o++){
                const timeSeries = array[o];
                const timeString = getTimeString(timeSeries);
                if(timeString===undefined) continue;
                let timestamp = toTimestamp(timeString)
                let speed = Number(getParamValue(timeSeries, ['wind_speed','ws'], undefined));
                let dir = Number(getParamValue(timeSeries, ['wind_from_direction','wd'], undefined));
                let gust = Number(getParamValue(timeSeries, ['wind_speed_of_gust','i10fg','gust'], undefined));
                let temp = Number(getParamValue(timeSeries, ['air_temperature','2t','t'], undefined));
                if(!Number.isFinite(speed) || !Number.isFinite(dir) || !Number.isFinite(gust) || !Number.isFinite(temp)) continue;
                let direction = 0;
                let factor = 1;
                if(((1 <= dir) && (dir <= 45)) || ((315 <= dir) && (dir <= 360))) {
                    direction = -1;
                    if(config.weather.wind_factor_n===undefined) config.weather.wind_factor_n = 0; nibe.setConfig(config);
                    factor = config.weather.wind_factor_n;
                } else if(136 <= dir && dir <= 225) {
                    direction = -2;
                    if(config.weather.wind_factor_s===undefined) {config.weather.wind_factor_s = 0; nibe.setConfig(config);}
                    factor = config.weather.wind_factor_s;
                } else if(226 <= dir && dir <= 314) {
                    direction = -3;
                    if(config.weather.wind_factor_w===undefined) {config.weather.wind_factor_w = 0; nibe.setConfig(config);}
                    factor = config.weather.wind_factor_w;
                } else if(46 <= dir && dir <= 135) {
                    direction = -4;
                    if(config.weather.wind_factor_e===undefined) {config.weather.wind_factor_e = 0; nibe.setConfig(config);}
                    factor = config.weather.wind_factor_e;
                }
                let v = Math.pow(speed, 0.16);
                let feel = Number((13.12+(0.6215*temp)-(13.956*v)+(0.48669*temp*v)).toFixed(2));
                if(feel>0) {
                    feel = Number((feel/factor).toFixed(2));
                    if(feel>temp) {
                        feel = temp;
                    }
                } else {
                    feel = Number((feel*factor).toFixed(2));
                    if(feel>temp) {
                        feel = temp;
                    }
                }
                if(speed<2 || temp>10 || speed>35 || direction===0) feel = temp;
                wind_speed_arr.push({x:timestamp,y:Number(speed)});
                wind_gust_arr.push({x:timestamp,y:Number(gust)});
                temp_arr.push({x:timestamp,y:Number(temp)});
                feel_arr.push({x:timestamp,y:feel});
                direction_arr.push({x:timestamp,y:direction});
                    if(o===hours) {
                        output.feel = feel;
                    }
            }
                wind_speed_arr.sort((a, b) => (a.x > b.x) ? 1 : -1)
                wind_gust_arr.sort((a, b) => (a.x > b.x) ? 1 : -1)
                temp_arr.sort((a, b) => (a.x > b.x) ? 1 : -1)
                feel_arr.sort((a, b) => (a.x > b.x) ? 1 : -1)
                direction_arr.sort((a, b) => (a.x > b.x) ? 1 : -1)
                output.graph = [
                    {
                        "series":["Vindhastighet","Byvind","Utomhustemp","Köldeffekt","Riktning"],
                        "data":[wind_speed_arr,wind_gust_arr,temp_arr,feel_arr,direction_arr],
                        "labels":["Vindhastighet","Byvind","Utomhustemp","Köldeffekt","Riktning"]
                    }];
          } else {
              output.feel = undefined;
              output.graph = [];
          }
            return output;
        }
    const runWeather = async (val) => {
        nibe.log(`Startar Prognosreglering`,'weather','debug');
        let timeNow = Date.now();
        //var val = Object.assign({}, result);
        let config = nibe.getConfig();
        if(config.weather===undefined) {
            config.weather = {};
            nibe.setConfig(config);
        }
        if(config.weather!==undefined && config.weather['enable_'+val.system]===true) {
            if(config.weather.enable_up===undefined) {
                config.weather.enable_up = true
                nibe.setConfig(config);
            }
            if(config.weather.enable_down===undefined) {
                config.weather.enable_down = true
                nibe.setConfig(config);
            }
            let outside = val.outside.data;
            nibe.log(`Aktuell utomhustemperatur: ${outside}`,'weather','debug');
            if(val['heatcurve_'+val.system]===undefined) {
                console.log('Hämtar värmekurva manuellt.')
                val['heatcurve_'+val.system] = await getNibeData(hP['heatcurve_'+val.system]).catch(console.log)
            }
            if(val['heatcurve_'+val.system]===undefined) {
                nibe.log(`Kunde inte läsa värmekurvan, hoppar över prognosreglering.`,'weather','error');
                return;
            }
            let heatcurve = val['heatcurve_'+val.system].data;
            nibe.log(`Aktuell värmekurva: ${heatcurve}`,'weather','debug');
            let setOffset = val.weatherOffset;
            let lon = config.home.lon;
            let lat = config.home.lat;
            nibe.log(`Koordinater: (Latitud: ${config.home.lat}, Longitud: ${config.home.lon})`,'weather','debug');
            if(lon!==undefined && lat!==undefined && lon!="" && lat!="") {
                let hours = Number(config.home['hours_'+val.system]);
                if(!Number.isFinite(hours) || hours < 0) hours = 0;
                const tsCount = Math.max(49, hours + 1);
                const weatherUrl = `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${lon}/lat/${lat}/data.json?timeseries=${tsCount}&parameters=air_temperature,wind_speed,wind_from_direction,wind_speed_of_gust,symbol_code`;
                https.get(weatherUrl, (resp) => {
                    let data = '';
                    resp.on('data', (chunk) => {
                    data += chunk;
                    });
                    resp.on('end', () => {
                        if(resp.statusCode===200) {
                            let time = Number((Date.now()).toFixed())+(hours*3600000);
                            const astro = suncalc({lat:lat,lon:lon,timestamp:time})
                            var sunrise = toTimestamp(astro.sunrise)/1000;
                            var sunset = toTimestamp(astro.sunset)/1000;
                            var sunTime = Number((Date.now()/1000).toFixed())+(hours*3600);
                            let sun;
                            if(sunTime>sunrise && sunTime<sunset) {
                                nibe.log(`När prognosen infaller är det dag.`,'weather','debug');
                                sun = true;
                            } else {
                                nibe.log(`När prognosen infaller är det inte dag.`,'weather','debug');
                                sun = false;
                            }
                            try {
                                data = JSON.parse(data);
                            } catch(err) {
                                nibe.log(`Kunde inte tolka svar från SMHI: ${err.message}`,'weather','error');
                                if(weatherOffset[val.system]!==0) {
                                    nibe.log(`Sätter kurvjustering till 0`,'weather','debug');
                                    curveAdjust('weather',val.system,0);
                                    weatherOffset[val.system] = 0;
                                }
                                saveDataGraph('weather_offset_'+val.system,timeNow,0,true);
                                return;
                            }
                            if(!data || !Array.isArray(data.timeSeries) || data.timeSeries.length===0) {
                                nibe.log(`SMHI svarade utan prognosdata`,'weather','error');
                                if(weatherOffset[val.system]!==0) {
                                    nibe.log(`Sätter kurvjustering till 0`,'weather','debug');
                                    curveAdjust('weather',val.system,0);
                                    weatherOffset[val.system] = 0;
                                }
                                saveDataGraph('weather_offset_'+val.system,timeNow,0,true);
                                return;
                            }
                            if(hours > (data.timeSeries.length-1)) hours = (data.timeSeries.length-1);
                            let wind = checkWind(data.timeSeries,hours);
                            let windSet = wind.feel;
                            const timeSeriesNow = data.timeSeries[0];
                            const timeSeriesLater = data.timeSeries[hours];
                            const timeNowString = getTimeString(timeSeriesNow);
                            const timeLaterString = getTimeString(timeSeriesLater);
                            var tempPredicted = Number(getParamValue(timeSeriesLater, ['air_temperature','2t','t'], undefined));
                            var tempNow = Number(getParamValue(timeSeriesNow, ['air_temperature','2t','t'], undefined));
                            var weatherPredicted = Number(getParamValue(timeSeriesLater, ['symbol_code','Wsymb2'], 0));
                            if(!Number.isFinite(tempPredicted) || !Number.isFinite(tempNow) || timeNowString===undefined || timeLaterString===undefined) {
                                nibe.log(`SMHI svarade utan temperaturdata`,'weather','error');
                                if(weatherOffset[val.system]!==0) {
                                    nibe.log(`Sätter kurvjustering till 0`,'weather','debug');
                                    curveAdjust('weather',val.system,0);
                                    weatherOffset[val.system] = 0;
                                }
                                saveDataGraph('weather_offset_'+val.system,timeNow,0,true);
                                return;
                            }
                            const tempPredictedRaw = tempPredicted;
                            var sunFactor = 0;
                            if(config.weather.sun_enable!==undefined && config.weather.sun_enable===true) {
                                nibe.log(`Solfaktor aktiverad`,'weather','debug');
                                if(weatherPredicted===1 && sun===true) {
                                    if(config.weather.clear===undefined) { config.weather.clear = 0; nibe.setConfig(config); }
                                    sunFactor = config.weather.clear;
                                } else if(weatherPredicted===2 && sun===true) {
                                    if(config.weather.mostly_clear===undefined) { config.weather.mostly_clear = 0; nibe.setConfig(config); }
                                    sunFactor = config.weather.mostly_clear;
                                } else if(weatherPredicted===3 && sun===true) {
                                    if(config.weather.half_clear===undefined) { config.weather.half_clear = 0; nibe.setConfig(config); }
                                    sunFactor = config.weather.half_clear;
                                }
                                nibe.log(`Aktuell solfaktor är: ${sunFactor}`,'weather','debug');
                            }
                                    if(outside===undefined || heatcurve===undefined) {
                                        if(outside===undefined) nibe.log(`Saknar värde från utomhusgivare`,'weather','error');
                                        if(heatcurve===undefined) nibe.log(`Saknar värde från värmekurva`,'weather','error');
                                        return;
                                    }
                                    if(heatcurve===0) {
                                        nibe.log(`Prognosreglering fungerar inte med egen värmekurva.`,'weather','error');
                                        return;
                                    }
                                    if(config.weather.forecast_adjust===undefined) {
                                        config.weather.forecast_adjust = false;
                                        nibe.setConfig(config);
                                    }
                                    if(config.weather.forecast_adjust===true) {
                                        val.unfiltredTemp = {payload:tempPredictedRaw,timestamp:toTimestamp(timeLaterString)};
                                        tempPredicted = Number(((outside-tempNow)+tempPredicted).toFixed(2));
                                        if(windSet!==undefined) windSet = Number(((outside-tempNow)+windSet).toFixed(2));
                                    }

                                    const rawForecastGraph = [];
                                    const adjustedForecastGraph = [];
                                    const curveLimit = Math.min(data.timeSeries.length, Math.max(1, hours + 1));
                                    for(let i = 0; i < curveLimit; i++) {
                                        const curveTimeSeries = data.timeSeries[i];
                                        const curveTimeString = getTimeString(curveTimeSeries);
                                        const curveTemp = Number(getParamValue(curveTimeSeries, ['air_temperature','2t','t'], undefined));
                                        if(curveTimeString===undefined || !Number.isFinite(curveTemp)) continue;
                                        const curveTimestamp = toTimestamp(curveTimeString);
                                        rawForecastGraph.push({x:curveTimestamp,y:curveTemp});
                                        let adjustedCurveTemp = curveTemp;
                                        if(config.weather.forecast_adjust===true) {
                                            adjustedCurveTemp = Number(((outside-tempNow)+curveTemp).toFixed(2));
                                        }
                                        adjustedForecastGraph.push({x:curveTimestamp,y:adjustedCurveTemp});
                                    }
                                    rawForecastGraph.sort((a, b) => (a.x > b.x) ? 1 : -1);
                                    adjustedForecastGraph.sort((a, b) => (a.x > b.x) ? 1 : -1);
                                    if(rawForecastGraph.length>0) {
                                        const rawName = 'weather_unfilterd_'+val.system;
                                        const rawHistory = (Array.isArray(savedGraph[rawName]) ? savedGraph[rawName] : []).filter(point => point.x < timeNow);
                                        savedGraph[rawName] = rawHistory.concat(rawForecastGraph).sort((a, b) => (a.x > b.x) ? 1 : -1);
                                        savedData['weather_unfilterd_'+val.system] = {
                                            data:tempPredictedRaw,
                                            raw_data:tempPredictedRaw,
                                            timestamp:toTimestamp(timeLaterString)
                                        }
                                    }
                                    if(adjustedForecastGraph.length>0) {
                                        const adjustedName = 'weather_forecast_'+val.system;
                                        const adjustedHistory = (Array.isArray(savedGraph[adjustedName]) ? savedGraph[adjustedName] : []).filter(point => point.x < timeNow);
                                        savedGraph[adjustedName] = adjustedHistory.concat(adjustedForecastGraph).sort((a, b) => (a.x > b.x) ? 1 : -1);
                                        savedData['weather_forecast_'+val.system] = {
                                            data:tempPredicted,
                                            raw_data:tempPredicted,
                                            timestamp:toTimestamp(timeLaterString)
                                        }
                                    }

                                    if(config.weather.wind_enable!==undefined && config.weather.wind_enable===true) {
                                        nibe.log(`Vindstyrning aktiverad. Köldeffekt: ${windSet} grader`,'weather','debug');
                                        setOffset = Number(((outside-windSet-sunFactor)*(heatcurve*1.2/10)/((heatcurve/10)+1)).toFixed(2));
                                    } else {
                                        setOffset = Number(((outside-tempPredicted-sunFactor)*(heatcurve*1.2/10)/((heatcurve/10)+1)).toFixed(2));
                                    }
                                    // Lägg in blockering om höjning eller sänkning
                                    nibe.log(`Kollar om det är tillåtet att sänkas eller höjas.`,'weather','debug');
                                    if(setOffset > 0) {
                                        if(config.weather.enable_up===false) {
                                            nibe.log(`Ej tillåtet att höja.`,'weather','debug');
                                            setOffset = 0
                                        }
                                    } else {
                                        if(config.weather.enable_down===false) {
                                            nibe.log(`Ej tillåtet att sänka.`,'weather','debug');
                                            setOffset = 0
                                        }
                                    }
                                    nibe.log(`Utför kurvjustering, värde: ${setOffset}`,'weather','debug');
                                    curveAdjust('weather',val.system,setOffset);
                                    val.windGraph = wind.graph;
                                    val.weatherOffset = setOffset;
                                    weatherOffset[val.system] = setOffset;
                                    val.predictedNow = {payload:tempNow,timestamp:toTimestamp(timeNowString)};
                                    val.predictedLater = {payload:tempPredicted,timestamp:toTimestamp(timeLaterString)};
                                    nibe.log(`Sparar värde för prognos. (${tempPredicted} grader)`,'weather','debug');
                                    saveDataGraph('weather_offset_'+val.system,timeNow,val.weatherOffset,true);
                                    nibe.log(`Sparar värde för kurvjustering. (${val.weatherOffset})`,'weather','debug');
                                    let inside;
                                    if(config.weather['sensor_'+val.system]!==undefined && config.weather['sensor_'+val.system]!=="") {
                                        let index = val.array.findIndex(i => i.name == config.weather['sensor_'+val.system]);
                                        if(index!==-1) {
                                            inside = val.array[index];
                                        }
                                    }
                                    if(inside===undefined) inside = val['inside_'+val.system];
                                    if(inside===undefined || inside.data<-3276) {
                                        nibe.log(`Ingen inomhusgivare vald eller felaktigt värde.`,'weather','debug');
                                        //server.sendError('Prognosreglering',`Inomhusgivare saknas (${data.system}).`);
                                    }
                                    val.weatherSensor = inside;
                                    if(inside===undefined) inside = val['inside_'+val.system];
                                    if(inside!==undefined && inside.data>-3276) {
                                        nibe.log(`Sparar värde för vald inomhusgivare (${inside.data} grader)`,'weather','debug');
                                        saveDataGraph('weather_sensor_'+val.system,timeNow,inside.data,true);
                                    }

                                    nibeData.emit('pluginWeather',val);
                        } else {
                            nibe.log(`Väderleverantör svarar inte, problem med uppkopplingen eller felaktigt angivna koordinater`,'weather','error');
                            if(weatherOffset[val.system]!==0) {
                                nibe.log(`Sätter kurvjustering till 0`,'weather','debug');
                                curveAdjust('weather',val.system,0);
                                weatherOffset[val.system] = 0;
                            }
                            saveDataGraph('weather_offset_'+val.system,timeNow,0,true);
                        }
                    });

                }).on("error", (err) => {
                    nibe.log(err.message,'weather','error');
                });
            } else {
                nibe.log(`Inga koordinater inlagda.`,'weather','error');
                if(weatherOffset[val.system]!==0) {
                    nibe.log(`Sätter kurvjustering till 0`,'weather','debug');
                    curveAdjust('weather',val.system,0);
                    weatherOffset[val.system] = 0;
                }
                saveDataGraph('weather_offset_'+val.system,timeNow,0,true);
            }
        } else {
            nibe.log(`Prognosreglering inte aktiverat`,'weather','debug');
            if(weatherOffset[val.system]!==0) {
                nibe.log(`Sätter kurvjustering till 0`,'weather','debug');
                curveAdjust('weather',val.system,0);
                weatherOffset[val.system] = 0;
            }
            saveDataGraph('weather_offset_'+val.system,timeNow,0,true);
        }

    }
    const indoorArray = [];
    const runIndoor = (data,array) => {
        var timeNow = Date.now();
        //let data = Object.assign({}, result);
        let conf = nibe.getConfig();
        let inside_enable = data['inside_enable_'+data.system];
        let inside;
        if(conf.indoor===undefined) {
            conf.indoor = {};
            nibe.setConfig(conf);
        }
        if((inside_enable!==undefined && inside_enable.data!==undefined && inside_enable.data===1) || (conf.indoor['enable_'+data.system]!==undefined && conf.indoor['enable_'+data.system]===true)) {
            if(conf.indoor['enable_'+data.system]!==undefined && conf.indoor['enable_'+data.system]===true) {
                if(conf.indoor['sensor_'+data.system]!==undefined && conf.indoor['sensor_'+data.system]!=="") {
                let index = array.findIndex(i => i.name == conf.indoor['sensor_'+data.system]);
                if(index!==-1) {
                    inside = array[index];
                }
            }
            }
        if(inside===undefined) inside = data['inside_'+data.system];
        if(inside===undefined || inside.data===undefined || inside.data<4) {
            sendError('Inomhusreglering',`Inomhusgivare saknas (${data.system}), avbryter...`);
            return;
        }
        data.indoorSensor = inside;
        saveDataGraph('indoor_sensor_'+data.system,timeNow,inside.data,true)
        let inside_set = data['inside_set_'+data.system];
        let factor = data['inside_factor_'+data.system];
        let dM = data.dM;
        let dMstart = data.dMstart;
        // Calculate setpoint accuracy
        if(inside!==undefined) {
            indoorArray.unshift({set:inside_set.data,act:inside.data});
            if(indoorArray.length>=2016) indoorArray.pop();
            let sum = 0;
            for (const arr of indoorArray) {
                sum = sum+(arr.act/arr.set)
            }
            let result = sum/(indoorArray.length);
            data.accuracy = result;
        }
        // Restore degree minutes if the inside conditions are good.
        if(conf.system.pump!=="F370" && conf.system.pump!=="F470") {
            if(conf.indoor.dm_reset_enable===true) {
                if(conf.indoor.dm_reset_value===undefined) {
                    conf.indoor.dm_reset_value = -200;
                    nibe.setConfig(conf);
                }
                if((conf.indoor.dm_reset_enable_stop!==undefined && conf.indoor.dm_reset_enable_stop===true) && inside.data-conf.indoor.dm_reset_stop_diff > inside_set.data) {
                    if((dM.data<(dMstart.data+conf.indoor.dm_reset_value) || (dM.data > dMstart.data && dM.data < 50))) {
                        nibe.setData(dM.register,100);
                    }
                } else if((inside.data-conf.indoor.dm_reset_slow_diff > inside_set.data)) {
                    if(dM.data<(dMstart.data+conf.indoor.dm_reset_value)) {
                        nibe.setData(dM.register,dMstart.data);
                    }
                }
            }
        } else {
            // Non compatible heatpump
            if(conf.indoor.dm_reset_enable===true) {
                conf.indoor.dm_reset_enable = false;
                nibe.setConfig(conf);
            }
            if(conf.indoor.dm_reset_enable_stop===true) {
                conf.indoor.dm_reset_enable_stop = false;
                nibe.setConfig(conf);
            }
        }
            if(conf.indoor['enable_'+data.system]!==undefined && conf.indoor['enable_'+data.system]===true) {
                var setOffset = Number((((inside_set.data)-inside.data)*factor.data).toFixed(2));
                data.indoorOffset = setOffset;
                indoorOffset[data.system] = setOffset;
                curveAdjust('indoor',data.system,setOffset);
            } else {
                if(indoorOffset[data.system]!==0) {
                    indoorOffset[data.system] = 0;
                    curveAdjust('indoor',data.system,0);
                }
                data.indoorOffset = 0;
            }
            saveDataGraph('indoor_offset_'+data.system,timeNow,setOffset,true)
            nibeData.emit('pluginIndoor',data);
        } else {
            if(indoorOffset[data.system]!==0) {
                indoorOffset[data.system] = 0;
                curveAdjust('indoor',data.system,0);
            }
            data.indoorOffset = 0;
            saveDataGraph('indoor_offset_'+data.system,timeNow,setOffset,true)
        }
    }
    const priceAdjustCurve = async (dataIn) => {
        var data = Object.assign({}, dataIn);
        let system = data.system;
        let inside = data.priceSensor;
        nibe.log(`Startar elprisjustering priceAdjustCurve() för ${data.system}`,'price','debug');
        let config = nibe.getConfig();


            // Defaults for VAT and AI display surcharge (in öre).
            if (config.price.vat === undefined) { config.price.vat = 0.25; }
            if (config.price.addition_ore === undefined) { config.price.addition_ore = 88.01; } // you can change this in config
if(config.price===undefined) {
            config.price = {};
            nibe.setConfig(config);
        }
        if(config.price['temp_low_'+system]===undefined) {
            config.price['temp_low_'+system] = 0;
            nibe.setConfig(config);
        }
        if(data.price_level===undefined) {
            var hw_level = data.hw_price_level.data
            var heat_level = data.heat_price_level.data
            let hw_enable = config.price.hotwater_enable;
            let heat_enable = config.price['enable_heat_'+system];
            // Justera VV
             if(hw_level!==undefined && hw_level!==0) {
                var hw_adjust;
                nibe.log(`Varmvatten: ${hw_enable}`,'price','debug');
                if(hw_level=="VERY_CHEAP") {
                    nibe.log(`Nivån är väldigt billig`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) {
                        hw_adjust = Number(config.price.hotwater_very_cheap);
                    }


                } else if(hw_level=="CHEAP") {
                    nibe.log(`Nivån är billig`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) {
                        hw_adjust = Number(config.price.hotwater_cheap);
                    }

                } else if(hw_level=="NORMAL") {
                    nibe.log(`Nivån är normal`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) {
                        hw_adjust = Number(config.price.hotwater_normal);
                    }
                } else if(hw_level=="EXPENSIVE") {
                    nibe.log(`Nivån är dyr`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) {
                        hw_adjust = Number(config.price.hotwater_expensive);
                    }
                } else if(hw_level=="VERY_EXPENSIVE") {
                    nibe.log(`Nivån är väldigt dyr`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) {
                        hw_adjust = Number(config.price.hotwater_very_expensive);
                    }

                }
                if(hw_adjust!==undefined) {
                    nibe.reqData(hP.hw_mode).then(result => {
                        if(result.raw_data!==hw_adjust) nibe.setData(hP.hw_mode,hw_adjust);
                    }).catch(console.log)
                }
            } else {
                sendError('Elprisreglering',`Kunde ej hämta prisnivå från värmepumpen eller funktion avstängd.`);


            }
            // Justera värme
            if(heat_level!==undefined && heat_level!==0) {
                let temp_diff = config.price['temp_low_'+system];
                let heat_adjust = 0;

                nibe.log(`Värme: ${heat_enable}`,'price','debug');
                if(data['inside_set_'+system]!==undefined) {
                    nibe.log(`Lägsta inomhustemperatur: ${data['inside_set_'+system].data+temp_diff} grader`,'price','debug');
                }
                if(heat_level=="VERY_CHEAP") {
                    nibe.log(`Nivån är väldigt billig`,'price','debug');

                    if(heat_enable!==undefined && heat_enable===true) if(config.price['heat_very_cheap_'+system]!==undefined) heat_adjust = config.price['heat_very_cheap_'+system];
                } else if(heat_level=="CHEAP") {
                    nibe.log(`Nivån är billig`,'price','debug');
                    if(heat_enable!==undefined && heat_enable===true) if(config.price['heat_cheap_'+system]!==undefined) heat_adjust = config.price['heat_cheap_'+system];
                } else if(heat_level=="NORMAL") {
                    nibe.log(`Nivån är normal`,'price','debug');
                    if(config.price['heat_normal_'+system]!==undefined) heat_adjust = config.price['heat_normal_'+system];
                } else if(heat_level=="EXPENSIVE") {
                    nibe.log(`Nivån är dyr`,'price','debug');
                    if(inside!==undefined && (inside.data>(data['inside_set_'+system].data+temp_diff)) || config.price['enable_temp_'+system]===undefined || config.price['enable_temp_'+system]===false) {
                    if(heat_enable!==undefined && heat_enable===true) {
                        if(config.price['heat_expensive_'+system]!==undefined) {
                            heat_adjust = config.price['heat_expensive_'+system];
                            nibe.log(`Justerar värmen ${heat_adjust}`,'price','debug');
                        }
                    }
                    }
                } else if(heat_level=="VERY_EXPENSIVE") {
                    nibe.log(`Nivån är väldigt dyr`,'price','debug');
                    if(heat_enable!==undefined && heat_enable===true) {
                        if(inside!==undefined && (inside.data>(data['inside_set_'+system].data+temp_diff)) || config.price['enable_temp_'+system]===undefined || config.price['enable_temp_'+system]===false) {
                            if(config.price['heat_very_expensive_'+system]!==undefined) heat_adjust = config.price['heat_very_expensive_'+system];
                        }
                    }
                }
                if(config.price.enable_freq===true) {
                    await lockFreq({heat:heat_adjust}).then(result => {
                        if(result!==null) nibe.log(`Frekvensen sänkt till ${result} hz`,'price','debug');
                        if(result===null) nibe.log(`Frekvensen ej längre sänkt`,'price','debug');
                    }).catch(async err => {
                        nibe.log(err,'price','debug');
                        blockAdditive({heat:heat_adjust}).then(result => {
                        }).catch(async err => {
                            nibe.log(`Värmepump stödjer inte stopp via gradminuter`,'price','debug');
                        })
                    })
                } else if(config.price.enable_dM_reset) {
                    blockAdditive({heat:heat_adjust}).then(result => {
                    }).catch(async err => {
                        nibe.log(`Värmepump stödjer inte stopp via gradminuter`,'price','debug');
                    })
                }

                priceOffset[system] = heat_adjust;
                curveAdjust('price',system,heat_adjust);
            } else {
                sendError('Elprisreglering',`Kunde ej hämta prisnivå från värmepumpen eller funktion avstängd.`);
                if(priceOffset[system]!==0) {
                    priceOffset[system] = 0;
                    curveAdjust('price',system,0);
                }

            }
        } else {

// PATCH: robust price level lookup (supports price_level, heat_price_level, priceai.heat)
let level = null;
try {
  level = (data && data.heat_price_level && data.heat_price_level.data) ||
          (data && data.price_level && data.price_level.data) ||
          (data && data.priceai && data.priceai.heat && data.priceai.heat.level) ||
          null;
} catch(e) { level = null; }
if (typeof level === "string" && /^-?\d+(\.\d+)?$/.test(level)) level = Number(level);

            if(level!==undefined && level!==0) {
                let hw_enable = config.price.hotwater_enable;
                let heat_enable = config.price['enable_heat_'+system];
                let temp_diff = config.price['temp_low_'+system];
                let hw_adjust;
                let heat_adjust = 0;

                nibe.log(`Varmvatten: ${hw_enable}, Värme: ${heat_enable}`,'price','debug');
                if(data['inside_set_'+system]!==undefined) {
                    nibe.log(`Lägsta inomhustemperatur: ${data['inside_set_'+system].data+temp_diff} grader`,'price','debug');
                }
                if(level=="VERY_CHEAP") {
                    nibe.log(`Nivån är väldigt billig`,'price','debug');

                    if(hw_enable!==undefined && hw_enable===true) hw_adjust = Number(config.price.hotwater_very_cheap);
                    if(heat_enable!==undefined && heat_enable===true) {
                        if(config.price['heat_very_cheap_'+system]!==undefined) heat_adjust = config.price['heat_very_cheap_'+system];
                        if(config.system.pump!=="F370" && config.system.pump!=="F470") {
                            if(heat_adjust!==0) {
                                if(data.dM===undefined) {
                                    data.dM = await getNibeData(hP['dM']).catch(console.log)
                                }
                                if(data.dM.data > 0 && data.dM.data > data.dMstart.data+25) {
                                    nibe.log(`Ställer in gradminuter nära start ${data.dMstart.data+25}`,'price','debug');
                                    nibe.setData(hP['dM'],(data.dMstart.data+25));
                                }

                            }
                        }
                    }
                } else if(level=="CHEAP") {
                    nibe.log(`Nivån är billig`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) hw_adjust = Number(config.price.hotwater_cheap);
                    if(heat_enable!==undefined && heat_enable===true) {
                        if(config.price['heat_cheap_'+system]!==undefined) heat_adjust = config.price['heat_cheap_'+system];
                        if(config.system.pump!=="F370" && config.system.pump!=="F470") {
                            if(heat_adjust!==0) {
                                if(data.dM===undefined) {
                                    data.dM = await getNibeData(hP['dM']).catch(console.log);
                                }
                                if(data.dM.data > 0 && data.dM.data > data.dMstart.data+25) {
                                    nibe.log(`Ställer in gradminuter nära start ${data.dMstart.data+25}`,'price','debug');
                                    nibe.setData(hP['dM'],(data.dMstart.data+25));
                                }
                            }
                        }
                    }
                } else if(level=="NORMAL") {
                    nibe.log(`Nivån är normal`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) hw_adjust = Number(config.price.hotwater_normal);
                    if(config.price['heat_normal_'+system]!==undefined) heat_adjust = config.price['heat_normal_'+system];
                } else if(level=="EXPENSIVE") {

                    nibe.log(`Nivån är dyr`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) hw_adjust = Number(config.price.hotwater_expensive);
                    if(inside!==undefined && (inside.data>(data['inside_set_'+system].data+temp_diff)) || config.price['enable_temp_'+system]===undefined || config.price['enable_temp_'+system]===false) {
                    if(heat_enable!==undefined && heat_enable===true) {
                        if(config.price['heat_expensive_'+system]!==undefined) {
                            heat_adjust = config.price['heat_expensive_'+system];
                            nibe.log(`Justerar värmen ${heat_adjust}`,'price','debug');
                        }
                    }
                    }
                } else if(level=="VERY_EXPENSIVE") {
                    nibe.log(`Nivån är väldigt dyr`,'price','debug');
                    if(hw_enable!==undefined && hw_enable===true) hw_adjust = Number(config.price.hotwater_very_expensive);
                    if(heat_enable!==undefined && heat_enable===true) {
                        if(inside!==undefined && (inside.data>(data['inside_set_'+system].data+temp_diff)) || config.price['enable_temp_'+system]===undefined || config.price['enable_temp_'+system]===false) {
                            if(config.price['heat_very_expensive_'+system]!==undefined) heat_adjust = config.price['heat_very_expensive_'+system];
                        }
                    }
                }
                if(config.price.enable_freq===true) {
                    await lockFreq({heat:heat_adjust}).then(result => {
                        if(result!==null) nibe.log(`Frekvensen sänkt till ${result} hz`,'price','debug');
                        if(result===null) nibe.log(`Frekvensen ej längre sänkt`,'price','debug');
                    }).catch(async err => {
                        nibe.log(err,'price','debug');
                        blockAdditive({heat:heat_adjust}).then(result => {

                        }).catch(async err => {
                            nibe.log(`Värmepump stödjer inte stopp via gradminuter`,'price','debug');
                        })
                    })
                } else if(config.price.enable_dM_reset) {
                    blockAdditive({heat:heat_adjust}).then(result => {
                    }).catch(async err => {
                        nibe.log(`Värmepump stödjer inte stopp via gradminuter`,'price','debug');
                    })
                }
                priceOffset[system] = heat_adjust;
                curveAdjust('price',system,heat_adjust);
                if(hw_adjust!==undefined) {
                    nibe.reqData(hP.hw_mode).then(result => {
                        if(result.raw_data!==hw_adjust) nibe.setData(hP.hw_mode,hw_adjust);
                    }).catch(console.log)
                }
            } else {
                sendError('Elprisreglering',`Kunde ej hämta prisnivå från värmepumpen.`);
                if(priceOffset[system]!==0) {
                    priceOffset[system] = 0;
                    await lockFreq({heat:0}).then(result => {
                        if(result!==null) nibe.log(`Frekvensen sänkt till ${result} hz`,'price','debug');
                        if(result===null) nibe.log(`Frekvensen ej längre sänkt`,'price','debug');
                    }).catch(async err => {
                        nibe.log(err,'price','debug');
                        blockAdditive({heat:0}).then(result => {

                        }).catch(async err => {
                            nibe.log(`Värmepump stödjer inte stopp via gradminuter`,'price','debug');
                        })
                    })
                    curveAdjust('price',system,0);
                }

            }
        }

    }
    let nibeGraph = [];
    let nibeGraphAdjust = [];
    function nibeBuildGraph(data,system) {
        if(data.price_level.raw_data!==0) {
            if(nibeGraph.length>600) nibeGraph.shift();
            if(nibeGraphAdjust.length>600) nibeGraphAdjust.shift();
            let config = nibe.getConfig();
            if(config.price===undefined) {
                config.price = {};
                nibe.setConfig(config);
            }
            let heat_enable = config.price['enable_heat_'+system];
            var heat_adjust = 0;
            if(data.price_level.data=="CHEAP") {
                if(heat_enable!==undefined && heat_enable===true) if(config.price['heat_cheap_'+system]!==undefined) heat_adjust = config.price['heat_cheap_'+system];
            } else if(data.price_level.data=="NORMAL") {
                if(heat_enable!==undefined && heat_enable===true) if(config.price['heat_normal_'+system]!==undefined) heat_adjust = config.price['heat_normal_'+system];
            } else if(data.price_level.data=="EXPENSIVE") {
                if(heat_enable!==undefined && heat_enable===true) if(config.price['heat_expensive_'+system]!==undefined) heat_adjust = config.price['heat_expensive_'+system];
            }
            nibeGraph.push({x:data.price_current.timestamp,y:Number(data.price_current.data)});
            nibeGraphAdjust.push({x:data.price_current.timestamp,y:Number(heat_adjust)})
            nibeGraph.sort((a, b) => (a.x > b.x) ? 1 : -1)
            nibeGraphAdjust.sort((a, b) => (a.x > b.x) ? 1 : -1)
            var sendArray = [
                {
                    "series":["Pris","Kurvjustering"],
                    "data":[nibeGraph,nibeGraphAdjust],
                    "labels":["Pris","Kurvjustering"]
                }];
            let result = {values:sendArray,system:system};
            return result;
        } else {
            let result = {values:[],system:system};
            return result;
        }

    }
    function priceBuildPoolGraph(prices,system) {
        let config = nibe.getConfig();
        if(config.price===undefined) {
            config.price = {};
            nibe.setConfig(config);
        }
        var priceArray = prices.prices
        priceArray.sort(function(a,b){return a.value - b.value});

        var valueArray = [];
        var adjustArray = [];
        for( var o = 0; o < priceArray.length; o++){
            let timestamp = priceArray[o].ts
            var adjust = 0;
            let baseKr = (priceArray[o].value/100);
            let value = Number(((baseKr*(1+((config.price&&typeof config.price.vat==="number")?config.price.vat:0.25))) + (((config.price&&typeof config.price.addition_ore==="number")?config.price.addition_ore:88.01)/100)).toFixed(2));
            if(config.price[`${priceArray[o].level}_POOL_HEAT`]!==undefined) {
                adjust = config.price[`${priceArray[o].level}_POOL_HEAT`]
            }
            valueArray.push({x:timestamp,y:Number(value)});
            adjustArray.push({x:timestamp,y:Number(adjust.toFixed(2))})

        }
        valueArray.sort((a, b) => (a.x > b.x) ? 1 : -1)
        adjustArray.sort((a, b) => (a.x > b.x) ? 1 : -1)

        var sendArray = [
            {
                "series":["Pris","Kurvjustering"],
                "data":[valueArray,adjustArray],
                "labels":["Pris","Kurvjustering"]
            }];
        let result = {values:sendArray,system:system};
        return result;
    }
    function priceaiBuildGraph(heat,hw,data,prio_add_enable) {
        var system = data.system
        let config = nibe.getConfig();

        // Apply VAT and AI-only markup (öre) to chart values (shown in SEK). Tibber graph stays unchanged.
        const vatRate = (config.price && typeof config.price.vat === "number") ? config.price.vat : 0.25;
        const additionOre = (config.price && typeof config.price.addition_ore === "number") ? config.price.addition_ore : 88.01;

if(config.price===undefined) {
            config.price = {};
            nibe.setConfig(config);
        }
        let heat_enable = config.price['enable_heat_'+system];
        var priceArrayHeat = heat.prices
        priceArrayHeat.sort(function(a,b){return a.value - b.value});
        var priceArrayHW = hw.prices
        priceArrayHW.sort(function(a,b){return a.value - b.value});

        var valueArray = [];
        var adjustArrayHeat = [];
        var adjustArrayHW = [];
        for( var o = 0; o < priceArrayHeat.length; o++){
            let timestamp = priceArrayHeat[o].ts
            var adjust = 0;
            let hotwater_adjust = Number(config.price.hotwater_normal);
            let baseKr = (priceArrayHeat[o].value/100);
            const __own = !!(config && config.price && config.price.enable_own_price);
const __applyVat = !!(config && config.price && config.price.apply_vat === true);
let value = Number((__own ? (baseKr * (__applyVat ? (1 + vatRate) : 1) + (additionOre/100)) : baseKr).toFixed(2));
            if(priceArrayHeat[o].level=="VERY_CHEAP") {
                hotwater_adjust = Number(config.price.hotwater_very_cheap);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_very_cheap_'+system]||0;
            } else if(priceArrayHeat[o].level=="CHEAP") {
                hotwater_adjust = Number(config.price.hotwater_cheap);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_cheap_'+system]||0;
            } else if(priceArrayHeat[o].level=="NORMAL") {
                hotwater_adjust = Number(config.price.hotwater_normal);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_normal_'+system]||0;
            } else if(priceArrayHeat[o].level=="EXPENSIVE") {
                hotwater_adjust = Number(config.price.hotwater_expensive);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_expensive_'+system]||0;
            } else if(priceArrayHeat[o].level=="VERY_EXPENSIVE") {
                hotwater_adjust = Number(config.price.hotwater_very_expensive);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_very_expensive_'+system]||0;
            }
            valueArray.push({x:timestamp,y:Number(value)});
            adjustArrayHeat.push({x:timestamp,y:Number(adjust.toFixed(2))})

        }
        for( var o = 0; o < priceArrayHW.length; o++){
            let timestamp = priceArrayHW[o].ts
            let hotwater_adjust = Number(config.price.hotwater_normal);
            if(priceArrayHW[o].level=="VERY_CHEAP") {
                hotwater_adjust = Number(config.price.hotwater_very_cheap);
            } else if(priceArrayHW[o].level=="CHEAP") {
                hotwater_adjust = Number(config.price.hotwater_cheap);
            } else if(priceArrayHW[o].level=="NORMAL") {
                hotwater_adjust = Number(config.price.hotwater_normal);
            } else if(priceArrayHW[o].level=="EXPENSIVE") {
                hotwater_adjust = Number(config.price.hotwater_expensive);
            } else if(priceArrayHW[o].level=="VERY_EXPENSIVE") {
                hotwater_adjust = Number(config.price.hotwater_very_expensive);
            }
            adjustArrayHW.push({x:timestamp,y:Number(hotwater_adjust.toFixed(2))})

        }
        valueArray.sort((a, b) => (a.x > b.x) ? 1 : -1)
        adjustArrayHeat.sort((a, b) => (a.x > b.x) ? 1 : -1)
        adjustArrayHW.sort((a, b) => (a.x > b.x) ? 1 : -1)

        var sendArray = [
            {
                "series":["Pris","Värmejustering","Varmvattenläge"],
                "data":[valueArray,adjustArrayHeat,adjustArrayHW],
                "labels":["Pris","Värmejustering","Varmvattenläge"]
            }];
            if(prio_add_enable!==undefined) {
                if(config.price.prio_enable===true) {
                    nibe.log(`Prioriterad tillsats är aktiverad som elprisreglering, skapar graf`,'price','debug');
                    var prioArray = [];
                    let fee = config.price.prio_tax+config.price.prio_transfer
                    let cop = config.price.prio_cop
                    let cost = config.price.prio_cost
                    for( var o = 0; o < priceArrayHeat.length; o++){
                        let timestamp = priceArrayHeat[o].ts
                        var adjust = 0;
                        let price = Number((priceArrayHeat[o].value).toFixed(2));
                        if(price+fee > cost*cop) {
                            // Reglering
                            prioArray.push({x:timestamp,y:10})
                        } else {
                            // Ingen reglering
                            prioArray.push({x:timestamp,y:0})

                        }
                    }
                    prioArray.sort((a, b) => (a.x > b.x) ? 1 : -1)
                    sendArray[0].series.push('Prio. tillsats')
                    sendArray[0].data.push(prioArray)
                    sendArray[0].labels.push('Prio. tillsats')
                }
            }
        let result = {values:sendArray,system:system};
        return result;
    }
    function tibberBuildGraph(tibber,system) {
        let config = nibe.getConfig();
        if(config.price===undefined) {
            config.price = {};
            nibe.setConfig(config);
        }
        if(config.price.tibber_home===undefined) {
            config.price.tibber_home = 0
            nibe.setConfig(config);
        }
        let heat_enable = config.price['enable_heat_'+system];
        var today = tibber.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.today;
        var tomorrow;
        if(tibber.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.tomorrow!==undefined) {
            tomorrow = tibber.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.tomorrow;
        }
        var priceArray = today.concat(tomorrow);
        priceArray.sort(function(a,b){return a.energy - b.energy});
        if(tibber.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.tomorrow!==undefined) {
            tomorrow = tibber.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.tomorrow;
        }
        var valueArray = [];
        var adjustArray = [];
        for( var o = 0; o < priceArray.length; o++){
            let timestamp = toTimestamp(priceArray[o].startsAt)
            var adjust = 0;
            let hotwater_adjust = Number(config.price.hotwater_normal);
            let value = Number(priceArray[o].energy.toFixed(2));
            if(priceArray[o].level=="VERY_CHEAP") {
                hotwater_adjust = Number(config.price.hotwater_very_cheap);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_very_cheap_'+system]||0;
            } else if(priceArray[o].level=="CHEAP") {
                hotwater_adjust = Number(config.price.hotwater_cheap);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_cheap_'+system]||0;
            } else if(priceArray[o].level=="NORMAL") {
                hotwater_adjust = Number(config.price.hotwater_normal);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_normal_'+system]||0;
            } else if(priceArray[o].level=="EXPENSIVE") {
                hotwater_adjust = Number(config.price.hotwater_expensive);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_expensive_'+system]||0;
            } else if(priceArray[o].level=="VERY_EXPENSIVE") {
                hotwater_adjust = Number(config.price.hotwater_very_expensive);
                if(heat_enable!==undefined && heat_enable===true) adjust = config.price['heat_very_expensive_'+system]||0;
            }
            valueArray.push({x:timestamp,y:Number(value)});
            adjustArray.push({x:timestamp,y:Number(adjust.toFixed(2))})

        }
        valueArray.sort((a, b) => (a.x > b.x) ? 1 : -1)
        adjustArray.sort((a, b) => (a.x > b.x) ? 1 : -1)

        var sendArray = [
            {
                "series":["Pris","Kurvjustering"],
                "data":[valueArray,adjustArray],
                "labels":["Pris","Kurvjustering"]
            }];
        let result = {values:sendArray,system:system};
        return result;
    }

///////##########################################################
// ##################################################################
// # START: Algoritm från energy.anerdins-iot.se (ORIGINAL-LOGIK)   #
// ##################################################################

function findTradingOpportunities(sortedPrices, originalData, config) {
    const opportunities = [];

    // ##################################################################
    // # START: KORRIGERING FÖR FLEXIBEL UPPLÖSNING                     #
    // ##################################################################
    let slotsInWindow = config.timeWindow; // Standardvärde ifall något går fel

    // Beräkna hur många minuter varje datapunkt representerar (60 för timme, 15 för kvart)
    if (originalData.length > 1) {
        const slotDurationMinutes = (originalData[1].ts - originalData[0].ts) / 60000;
        if (slotDurationMinutes > 0) {
            // Beräkna hur många "slots" som ryms i den angivna tidshorisonten i timmar
            slotsInWindow = Math.round((config.timeWindow * 60) / slotDurationMinutes);
        }
    }
    nibe.log(`[DEBUG Algorithm] Tidshorisont är ${config.timeWindow} timmar, vilket motsvarar ${slotsInWindow} datapunkter.`, 'price', 'debug');
    // ##################################################################
    // # SLUT: KORRIGERING                                              #
    // ##################################################################

    for (const lowPoint of sortedPrices) {
        let buyIndex = -1;
        for (let j = 0; j < originalData.length; j++) {
            if (lowPoint.ts === originalData[j].ts) {
                buyIndex = j;
                break;
            }
        }

        if (buyIndex === -1) continue;

         // Använder den nya, korrekt beräknade tidshorisonten
        const endIndex = Math.min(buyIndex + slotsInWindow, originalData.length);


        for (let sellIndex = buyIndex + 1; sellIndex < endIndex; sellIndex++) {
            const spread = originalData[sellIndex].value - lowPoint.value;

            if (spread > config.minSpread) {
                opportunities.push({
                    buy: lowPoint,
                    sell: originalData[sellIndex],
                    spread: spread
                });
            }
        }
    }
    const sortedOpportunities = opportunities.sort((a, b) => b.spread - a.spread);
    if (sortedOpportunities.length > 0) {
        nibe.log(`[DEBUG] Bästa funna affär: Köp för ${sortedOpportunities[0].buy.value.toFixed(2)} öre, Sälj för ${sortedOpportunities[0].sell.value.toFixed(2)} öre, Spread: ${sortedOpportunities[0].spread.toFixed(2)} öre`, 'price', 'debug');
    }
    return sortedOpportunities;
}

/**
 * Hittar den optimala kombinationen av handelsmöjligheter (ORIGINAL-VERSION)
 * @private
 */
function findOptimalCombination(opportunities) {
    if (opportunities.length === 0) return [];

    const combinations = [];

    // För varje möjlighet, bygg en kombination av icke-överlappande handel
    for (let i = 0; i < opportunities.length; i++) {
        const combination = [opportunities[i]];

        for (let j = 0; j < opportunities.length; j++) {
            if (i === j) continue;

            // Kontrollerar om en affär överlappar med någon i den nuvarande kombinationen
            const hasConflict = combination.some(trade =>
                trade.buy.ts === opportunities[j].buy.ts ||
                trade.sell.ts === opportunities[j].sell.ts ||
                trade.buy.ts === opportunities[j].sell.ts ||
                trade.sell.ts === opportunities[j].buy.ts
            );

            if (!hasConflict) {
                combination.push(opportunities[j]);
            }
        }

        const totalProfit = combination.reduce((sum, trade) => sum + trade.spread, 0);
        combinations.push({
            trades: combination,
            totalProfit: totalProfit
        });
    }

    // Returnera kombinationen med högst total profit
    combinations.sort((a, b) => b.totalProfit - a.totalProfit);
    //return combinations[0]?.trades || [];
    // KORRIGERING: Ersätter "combinations[0]?.trades" med en säkrare variant.
    return combinations.length > 0 ? combinations[0].trades : [];
}


function formatResult(optimalTrades) {
    const buyPoints = [];
    const sellPoints = [];

    for (const trade of optimalTrades) {
        buyPoints.push(trade.buy);
        sellPoints.push(trade.sell);
    }

    return {
        buy: buyPoints,
        sell: sellPoints
    };
}

function optimizeElectricityTrading(priceData, options = {}) {
    if (!Array.isArray(priceData) || priceData.length === 0) {
        return { buy: [], sell: [] };
    }

    const config = {
        timeWindow: Number(options.timeWindow) || 12,
        // KORRIGERAD: Använder 20 (ören) som standard, enligt originalet.
        minSpread: Number(options.minSpread) || 20
    };

    const sortedByPrice = [...priceData].sort((a, b) => a.value - b.value);
    const totalSpread = sortedByPrice[sortedByPrice.length - 1].value - sortedByPrice[0].value;

    if (totalSpread <= config.minSpread) {
        return { buy: [], sell: [] };
    }

    const tradingOpportunities = findTradingOpportunities(
        sortedByPrice,
        priceData,
        config
    );

    if (tradingOpportunities.length === 0) {
        return { buy: [], sell: [] };
    }

    const optimalCombination = findOptimalCombination(tradingOpportunities);
    return formatResult(optimalCombination);
}

// ##################################################################
// # SLUT: Algoritm                                                 #
// ##################################################################

// runPrice, nu med 15-min stöd och dynamisk hantering av sommar-/vintertid
async function runPrice(data,array) {

    nibe.log(`Startar elprisreglering runPrice()`,'price','debug');
    let config = nibe.getConfig();
    let inside;
    nibe.log(`Letar efter givare ${config.price['sensor_'+data.system]}`,'price','debug');
    if(config.price['sensor_'+data.system]!==undefined && config.price['sensor_'+data.system]!=="") {
        let index = array.findIndex(i => i.name == config.price['sensor_'+data.system]);
        if(index!==-1) {
            inside = array[index];
            nibe.log(`Sätter inomhusgivare ${config.price['sensor_'+data.system]}, ${inside.data} grader`,'price','debug');
        }
    }
    data.priceSensor = inside;
    if(config.price!==undefined && config.price.enable===true) {
        nibe.log(`Elprisreglering är aktiverad`,'price','debug');
        if(config.price.source=="tibber") {
            nibe.log(`Källan är Lokal AI via Tibber`,'price','debug');

            if(config.price.token === undefined || config.price.token === "") {
                sendError('Lokal AI',`Tibber Token krävs för att hämta prisdata.`);
                return;
            }

            try {
                const tibberToken = config.price.token;
                const tibberOptions = {
                    hostname: 'api.tibber.com',
                    port: 443,
                    path: '/v1-beta/gql',
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${tibberToken}`, 'Content-Type': 'application/json' }
                };

                const tibberRequest = JSON.stringify({
                    query: "{\
                        viewer {\
                            homes {\
                            currentSubscription {\
                                priceInfo(resolution: QUARTER_HOURLY) {\
                                today{\
                                    startsAt\
                                    total\
                                }\
                                tomorrow {\
                                    startsAt\
                                    total\
                                }\
                                }\
                            }\
                            }\
                        }\
                        }"
                });

                const priceResult = await getCloudData(tibberOptions, tibberRequest);
                if (!priceResult || !priceResult.data || !priceResult.data.viewer) {
                    nibe.log(`Tibber API returnerade ett fel eller ingen data. Svar: ${JSON.stringify(priceResult)}`, 'price', 'error');
                    sendError('Lokal AI', 'Kunde inte hämta prisdata från Tibber. Kontrollera token och abonnemang.');
                    return;
                }

                const priceInfo = priceResult.data.viewer.homes[config.price.tibber_home || 0].currentSubscription.priceInfo;

                const quarterlyPriceList = (priceInfo.today || []).concat(priceInfo.tomorrow || []);
                if (quarterlyPriceList.length === 0) {
                    nibe.log('Ingen prisdata alls tillgänglig.', 'price', 'warn');
                    return;
                }
                
                // ##################################################################
                // # START: Logik för att konvertera kvartspriser till timpriser    #
                // ##################################################################
                const hourlyPriceList = [];
                // Gruppera hela objekt (inte bara priset) för att komma åt tidsstämpeln senare
                const groupedByHour = quarterlyPriceList.reduce((acc, price) => {
                    const hour = price.startsAt.substring(0, 13); // "2025-09-30T10"
                    if (!acc[hour]) {
                        acc[hour] = [];
                    }
                    acc[hour].push(price); 
                    return acc;
                }, {});



                for (const hour in groupedByHour) {
                    const itemsInHour = groupedByHour[hour];
                    // Beräkna snittet
                    const averagePrice = itemsInHour.reduce((sum, p) => sum + p.total, 0) / itemsInHour.length;
                    
                    // Dynamisk tidszon: Hämta slutet på datumsträngen från första kvarten i timmen
                    // Exempel in: "2025-11-25T10:00:00.000+01:00" -> Vi tar ".000+01:00"
                    const timeZoneSuffix = itemsInHour[0].startsAt.slice(19);

                    hourlyPriceList.push({
                        startsAt: `${hour}:00:00${timeZoneSuffix}`,
                        total: averagePrice
                    });
                }
                nibe.log(`Hämtade ${quarterlyPriceList.length} kvartspunkter och konverterade till ${hourlyPriceList.length} stabila timpunkter.`, 'price', 'debug');
                const fullPriceList = hourlyPriceList;
                // VV-AI: cacha timpriser i RAM för VV-analys (ingen SD-skrivning)
                vvAiPriceCache = fullPriceList;
                // ##################################################################
                // # SLUT PÅ KONVERTERING                                           #
                // ##################################################################


                 nibe.log(`Hämtade ${fullPriceList.length} kvartspunkter för analys.`, 'price', 'debug');


                const now = new Date();
                now.setMinutes(0, 0, 0);
                const futurePriceList = fullPriceList.filter(p => p && p.startsAt && (new Date(p.startsAt) >= now));
                if (futurePriceList.length === 0) {
                    nibe.log('Ingen framtida prisdata tillgänglig.', 'price', 'warn');
                    return;
                }
                const currentHour = futurePriceList[0];
                const currentHourDate = currentHour.startsAt;

                const priceDataForAlgo = fullPriceList.map(p => ({
                    value: p.total * 100, // ÖREN
                    ts: new Date(p.startsAt).getTime(),
                    date: p.startsAt
                }));

                const algoOptions = {
                    timeWindow: config.price.time,
                    minSpread: config.price.min_spread
                };
                const optimalTrades = optimizeElectricityTrading(priceDataForAlgo, algoOptions);

                let currentLevel = 'NORMAL';
                let veryCheapHours, cheapHours, expensiveHours, veryExpensiveHours;

                if (optimalTrades.buy.length > 0) {
                    const buyPrices = optimalTrades.buy.sort((a, b) => a.value - b.value);
                    const sellPrices = optimalTrades.sell.sort((a, b) => a.value - b.value);
                    const buyMedianIndex = Math.floor(buyPrices.length / 2);
                    const sellMedianIndex = Math.floor(sellPrices.length / 2);

                    veryCheapHours = new Set(buyPrices.slice(0, buyMedianIndex).map(p => p.date));
                    cheapHours = new Set(buyPrices.slice(buyMedianIndex).map(p => p.date));
                    expensiveHours = new Set(sellPrices.slice(0, sellMedianIndex).map(p => p.date));
                    veryExpensiveHours = new Set(sellPrices.slice(sellMedianIndex).map(p => p.date));

                    if (veryCheapHours.has(currentHourDate)) currentLevel = 'VERY_CHEAP';
                    else if (cheapHours.has(currentHourDate)) currentLevel = 'CHEAP';
                    else if (veryExpensiveHours.has(currentHourDate)) currentLevel = 'VERY_EXPENSIVE';
                    else if (expensiveHours.has(currentHourDate)) currentLevel = 'EXPENSIVE';
                }

                const heat = {
                    level: currentLevel,
                    current: currentHour.total * 100,
                    prices: fullPriceList.map(p => {
                        const date = p.startsAt;
                        let hourLevel = 'NORMAL';
                        if (veryCheapHours && veryCheapHours.has(date)) hourLevel = 'VERY_CHEAP';
                        else if (cheapHours && cheapHours.has(date)) hourLevel = 'CHEAP';
                        else if (veryExpensiveHours && veryExpensiveHours.has(date)) hourLevel = 'VERY_EXPENSIVE';
                        else if (expensiveHours && expensiveHours.has(date)) hourLevel = 'EXPENSIVE';

                        return { value: p.total * 100, level: hourLevel, ts: new Date(p.startsAt).getTime() };
                    })
                };

                const hw = { ...heat };
                data.priceai = { heat, hw };
                data.price_current = {
  data: (function(){
    var __own = !!(config && config.price && config.price.enable_own_price);
    var __applyVat = !!(config && config.price && config.price.apply_vat === true);
    var __vat = (typeof config.price.vat === 'number' ? config.price.vat : 0.25);
    var __addOre = ((config && config.price && config.price.addition_ore) || 0);
    var __baseKr = (Number(heat.current) || 0) / 100;
    var __showKr = __own ? (__baseKr * (__applyVat ? (1 + __vat) : 1) + (__addOre/100)) : __baseKr;
    return Number((__showKr * 100).toFixed(2));
  })(),
  raw_data: (function(){
    var __own = !!(config && config.price && config.price.enable_own_price);
    var __applyVat = !!(config && config.price && config.price.apply_vat === true);
    var __vat = (typeof config.price.vat === 'number' ? config.price.vat : 0.25);
    var __addOre = ((config && config.price && config.price.addition_ore) || 0);
    var __baseKr = (Number(heat.current) || 0) / 100;
    var __showKr = __own ? (__baseKr * (__applyVat ? (1 + __vat) : 1) + (__addOre/100)) : __baseKr;
    return Number((__showKr * 100).toFixed(2));
  })(),
  info: "Current electrical price",
  titel: "Electric price",
  register: "electric_price",
  unit: "öre",
  icon_name: "fa-flash"
};
// === OWN THRESHOLDS → OVERRIDE LEVELS (local analysis path) ===
try {
  var __ownSetting = (config && config.price && config.price.enable_own_setting === true);
  if (__ownSetting) {
    var __ownPrice = (config && config.price && config.price.enable_own_price === true);
    var __VATon    = (config && config.price && config.price.apply_vat === true);
    var __VAT      = (config && config.price && typeof config.price.vat === 'number') ? config.price.vat : 0.25;
    var __addOre   = Number((config && config.price && config.price.addition_ore) || 0);
    var __vLow     = Number(config && config.price ? config.price.verycheap : NaN);
    var __vHigh    = Number(config && config.price ? config.price.veryexpensive : NaN);
    var __krNow    = Number(currentHour && currentHour.total) || 0; // kr/kWh
    var __oreNow   = __ownPrice ? (( __VATon ? __krNow*(1+__VAT) : __krNow) * 100) + __addOre : (__krNow*100);

    if (isFinite(__vLow) && isFinite(__vHigh)) {
      if (__oreNow >= __vHigh) {
        heat.level = 'VERY_EXPENSIVE';
        if (typeof hw !== 'undefined' && hw && typeof hw.level !== 'undefined') hw.level = 'VERY_EXPENSIVE';
      } else if (__oreNow <= __vLow) {
        heat.level = 'VERY_CHEAP';
        if (typeof hw !== 'undefined' && hw && typeof hw.level !== 'undefined') hw.level = 'VERY_CHEAP';
      } else {
        heat.level = 'NORMAL';
        if (typeof hw !== 'undefined' && hw && typeof hw.level !== 'undefined') hw.level = 'NORMAL';
      }
      nibe.log('OWN THRESHOLDS APPLIED (local) → heat.level='+heat.level+', oreNow='+__oreNow.toFixed(2)+' öre (vLow='+__vLow+', vHigh='+__vHigh+')','price','debug');
    }
  }
} catch(e) {}

                data.heat_price_level = { data: heat.level, raw_data: heat.level };
                data.hw_price_level = { data: hw.level, raw_data: hw.level };
                
                nibe.log(`Lokal analys klar. Nivå: ${heat.level}, Pris: ${data.price_current.data} öre`, 'price', 'debug');
                
                var prio_add_enable = await getNibeData(hP['prio_add_enable']).catch(() => {});

                if(prio_add_enable!==undefined) {
                    if(config.price.prio_enable===true) {
                        if(config.price.prio_cop===undefined) config.price.prio_cop = 3;
                        if(config.price.prio_cost===undefined) config.price.prio_cost = 1;
                        if(config.price.prio_tax===undefined) config.price.prio_tax = 45;
                        if(config.price.prio_transfer===undefined) config.price.prio_transfer = 25;
                        nibe.setConfig(config); // Save defaults if they were missing

                        nibe.log(`Prioriterad tillsats är aktiverad som elprisreglering`,'price','debug');
                        let price = data.price_current.raw_data;
                        let fee = config.price.prio_tax + config.price.prio_transfer;
                        let cop = config.price.prio_cop;
                        let cost = config.price.prio_cost;

                        // Jämför kostnad för 1 kWh värme från pumpen vs. alternativet
                        // (price + fee) / cop  vs  cost * 100
                        if((price + fee) > (cost * 100 * cop)) {
                            if(prio_add_enable.raw_data===0) {
                                nibe.log(`Värmepumpen är dyrare att köra än prioriterad tillsats. Slår på tillsats.`, 'price', 'debug');
                                nibe.setData(hP['prio_add_enable'],1);
                            }
                        } else {
                            if(prio_add_enable.raw_data===1) {
                                nibe.log(`Värmepumpen är billigare att köra än prioriterad tillsats. Slår av tillsats.`, 'price', 'debug');
                                nibe.setData(hP['prio_add_enable'],0);
                            }
                        }
                    }
                }

                if (true) {
                    priceAdjustCurve(data);
                    adjustPool(data,data.system)
                    .then(pool => {
                        if(pool!==undefined){ nibe.log('POOL-EMIT sys='+data.system,'price','debug'); nibeData.emit('pluginPriceGraphPool',priceBuildPoolGraph(heat,data.system)); }
                    })
                    .catch(console.log);
                }

                nibeData.emit('pluginPrice',data);
                nibeData.emit('pluginPriceGraph',priceaiBuildGraph(heat,hw,data,prio_add_enable));

            } catch(err) {
                nibe.log(`Fel i Lokal AI-styrning: ${err}`, 'price', 'error');
                console.log(err);
            }

        } else if(config.price.source=="nibe") {
            nibe.log(`Källan är Nibe`,'price','debug');
            data.price_level = await getNibeData(hP['price_level']).catch(console.log);
            data.price_enable = await getNibeData(hP['price_enable']).catch(console.log);
            priceAdjustCurve(data)
            data.price_current = await getNibeData(hP['price_current']).catch(console.log);
            nibeData.emit('pluginPriceGraph',nibeBuildGraph(data,data.system));
            nibeData.emit('pluginPrice',data);
        } else if(config.price.source=="priceai" || config.price.source=="local_ai") {
            nibe.log(`Källan är Lokal AI (via elprisetjustnu.se)`,'price','debug');

            try {
                const area = config.price.area || 'SE3';

                // Steg 1: Hämta data från elprisetjustnu.se för idag och imorgon
                const today = new Date();
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);

                const todayYear = today.getFullYear();
                const todayMonthDay = today.toISOString().slice(5, 10); // Ger "10-07"
                const tomorrowYear = tomorrow.getFullYear();
                const tomorrowMonthDay = tomorrow.toISOString().slice(5, 10);

                const optionsToday = {
                    hostname: 'www.elprisetjustnu.se',
                    port: 443,
                    path: `/api/v1/prices/${todayYear}/${todayMonthDay}_${area}.json`,
                    method: 'GET'
                };
                const optionsTomorrow = {
                    hostname: 'www.elprisetjustnu.se',
                    port: 443,
                    path: `/api/v1/prices/${tomorrowYear}/${tomorrowMonthDay}_${area}.json`,
                    method: 'GET'
                };

                const [todayResult, tomorrowResult] = await Promise.all([
                    getCloudData(optionsToday, "{}").catch(e => {
                        nibe.log(`Kunde inte hämta priser för idag från elprisetjustnu.se`, 'price', 'warn');
                        return [];
                    }),
                    getCloudData(optionsTomorrow, "{}").catch(e => {
                        nibe.log(`Kunde inte hämta priser för imorgon (detta är normalt före kl 14).`, 'price', 'debug');
                        return [];
                    })
                ]);

                const rawPriceList = [].concat(todayResult || [], tomorrowResult || []);

                if (rawPriceList.length === 0) {
                    nibe.log('Ingen prisdata kunde hämtas från elprisetjustnu.se.', 'price', 'error');
                    return;
                }

                // Steg 2: Medelvärdesbilda kvartspriser till timpriser
                const hourlyPriceList = [];
                // Gruppera hela objekt (inte bara priset) för att komma åt tidsstämpeln senare
                const groupedByHour = rawPriceList.reduce((acc, price) => {
                    const hour = price.time_start.substring(0, 13);
                    if (!acc[hour]) {
                        acc[hour] = [];
                    }
                    acc[hour].push(price); // Spara hela objektet
                    return acc;
                }, {});



                for (const hour in groupedByHour) {
                    const itemsInHour = groupedByHour[hour];
                    // Beräkna snittet
                    const averagePrice = itemsInHour.reduce((sum, p) => sum + p.SEK_per_kWh, 0) / itemsInHour.length;
                    
                    // Dynamisk tidszon: Hämta tidszonssuffixet från det första objektet i timmen
                    // Exempel in: "2025-11-25T10:00:00+01:00" -> Vi tar "+01:00"
                    const timeZoneSuffix = itemsInHour[0].time_start.slice(19);

                    hourlyPriceList.push({
                        startsAt: `${hour}:00:00${timeZoneSuffix}`,
                        total: averagePrice
                    });
                }
                nibe.log(`Hämtade ${rawPriceList.length} kvartspunkter och konverterade till ${hourlyPriceList.length} stabila timpunkter.`, 'price', 'debug');
                const fullPriceList = hourlyPriceList;

                // VV-AI: cacha timpriser i RAM för VV-analys (ingen SD-skrivning)
                vvAiPriceCache = fullPriceList;

                const now = new Date();
                now.setMinutes(0, 0, 0);
                const futurePriceList = fullPriceList.filter(p => p && p.startsAt && (new Date(p.startsAt) >= now));
                if (futurePriceList.length === 0) {
                    nibe.log('Ingen framtida prisdata tillgänglig.', 'price', 'warn');
                    return;
                }
                const currentHour = futurePriceList[0];
                const currentHourDate = currentHour.startsAt;

                const priceDataForAlgo = fullPriceList.map(p => ({
                    value: p.total * 100, // ÖREN
                    ts: new Date(p.startsAt).getTime(),
                    date: p.startsAt
                }));

                const algoOptions = {
                    timeWindow: config.price.time,
                    minSpread: config.price.min_spread
                };
                const optimalTrades = optimizeElectricityTrading(priceDataForAlgo, algoOptions);

                let currentLevel = 'NORMAL';
                let veryCheapHours, cheapHours, expensiveHours, veryExpensiveHours;

                if (optimalTrades.buy.length > 0) {
                    const buyPrices = optimalTrades.buy.sort((a, b) => a.value - b.value);
                    const sellPrices = optimalTrades.sell.sort((a, b) => a.value - b.value);
                    const buyMedianIndex = Math.floor(buyPrices.length / 2);
                    const sellMedianIndex = Math.floor(sellPrices.length / 2);

                    veryCheapHours = new Set(buyPrices.slice(0, buyMedianIndex).map(p => p.date));
                    cheapHours = new Set(buyPrices.slice(buyMedianIndex).map(p => p.date));
                    expensiveHours = new Set(sellPrices.slice(0, sellMedianIndex).map(p => p.date));
                    veryExpensiveHours = new Set(sellPrices.slice(sellMedianIndex).map(p => p.date));

                    if (veryCheapHours.has(currentHourDate)) currentLevel = 'VERY_CHEAP';
                    else if (cheapHours.has(currentHourDate)) currentLevel = 'CHEAP';
                    else if (veryExpensiveHours.has(currentHourDate)) currentLevel = 'VERY_EXPENSIVE';
                    else if (expensiveHours.has(currentHourDate)) currentLevel = 'EXPENSIVE';
                }

                const heat = {
                    level: currentLevel,
                    current: currentHour.total * 100,
                    prices: fullPriceList.map(p => {
                        const date = p.startsAt;
                        let hourLevel = 'NORMAL';
                        if (veryCheapHours && veryCheapHours.has(date)) hourLevel = 'VERY_CHEAP';
                        else if (cheapHours && cheapHours.has(date)) hourLevel = 'CHEAP';
                        else if (veryExpensiveHours && veryExpensiveHours.has(date)) hourLevel = 'VERY_EXPENSIVE';
                        else if (expensiveHours && expensiveHours.has(date)) hourLevel = 'EXPENSIVE';
                        return { value: p.total * 100, level: hourLevel, ts: new Date(p.startsAt).getTime() };
                    })
                };

                const hw = { ...heat };
                data.priceai = { heat, hw };
                data.price_current = {
  data: (function(){
    var __own = !!(config && config.price && config.price.enable_own_price);
    var __applyVat = !!(config && config.price && config.price.apply_vat === true);
    var __vat = (typeof config.price.vat === 'number' ? config.price.vat : 0.25);
    var __addOre = ((config && config.price && config.price.addition_ore) || 0);
    var __baseKr = (Number(heat.current) || 0) / 100;
    var __showKr = __own ? (__baseKr * (__applyVat ? (1 + __vat) : 1) + (__addOre/100)) : __baseKr;
    return Number((__showKr * 100).toFixed(2));
  })(),
  raw_data: (function(){
    var __own = !!(config && config.price && config.price.enable_own_price);
    var __applyVat = !!(config && config.price && config.price.apply_vat === true);
    var __vat = (typeof config.price.vat === 'number' ? config.price.vat : 0.25);
    var __addOre = ((config && config.price && config.price.addition_ore) || 0);
    var __baseKr = (Number(heat.current) || 0) / 100;
    var __showKr = __own ? (__baseKr * (__applyVat ? (1 + __vat) : 1) + (__addOre/100)) : __baseKr;
    return Number((__showKr * 100).toFixed(2));
  })(),
  info: "Current electrical price",
  titel: "Electric price",
  register: "electric_price",
  unit: "öre",
  icon_name: "fa-flash"
};
// === OWN THRESHOLDS → OVERRIDE LEVELS (local analysis path) ===
try {
  var __ownSetting = (config && config.price && config.price.enable_own_setting === true);
  if (__ownSetting) {
    var __ownPrice = (config && config.price && config.price.enable_own_price === true);
    var __VATon    = (config && config.price && config.price.apply_vat === true);
    var __VAT      = (config && config.price && typeof config.price.vat === 'number') ? config.price.vat : 0.25;
    var __addOre   = Number((config && config.price && config.price.addition_ore) || 0);
    var __vLow     = Number(config && config.price ? config.price.verycheap : NaN);
    var __vHigh    = Number(config && config.price ? config.price.veryexpensive : NaN);
    var __krNow    = Number(currentHour && currentHour.total) || 0; // kr/kWh
    var __oreNow   = __ownPrice ? (( __VATon ? __krNow*(1+__VAT) : __krNow) * 100) + __addOre : (__krNow*100);

    if (isFinite(__vLow) && isFinite(__vHigh)) {
      if (__oreNow >= __vHigh) {
        heat.level = 'VERY_EXPENSIVE';
        if (typeof hw !== 'undefined' && hw && typeof hw.level !== 'undefined') hw.level = 'VERY_EXPENSIVE';
      } else if (__oreNow <= __vLow) {
        heat.level = 'VERY_CHEAP';
        if (typeof hw !== 'undefined' && hw && typeof hw.level !== 'undefined') hw.level = 'VERY_CHEAP';
      } else {
        heat.level = 'NORMAL';
        if (typeof hw !== 'undefined' && hw && typeof hw.level !== 'undefined') hw.level = 'NORMAL';
      }
      nibe.log('OWN THRESHOLDS APPLIED (local) → heat.level='+heat.level+', oreNow='+__oreNow.toFixed(2)+' öre (vLow='+__vLow+', vHigh='+__vHigh+')','price','debug');
    }
  }
} catch(e) {}

                data.heat_price_level = { data: heat.level, raw_data: heat.level };
                data.hw_price_level = { data: hw.level, raw_data: hw.level };

                nibe.log(`Lokal analys klar. Nivå: ${heat.level}, Pris: ${data.price_current.data} öre`, 'price', 'debug');

                var prio_add_enable = await getNibeData(hP['prio_add_enable']).catch(() => {});

                if(prio_add_enable!==undefined) {
                    if(config.price.prio_enable===true) {
                        if(config.price.prio_cop===undefined) config.price.prio_cop = 3;
                        if(config.price.prio_cost===undefined) config.price.prio_cost = 1;
                        if(config.price.prio_tax===undefined) config.price.prio_tax = 45;
                        if(config.price.prio_transfer===undefined) config.price.prio_transfer = 25;
                        nibe.setConfig(config);

                        nibe.log(`Prioriterad tillsats är aktiverad som elprisreglering`,'price','debug');
                        let price = data.price_current.raw_data;
                        let fee = config.price.prio_tax + config.price.prio_transfer;
                        let cop = config.price.prio_cop;
                        let cost = config.price.prio_cost;

                        if((price + fee) > (cost * 100 * cop)) {
                            if(prio_add_enable.raw_data===0) {
                                nibe.log(`Värmepumpen är dyrare att köra än prioriterad tillsats. Slår på tillsats.`, 'price', 'debug');
                                nibe.setData(hP['prio_add_enable'],1);
                            }
                        } else {
                            if(prio_add_enable.raw_data===1) {
                                nibe.log(`Värmepumpen är billigare att köra än prioriterad tillsats. Slår av tillsats.`, 'price', 'debug');
                                nibe.setData(hP['prio_add_enable'],0);
                            }
                        }
                    }
                }

                if (true) {
                    priceAdjustCurve(data);
                    adjustPool(data,data.system)
                    .then(pool => {
                        if(pool!==undefined){ nibe.log('POOL-EMIT sys='+data.system,'price','debug'); nibeData.emit('pluginPriceGraphPool',priceBuildPoolGraph(heat,data.system)); }
                    })
                    .catch(console.log);
                }

                nibeData.emit('pluginPrice',data);
                nibeData.emit('pluginPriceGraph',priceaiBuildGraph(heat,hw,data,prio_add_enable));

            } catch (err) {
                nibe.log(`Fel vid hämtning/analys från elprisetjustnu.se: ${err}`, 'price', 'error');
                console.log(err);
            }
        }
    }
}

// ORGINAL runPrice
    async function notUsedAnyLongerrunPrice(data,array) {

        nibe.log(`Startar elprisreglering runPrice()`,'price','debug');
        //let data = Object.assign({}, result);
        let config = nibe.getConfig();
        let inside;
        nibe.log(`Letar efter givare ${config.price['sensor_'+data.system]}`,'price','debug');
        if(config.price['sensor_'+data.system]!==undefined && config.price['sensor_'+data.system]!=="") {
            let index = array.findIndex(i => i.name == config.price['sensor_'+data.system]);
            if(index!==-1) {
                inside = array[index];
                nibe.log(`Sätter inomhusgivare ${config.price['sensor_'+data.system]}, ${inside.data} grader`,'price','debug');
            }
        }
        data.priceSensor = inside;
        if(config.price!==undefined && config.price.enable===true) {
            nibe.log(`Elprisreglering är aktiverad`,'price','debug');
            if(config.price.source=="tibber") {
                nibe.log(`Källan är Tibber`,'price','debug');

                if(config.price.token!==undefined && config.price.token!=="") {
                    let token = config.price.token;
                    const options = {
                        hostname: 'api.tibber.com',
                        port: 443,
                        path: '/v1-beta/gql',
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                      };
                      const request = JSON.stringify({
                        query: "{\
                            viewer {\
                                homes {\
                                currentSubscription {\
                                    status\
                                    priceInfo {\
                                    today{\
                                        startsAt\
                                        total\
                                        energy\
                                        level\
                                        tax\
                                    }\
                                    current{\
                                        total\
                                        energy\
                                        level\
                                        tax\
                                        startsAt\
                                    }\
                                    tomorrow {\
                                        startsAt\
                                        total\
                                        level\
                                        energy\
                                        tax\
                                    }\
                                    }\
                                }\
                                consumption(resolution: HOURLY, last: 48) {\
                                    nodes {\
                                    from\
                                    to\
                                    consumption\
                                    consumptionUnit\
                                    }\
                                }\
                                }\
                            }\
                            }"
                        });
                    await getCloudData(options,request).then(result => {
                        data.tibber = result;
                        data.price_current = {};
                        data.price_current.data = Number((result.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.current.energy*100).toFixed(2))
                        data.price_current.raw_data = Number((result.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.current.energy*100).toFixed(2))
                        data.price_level = {};
                        data.price_level.data = result.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.current.level;
                        data.price_level.raw_data = result.data.viewer.homes[config.price.tibber_home].currentSubscription.priceInfo.current.level;
                        priceAdjustCurve(data)
                        nibeData.emit('pluginPrice',data);
                        nibeData.emit('pluginPriceGraph',tibberBuildGraph(result,data.system));
                    },(reject => {
                        console.log(reject)
                    }));
                } else {
                    sendError('Cloud',`Token är inte giltigt.`);
                    return
                }

            } else if(config.price.source=="nibe") {
                nibe.log(`Källan är Nibe`,'price','debug');
                data.price_level = await getNibeData(hP['price_level']).catch(console.log);
                data.price_enable = await getNibeData(hP['price_enable']).catch(console.log);
                priceAdjustCurve(data)
                data.price_current = await getNibeData(hP['price_current']).catch(console.log);
                nibeData.emit('pluginPriceGraph',nibeBuildGraph(data,data.system));
                nibeData.emit('pluginPrice',data);
            } else if(config.price.source=="priceai") {
                nibe.log(`Källan är AI`,'price','debug');

                if(config.price.token!==undefined && config.price.token!=="") {
                    let token = config.price.token;


                    try {
                        const optionsHeat = {
                            hostname: 'nibepi.anerdins.se',
                            port: 8443,
                            path: '/api/optimize/heat',
                            rejectUnauthorized: false,
                            requestCert: true,
                            agent: false,
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Content-Type': 'application/json'
                            }
                        };
                        const optionsHW = {
                        hostname: 'nibepi.anerdins.se',
                        port: 8443,
                        path: '/api/optimize/battery',
                        rejectUnauthorized: false,
                        requestCert: true,
                        agent: false,
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                      };
                      var cheap_setting = undefined
                      var expensive_setting = undefined
                      if(config.price.enable_own_setting===true) {
                        cheap_setting = config.price.verycheap
                        expensive_setting = config.price.veryexpensive
                      }
                        const requestHeat = JSON.stringify({
                            name:"heat",
                            id:config.system.id,
                            area:config.price.area,
                            time:config.price.time,
                            json:true,
                            min_spread:config.price.min_spread,
                            veryCheap:cheap_setting,
                            veryExpensive:expensive_setting
                        });
                        if(config.price.time_hw===undefined) config.price.time_hw = config.price.time
                        const requestHW = JSON.stringify({
                            name:"hw",
                            id:config.system.id,
                            area:config.price.area,
                            time:config.price.time_hw,
                            ratio:config.price.ratio,
                            json:true,
                            min_spread:config.price.min_spread,
                            veryCheap:cheap_setting,
                            veryExpensive:expensive_setting
                        });
                        const heatSettings = await getCloudData(optionsHeat,requestHeat)
                        const hwSettings = await getCloudData(optionsHW,requestHW)
                        Promise.all([heatSettings, hwSettings]).then(async (values) => {
                            nibe.log(`Data hämtad från AI`,'price','debug');
                            var heat = values[0]
                            var hw = values[1]
                            data.priceai = {heat,hw};
                            data.price_current = {};
                            data.price_current.data = Number((heat.current).toFixed(2))
                            data.price_current.raw_data = Number((heat.current).toFixed(2))
// === OWN THRESHOLDS → OVERRIDE LEVELS (AI values path) ===
try {
  var __ownSetting2 = (config && config.price && config.price.enable_own_setting === true);
  if (__ownSetting2) {
    var __ownPrice2 = (config && config.price && config.price.enable_own_price === true);
    var __VATon2    = (config && config.price && config.price.apply_vat === true);
    var __VAT2      = (config && config.price && typeof config.price.vat === 'number') ? config.price.vat : 0.25;
    var __addOre2   = Number((config && config.price && config.price.addition_ore) || 0);
    var __vLow2     = Number(config && config.price ? config.price.verycheap : NaN);
    var __vHigh2    = Number(config && config.price ? config.price.veryexpensive : NaN);
    // heat.current is assumed to be öre/kWh in this branch
    var __oreNow2   = Number(heat && heat.current) || 0;
    if (__ownPrice2) {
      __oreNow2 = (__VATon2 ? __oreNow2 * (1+__VAT2) : __oreNow2) + __addOre2;
    }
    if (isFinite(__vLow2) && isFinite(__vHigh2)) {
      if (__oreNow2 >= __vHigh2) {
        heat.level = 'VERY_EXPENSIVE';
        if (typeof hw !== 'undefined' && hw && typeof hw.level !== 'undefined') hw.level = 'VERY_EXPENSIVE';
      } else if (__oreNow2 <= __vLow2) {
        heat.level = 'VERY_CHEAP';
        if (typeof hw !== 'undefined' && hw && typeof hw.level !== 'undefined') hw.level = 'VERY_CHEAP';
      } else {
        heat.level = 'NORMAL';
        if (typeof hw !== 'undefined' && hw && typeof hw.level !== 'undefined') hw.level = 'NORMAL';
      }
      nibe.log('OWN THRESHOLDS APPLIED (AI) → heat.level='+heat.level+', oreNow='+__oreNow2.toFixed(2)+' öre (vLow='+__vLow2+', vHigh='+__vHigh2+')','price','debug');
    }
  }
} catch(e) {}

                            data.heat_price_level = {};
                            data.heat_price_level.data = heat.level;
                            data.heat_price_level.raw_data = heat.level;
                            data.hw_price_level = {};
                            data.hw_price_level.data = hw.level;
                            data.hw_price_level.raw_data = hw.level;
                            data.price_current.info = "Current electrical price / divided by 10"
                            data.price_current.titel = "Electric price"
                            data.price_current.register = "electric_price"
                            data.price_current.unit = ""
                            data.price_current.icon_name = "fa-flash"
                            savedData['electric_price'] = data.price_current;
                            saveDataGraph('electric_price',Date.now(),(data.price_current.raw_data/10))
                            nibe.log(`Hämtad nivå: ${heat.level}, hämtat pris: ${data.price_current.data} öre`,'price','debug');
                            var prio_add_enable = await getNibeData(hP['prio_add_enable']).catch((err) => {

                            })
                            if(prio_add_enable!==undefined) {
                            if(config.price.prio_enable===true) {
                                if(config.price.prio_cop===undefined) {
                                    config.price.prio_cop = 3
                                    nibe.setConfig(config);
                                }
                                if(config.price.prio_cost===undefined) {
                                    config.price.prio_cost = 1
                                    nibe.setConfig(config);
                                }
                                if(config.price.prio_tax===undefined) {
                                    config.price.prio_tax = 45
                                    nibe.setConfig(config);
                                }
                                if(config.price.prio_transfer===undefined) {
                                    config.price.prio_transfer = 25
                                    nibe.setConfig(config);
                                }
                                nibe.log(`Prioriterad tillsats är aktiverad som elprisreglering`,'price','debug');
                                let price = data.price_current.raw_data
                                let fee = config.price.prio_tax+config.price.prio_transfer
                                let cop = config.price.prio_cop
                                let cost = config.price.prio_cost
                                    if(price+fee > cost*cop) {
                                        if(prio_add_enable.raw_data===0) {
                                            nibe.log(`Elpriset har en högre kostnad att producera än prioriterad tillsats.`,'price','debug');
                                            nibe.log(`Prioriterad tillsats är av, slår på`,'price','debug');
                                            nibe.setData(hP['prio_add_enable'],1);
                                            prio_add_enable.raw_data = 1
                                            prio_add_enable.data = 1
                                        }
                                    } else {
                                        if(prio_add_enable.raw_data===1) {
                                            nibe.log(`Elpriset har en lägre kostnad att producera än prioriterad tillsats.`,'price','debug');
                                            nibe.log(`Prioriterad tillsats är på, slår av`,'price','debug');
                                            nibe.setData(hP['prio_add_enable'],0);
                                            prio_add_enable.raw_data = 0
                                            prio_add_enable.data = 0
                                        }
                                    }
                                }
                            }
                            if (true) {
                                priceAdjustCurve(data)
                                adjustPool(data,data.system)
                                .then(pool => {
                                    if(pool!==undefined){ nibe.log('POOL-EMIT sys='+data.system,'price','debug'); nibeData.emit('pluginPriceGraphPool',priceBuildPoolGraph(heat,data.system)); }
                                })
                                .catch(console.log)
                            }

                            nibeData.emit('pluginPrice',data);
                            nibeData.emit('pluginPriceGraph',priceaiBuildGraph(heat,hw,data,prio_add_enable));
                        })
                    } catch(err) {
                        console.log(err)
                    }

                }
            }
        }

    }
    const sendError = (from,message) => {
        let data = {from:from,message:message};
        nibeData.emit('fault',data);
    };
    const POOL_DEBUG = true;  // sätt till false för att stänga av

	const adjustPool = (dataIn,system) => {
        const promise = new Promise((resolve,reject) => {
            try {
                var data = Object.assign({}, dataIn);
                let config = nibe.getConfig();
                if(config.price===undefined) {
                    config.price = {}
                    nibe.setConfig(config);
                }
                if(config.price.VERY_CHEAP_POOL_HEAT===undefined) {
                    config.price.pool_enable_s1 = false
                    config.price.VERY_CHEAP_POOL_HEAT = 0
                    config.price.CHEAP_POOL_HEAT = 0
		            config.price.NORMAL_POOL_HEAT = 0
                    config.price.NORMAL_START_POOL_HEAT = 28
                    config.price.NORMAL_STOP_POOL_HEAT = 32
                    config.price.EXPENSIVE_POOL_HEAT = 0
                    config.price.VERY_EXPENSIVE_POOL_HEAT = 0
                    config.price.VERY_CHEAP_POOL_CPR = 0
                    config.price.CHEAP_POOL_CPR = 0
                    config.price.NORMAL_START_POOL_CPR = 0
                    config.price.NORMAL_STOP_POOL_CPR = 0
                    config.price.EXPENSIVE_POOL_CPR = 0
                    config.price.VERY_EXPENSIVE_POOL_CPR = 0
                    nibe.setConfig(config);
                }

				// Migration/guard: se till att NORMAL_POOL_HEAT finns även om defaults-blocket inte körs
				if (config.price.NORMAL_POOL_HEAT === undefined) {
				  config.price.NORMAL_POOL_HEAT = 0;
				  nibe.setConfig(config);
				}

                if(config.price.pool_enable_s1===true) {
                    const poolTemp = getNibeData(hP['pool_temp_'+system]).catch(console.log)
                    const poolStart = getNibeData(hP['pool_start_temp_'+system]).catch(console.log)
                    const poolStop = getNibeData(hP['pool_stop_temp_'+system]).catch(console.log)
                    const poolCpr = getNibeData(hP['pool_cpr_'+system]).catch(console.log)
                    if(config.price.pool_max_temp===undefined || isNaN(config.price.pool_max_temp)) config.price.pool_max_temp = 100
                    Promise.all([poolTemp, poolStart, poolStop, poolCpr]).then((values) => {

                        const [poolTemp, poolStart, poolStop, poolCpr] = values || [];

                        // Hjälpare för att extrahera siffra ur ev. objekt från getNibeData
						function val(v) {
						  if (v && typeof v === 'object') {
							// vanliga fält: data / value / payload / raw
							if (v.data !== undefined) return v.data;
							if (v.value !== undefined) return v.value;
							if (v.payload !== undefined) return v.payload;
							if (v.raw !== undefined) return v.raw;
						  }
						  return v;
						}

						// ---- ADDED: Minimal debug av sensorer (utan "price") ----
                        if (POOL_DEBUG === true) {
                            console.log(
                                '[POOL DEBUG] system=' + system +
								' T=' + val(poolTemp) + '°C start=' + val(poolStart) + '°C stop=' + val(poolStop) + '°C cpr=' + val(poolCpr)
                            );
						}
                        // ---- /ADDED ----


                        // PATCH: robust price level lookup (supports heat_price_level, price_level, priceai.heat.level)
                        let level = null;
                        try {
                            level = (data && data.heat_price_level && data.heat_price_level.data) ||
                                    (data && data.price_level && data.price_level.data) ||
                                    (data && data.priceai && data.priceai.heat && data.priceai.heat.level) ||
                                    null;
                        } catch(e) { level = null; }

// SAFE fallback: force NORMAL if level missing/unknown
if (!level || (typeof level === 'string' && !['VERY_CHEAP','CHEAP','NORMAL','EXPENSIVE','VERY_EXPENSIVE'].includes(level.toUpperCase()))) {
    level = 'NORMAL';
}

                        if(config.price[`${level}_POOL_HEAT`]!==undefined) {
                            if(level=="NORMAL") {
                                nibe.setData(hP['pool_start_temp_'+system],config.price.NORMAL_START_POOL_HEAT)
                                nibe.setData(hP['pool_stop_temp_'+system],config.price.NORMAL_STOP_POOL_HEAT)
                            } else {
                                var adjust = config.price[`${level}_POOL_HEAT`]
                                var start = config.price.NORMAL_START_POOL_HEAT
                                var stop = config.price.NORMAL_STOP_POOL_HEAT
                                nibe.setData(hP['pool_start_temp_'+system],Math.min(start+adjust,config.price.pool_max_temp))
                                nibe.setData(hP['pool_stop_temp_'+system],Math.min(stop+adjust,config.price.pool_max_temp))
                            }

                            resolve(values)
                        } else {
                            resolve()
                        }

                    }).catch((err) => {
                        sendError('Elprisreglering Poolstyrning',`Kunde inte hämta data, har värmepumpen stöd för pool?`);
                    });
                }
            } catch(err) {
                reject(err)
            }
        });
        return promise;
    }

    const getCloudData = (options,request) => {
        const promise = new Promise((resolve,reject) => {
        let config = nibe.getConfig();
        if(config.price===undefined) {
            config.price = {};
            nibe.setConfig(config);
        }
        if(config.price.hw_speed===undefined) {
            config.price.hw_speed = 20;
            nibe.setConfig(config);
        }
        var ts = new Date()
        var hour = ts.getHours()
        var req = JSON.parse(request)
        if(req.name=="heat") {
                get(options,request).then(async (data) => {
                    resolve(data)
                }).catch(async (err) => {
                    reject(err)
                })
        } else if(req.name=="hw") {
                try {
                    const bt6 = getNibeData(hP['bt6']).catch(console.log);
                    const bt7 = getNibeData(hP['bt7']).catch(console.log);
                    const hwStartTemp = getNibeData(hP['hw_start_0']).catch(console.log);
                    const hwStopTemp = getNibeData(hP['hw_stop_2']).catch(console.log);
                    Promise.all([bt6, bt7, hwStartTemp, hwStopTemp]).then((values) => {


                        request = JSON.parse(request)
                        request.battery = {
                            capacity:values[3].data,
                            value:values[0].data,
                            zero:values[2].data,
                            effect:config.price.hw_speed,
                            hw:values[1].data
                        }
                        request = JSON.stringify(request)
                        get(options,request).then(async (data) => {
                            resolve(data)
                        }).catch(async (err) => {
                            reject(err)
                        })
                    })
                } catch(err) {
                    console.log('Was not able to get values for hw optimization from the cloud')
                    get(options,request).then(async (data) => {
                        resolve(data)
                    }).catch(async (err) => {
                        reject(err)
                    })
                }
        } else {
            get(options,request).then(async (data) => {
                resolve(data)
            }).catch(async (err) => {
                reject(err)
            })
        }
        async function get(options,request) {
            const promise = new Promise((resolve,reject) => {
                let data = "";
                const req = https.request(options, (res) => {

                res.on('data', (d) => {
                        data += d;

                })
                res.on('end', () => {
                    if(res.statusCode===200) {
                        try {
                            data = JSON.parse(data)

                            nibe.log(`Data hämtad via http`,'price','debug');
                            resolve(data)
                        } catch {
                            sendError('Elprisreglering Cloud',`Kunde inte hantera JSON data`);
                            // NY, FÖRBÄTTRAD LOGGNING: Skriver ut det råa svaret
                            nibe.log(`Något blev fel vid JSON konvertering. Servern svarade: ${data}`, 'price', 'error');

                            //nibe.log(`Något blev fel vid JSON konvertering`,'price','debug');
                            reject('No JSON response')
                        }
                    } else {
                        sendError('Cloud',`Ej kontakt med servern`);
                        reject(res.statusMessage)
                    }

                });
                })

                req.on('error', (error) => {
                sendError('Cloud',`Ej kontakt med servern`);
                reject(error)
                })

                req.write(request)
                req.end()
                });
            return promise;
        }

        });
        return promise;
    }

function scale (number, inMin, inMax, outMin, outMax) {
    return (number - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
}
const lockFreq = (options) => {
    const promise = new Promise((resolve,reject) => {
    let config = nibe.getConfig();
    if(config.price===undefined) {
        config.price = {};
        nibe.setConfig(config);
    }
    if(config.system.pump!="F370" && config.system.pump!="F470" && config.system.pump!="F1145" && config.system.pump!="F1245") {
        var min_temp = config.price.min_temp
        var max_temp = config.price.max_temp
        var min_freq = config.price.min_freq
        var max_freq = config.price.max_freq
        var outside = getNibeData(hP['outside']).catch(console.log);
        var lock_freq_1 = getNibeData(hP['lock_freq_1_activate']).catch(console.log);
        var lock_freq_2 = getNibeData(hP['lock_freq_2_activate']).catch(console.log);
        var lock_freq_1_min = getNibeData(hP['lock_freq_1_min']).catch(console.log);
        var lock_freq_1_max = getNibeData(hP['lock_freq_1_max']).catch(console.log);
        var lock_freq_2_min = getNibeData(hP['lock_freq_2_min']).catch(console.log);
        var lock_freq_2_max = getNibeData(hP['lock_freq_2_max']).catch(console.log);
        Promise.all([lock_freq_1, lock_freq_2, lock_freq_1_min, lock_freq_1_max, lock_freq_2_min, lock_freq_2_max,outside]).then(async (values) => {
            lock_freq_1 = values[0]
            lock_freq_2 = values[1]
            lock_freq_1_min = values[2]
            lock_freq_1_max = values[3]
            lock_freq_2_min = values[4]
            lock_freq_2_max = values[5]
            outside = values[6]
            var frequency = scale(Number(outside.data.toFixed(0)), min_temp, max_temp, max_freq, min_freq)
            if(frequency!==undefined && frequency!==null && !isNaN(frequency)) {
                frequency = Number(frequency.toFixed(0))
                if(frequency<21) frequency = 21
                if(frequency>69) frequency = 69
                nibe.log(`Max frekvens som ska köras vid denna utomhustemperatur: ${frequency} hz`,'price','debug');
            } else {
                frequency = 21
                nibe.log(`Max frekvens som ska köras vid denna utomhustemperatur: Ställer in standard ${frequency} hz`,'price','debug');
            }
            if(frequency<21) frequency = 21
            if(frequency > lock_freq_1_min.data) {
                if(options.heat < 0) {
                    nibe.setData(hP['lock_freq_1_min'],frequency,(err,result) => {
                        if(err) {

                        } else {
                            nibe.setData(hP['lock_freq_1_activate'],"0",(err,result) => {
                                if(err) {

                                } else {
                                    nibe.setData(hP['lock_freq_1_activate'],"1")
                                }

                            });
                        }

                    });
                }

            } else if(frequency < lock_freq_1_min.data) {
                nibe.setData(hP['lock_freq_1_min'],frequency);
            }
            if(lock_freq_1_max.data!==70) nibe.setData(hP['lock_freq_1_max'],"70");
            if(lock_freq_2_min.data!==71) nibe.setData(hP['lock_freq_2_min'],"71");
            if(lock_freq_2_max.data!==120) nibe.setData(hP['lock_freq_2_max'],"120");
            if(options.heat < 0) {
                // Aktivera spärrband
                if(lock_freq_1.data!==1) nibe.setData(hP['lock_freq_1_activate'],"1");
                if(lock_freq_2.data!==1) nibe.setData(hP['lock_freq_2_activate'],"1");
                if(config.price.block_add===true) {
                    var dM = await getNibeData(hP['dM']).catch(console.log)
                    var dMaddstart = await getNibeData(hP['dMaddstart']).catch(console.log)
                    if(dMaddstart!==undefined) {
                        if(dM.data < (dMaddstart.data+50)) {
                            nibe.setData(hP['dM'],(dMaddstart.data+100));
                            nibe.log(`Förhindrar gradminuter från att starta tillsats`,'price','debug');
                        }
                    } else {
                        var dMadd = await getNibeData(hP['dMadd']).catch(console.log);
                        var dMstart = await getNibeData(hP['dMstart']).catch(console.log);
                        if(dMadd===undefined || dMstart===undefined) {
                            nibe.log(`Kunde inte läsa gradminutregister, hoppar över frekvensspärr.`,'price','error');
                            return resolve(null);
                        }
                        dMaddstart = dMstart.data-dMadd.data
                        if(dM.data < (dMaddstart.data+50)) {
                            nibe.setData(hP['dM'],(dMaddstart.data+100));
                            nibe.log(`Förhindrar gradminuter från att starta tillsats`,'price','debug');
                        }
                    }
                }
                resolve(frequency)
            } else if(options.heat >= 0) {
                // Avaktivera spärrband
                if(lock_freq_1.data!==0) nibe.setData(hP['lock_freq_1_activate'],"0");
                if(lock_freq_2.data!==0) nibe.setData(hP['lock_freq_2_activate'],"0");
                resolve(null)
            }
        }).catch(err => {
            console.log(err)
            reject(JSON.stringify(err,null,2))
        })
    } else {
        reject(`This model does not support slowing the frequency down.`)
    }

    });
    return promise;
}
const blockAdditive = (options) => {
    const promise = new Promise(async (resolve,reject) => {
    let config = nibe.getConfig();
    if(config.price===undefined) {
        config.price = {};
        nibe.setConfig(config);
    }
    if(config.system.pump==="F370" || config.system.pump==="F470") return resolve(null);
    if(!(options.heat < 0)) return resolve(null);

    // Read every register this needs into locals. Previously these came from an
    // implicit global `data` left behind by an unrelated HTTP handler, and
    // dMstart was never fetched at all, so the function threw before doing
    // anything useful. Callers reported that as "pump does not support this".
    const dM = await getNibeData(hP['dM']).catch(console.log);
    const dMstart = await getNibeData(hP['dMstart']).catch(console.log);
    if(dM===undefined || dMstart===undefined) {
        nibe.log(`Kunde inte läsa gradminutregister, hoppar över blockering av tillsats.`,'price','error');
        return reject(new Error('Kunde inte läsa gradminutregister'));
    }

    // Pumps without a dMaddstart register: derive it as dMstart - dMadd, which
    // is what the original fallback path did.
    let dMaddstart = await getNibeData(hP['dMaddstart']).catch(() => undefined);
    if(dMaddstart===undefined || dMaddstart.data===undefined) {
        const dMadd = await getNibeData(hP['dMadd']).catch(console.log);
        if(dMadd===undefined) {
            nibe.log(`Kunde inte läsa gradminutregister, hoppar över blockering av tillsats.`,'price','error');
            return reject(new Error('Kunde inte läsa gradminutregister'));
        }
        dMaddstart = { data: dMstart.data - dMadd.data };
    }

    if(dM.data < dMstart.data+(-100)) {
        nibe.setData(hP['dM'],(dMstart.data/2));
        nibe.log(`Återställer gradminuter`,'price','debug');
    } else {
        if(dM.data < (dMaddstart.data+50)) {
            nibe.setData(hP['dM'],(dMaddstart.data+100));
            nibe.log(`Förhindrar gradminuter från att starta tillsats`,'price','debug');
        }
    }
    return resolve(null);

    });
    return promise;
}
    let hwSavedTemp = [];
    let hwTargetValue;
    async function hotwaterPlugin() {
        let time = Date.now();
        let hwTriggerTemp;
        let config = nibe.getConfig();
        if(config.hotwater===undefined) {
            config.hotwater = {};
            nibe.setConfig(config);
        }
        let hwON;
        let bt6;
        let bt7;
        let hwMode;
        let hwStartTemp;
        let hwStopTemp;
        let data = {};
        if(config.hotwater.enable_autoluxury===true || config.hotwater.enable_hw_priority===true) {
            hwON = await getNibeData(hP['startHW']).catch(console.log);
            bt6 = await getNibeData(hP['bt6']).catch(console.log);
            bt7 = await getNibeData(hP['bt7']).catch(console.log);
            hwMode = await getNibeData(hP['hw_mode']).catch(console.log);
            if(hwMode===undefined) {
                nibe.log(`Kunde inte läsa varmvattenläge, hoppar över varmvattenreglering.`,'hw','error');
                return;
            }
            hwStopTemp = await getNibeData(hP['hw_stop_'+hwMode.raw_data]).catch(console.log);
            data.bt6 = bt6;
            data.bt7 = bt7;
            data.hwMode = hwMode;
            if(hwStopTemp===undefined) {
                nibe.log(`Kunde inte läsa stopptemperatur för varmvatten, hoppar över.`,'hw','error');
                return;
            }
            hwStopTemp.data = hwStopTemp.data-1;
            data.hwStopTemp = hwStopTemp;
            saveDataGraph('hw_stop_temp',time,hwStopTemp.data,true);
            data.hwON = hwON;
        }
        if(config.hotwater.enable_autoluxury===true) {
            //if(hwON===undefined) {
            //    sendError('Varmvattenreglering',`Virtuell RMU ej aktiverad.`);
            //}
            let difference = Number(config.hotwater.diff);
            let diff_time = Number(config.hotwater.time);
            hwSavedTemp.unshift(bt6.data);
            //console.log(`Saving BT6 value, ${bt6.data} °C`)
            if(hwSavedTemp.length>=diff_time) {
                //console.log(JSON.stringify(hwSavedTemp));
                if(hwSavedTemp.length>diff_time) {
                    hwSavedTemp.splice(diff_time,hwSavedTemp.length);
                }
                hwTriggerTemp = hwSavedTemp.pop()
                hwTriggerTemp = hwTriggerTemp-difference;
            } else {
                //console.log(JSON.stringify(hwSavedTemp));
                hwTriggerTemp = hwSavedTemp[hwSavedTemp.length-1]
                hwTriggerTemp = hwTriggerTemp-difference;
            }
            hwTriggerTemp = Number(hwTriggerTemp.toFixed(2));
            //console.log(bt6.data+"<"+hwTriggerTemp)
            let hw_target_temp;
            if(hwON.raw_data!==4) {
                //if((clock>=config.hotwater.priority_time_start1 && clock<config.hotwater.priority_time_stop1) || clock>=config.hotwater.priority_time_start2) {
                    if(bt6.data<=hwTriggerTemp) {
                        hwTargetValue = hwTriggerTemp+difference-5;
                        hwTargetValue = Number(hwTargetValue.toFixed(2));
                        hw_target_temp = hwTargetValue;
                        //console.log(`Huge hotwater load. BT6 target value: ${hwTargetValue} °C, BT6 actual: ${bt6.data} °C`);
                        nibe.setData(hP['startHW'],4);
                    } else {
                        //console.log('Not huge hotwater load')
                    }
                //}

            } else {
                //console.log('Hotwater is already running luxury');
                if(hwTargetValue!==undefined) {
                    //console.log(`BT6 target value: ${hwTargetValue} °C, BT6 actual: ${bt6.data} °C`);
                    if(bt6.data>=hwTargetValue || bt6.data>=hwStopTemp.data) {
                        //console.log(`BT6 target (${hwTargetValue} °C) reached, BT6 actual: ${bt6.data} °C`);
                        hwTargetValue = undefined;
                        nibe.setData(hP['startHW'],0);
                    } else {
                        //console.log('Target temperature not reached yet.')
                    }
                }
            }
            if(hwTargetValue===undefined) {
                hw_target_temp = bt6.data;
            }
            data.hwTriggerTemp = hwTriggerTemp;
            data.hwTargetValue = hw_target_temp;

            saveDataGraph('hw_trigger_temp',time,hwTriggerTemp,true);
            saveDataGraph('hw_target_temp',time,hw_target_temp,true);
            nibeData.emit('pluginHotwaterAutoLuxury',data);
        }
        if(config.hotwater.enable_hw_priority===true) {
            hwStartTemp = await getNibeData(hP['hw_start_'+hwMode.data]).catch(console.log);
            if(hwStartTemp===undefined) {
                nibe.log(`Kunde inte läsa starttemperatur för varmvatten, hoppar över.`,'hw','error');
                return;
            }
            hwStartTemp.timestamp = time;
            if(hwON.raw_data!==4) {
                if(bt7.data<=hwStartTemp.data) {
                    //console.log(`Start HW priority. BT7 target value: ${hwStopTemp.data} °C, BT7 actual: ${bt7.data} °C`);
                    nibe.setData(hP['startHW'],4);
                } else {
                    //console.log('Not starting HW priority')
                }
            } else {
                //console.log('Hotwater is already running luxury');
                    //console.log(`BT7 target value: ${hwStopTemp.data} °C, BT7 actual: ${bt7.data} °C`);
                    if(bt7.data>=hwStopTemp.data && hwTargetValue===undefined) {
                        //console.log(`BT7 target (${hwStopTemp.data} °C) reached, BT7 actual: ${bt7.data} °C`);
                        nibe.setData(hP['startHW'],0);
                    } else {
                        //console.log('Target temperature not reached yet.')
                    }
            }
            data.hwStartTemp = hwStartTemp;
            saveDataGraph('hw_start_temp',time,hwStartTemp.data,true);
            nibeData.emit('pluginHotwaterPriority',data);
        }

    }
let fan_mode;
let fan_mode_saved;
let flow_set;
let flow_saved;
let fan_saved;
let fan_filter_normal_eff;
let fan_filter_low_eff;
let filter_eff;
let dMboost = false;
let co2boost = false;
let isRunFanExecuting = false;

async function runFan() {
    if (isRunFanExecuting) {
        nibe.log('runFan körs redan, avvaktar denna körning.', 'fan', 'debug');
        return;
    }
    isRunFanExecuting = true;
    nibe.log('Kör runFan()', 'fan', 'debug');

    try {
        let config = nibe.getConfig();
        var data = {};
        var timeNow = Date.now();
        if(config.fan===undefined) { config.fan = {}; nibe.setConfig(config); }
        if(config.fan.enable!==true) {
            return;
        }

        // Steg 1: Hämta grundläggande data (återgår till steg-för-steg-metoden)
        data.cpr_set = await getNibeData(hP['cpr_set']).catch(console.log);
        data.temp_fan_speed = await getNibeData(hP['fan_mode']).catch(console.log);
        data.fan_speed = await getNibeData(hP['fan_speed']).catch(console.log);
        data.bs1_flow = await getNibeData(hP['bs1_flow']).catch(console.log);
        data.alarm = await getNibeData(hP['alarm']).catch(console.log);
        data.evaporator = await getNibeData(hP['evaporator']).catch(console.log);

        if ([data.cpr_set, data.temp_fan_speed, data.fan_speed, data.bs1_flow, data.alarm, data.evaporator].some(val => val === undefined)) {
            nibe.log('Väntar på all startdata från värmepumpen...', 'fan', 'debug');
            return;
        }

        nibe.log(`[DEBUG Fan Input] Indata: cpr_set=${data.cpr_set.raw_data}Hz, bs1_flow=${data.bs1_flow.raw_data}m3/h, fan_speed=${data.fan_speed.raw_data}%, temp_force=${data.temp_fan_speed.raw_data}`, 'fan', 'debug');

        // Steg 2: Bestäm börvärde (flow_set)
        let current_mode = "normal";
        let flow_set = config.fan.speed_normal;
        nibe.log(`Grundinställning: Normalt luftflöde (${flow_set} m3/h)`, 'fan', 'debug');

        if (config.fan.enable_low === true && data.cpr_set.raw_data > 0 && data.cpr_set.raw_data < config.fan.low_cpr_freq) {
            current_mode = "low";
            flow_set = config.fan.speed_low;
            nibe.log(`Kompressorn körs på låg frekvens (${data.cpr_set.raw_data} Hz). Aktiverar sänkt luftflöde: ${flow_set} m3/h`, 'fan', 'debug');
        }

        if (config.fan.enable_dm_boost === true && config.system.pump !== "F370" && config.system.pump !== "F470") {
            data.dM = await getNibeData(hP['dM']).catch(console.log);
            data.dMstart = await getNibeData(hP['dMstart']).catch(console.log);
            data.dMaddstart = await getNibeData(hP['dMaddstart']).catch(console.log);

            if(data.dM && data.dMstart && data.dMaddstart) {
                let boost_threshold = data.dMaddstart.data + (config.fan.dm_boost_start || 300);
                if (data.dM.data < boost_threshold) {
                    current_mode = "dm_boost";
                    flow_set = config.fan.dm_boost_value;
                    nibe.log(`Gradminuter (${data.dM.data}) under boostgräns (${boost_threshold}). Aktiverar boost-flöde: ${flow_set} m3/h`, 'fan', 'debug');
                }
            }
        }

        nibe.log(`[DEBUG Fan Logic] Slutgiltigt börvärde (flow_set) bestämt till: ${flow_set} m3/h`, 'fan', 'debug');

        // Steg 3: Utför reglering
        nibe.log(`[DEBUG Fan Villkor] Kontrollerar villkor för reglering: Avfrostning (alarm!=183): ${data.alarm.raw_data !== 183}, Förångare (>0): ${data.evaporator.raw_data > 0}, Tillfällig forcering (==0): ${data.temp_fan_speed.raw_data === 0}`, 'fan', 'debug');

        if((data.alarm.raw_data !== 183 && data.evaporator.raw_data > 0 && data.temp_fan_speed.raw_data === 0)) {
            if(flow_set === undefined) {
                nibe.log(`Inget börvärde kunde bestämmas, avvaktar...`,'fan','warn');
                return;
            }

            // Originalets regleringslogik
            if(data.bs1_flow.raw_data > (flow_set + 20)) {
                if(data.fan_speed.raw_data - 5 > 10) nibe.setData(hP.fan_speed, (data.fan_speed.raw_data - 5));
                else if(data.fan_speed.raw_data > 10) nibe.setData(hP.fan_speed, (data.fan_speed.raw_data - 1));
            } else if(data.bs1_flow.raw_data > (flow_set + 10)) {
                if(data.fan_speed.raw_data > 0) nibe.setData(hP.fan_speed, (data.fan_speed.raw_data - 1));
            } else if(data.bs1_flow.raw_data < (flow_set - 20)) {
                if(data.fan_speed.raw_data + 5 < 100) nibe.setData(hP.fan_speed, (data.fan_speed.raw_data + 5));
                else if(data.fan_speed.raw_data < 100) nibe.setData(hP.fan_speed, (data.fan_speed.raw_data + 1));
            } else if(data.bs1_flow.raw_data < (flow_set - 10)) {
                if(data.fan_speed.raw_data < 100) nibe.setData(hP.fan_speed, (data.fan_speed.raw_data + 1));
            } else {
                 nibe.log(`Luftflöde stabilt (${data.bs1_flow.raw_data} m3/h)`,'fan','debug');
                 if (config.fan.enable_filter === true) {
                    if (current_mode == "low") {
                        if (config.fan.filter_value_low === -1) {
                            config.fan.filter_value_low = data.fan_speed.raw_data;
                            nibe.setConfig(config);
                        } else if (config.fan.filter_value_low > 0) {
                            fan_filter_low_eff = Number(((config.fan.filter_value_low / data.fan_speed.raw_data) * 100).toFixed(0));
                        }
                    } else if (current_mode == "normal") {
                        if (config.fan.filter_value_normal === -1) {
                            config.fan.filter_value_normal = data.fan_speed.raw_data;
                            nibe.setConfig(config);
                        } else if (config.fan.filter_value_normal > 0) {
                            fan_filter_normal_eff = Number(((config.fan.filter_value_normal / data.fan_speed.raw_data) * 100).toFixed(0));
                        }
                    }
                 }
            }
        }

        // Steg 4: Spara och rapportera data
        data.cpr_act = await getNibeData(hP['cpr_act']).catch(console.log);
        saveDataGraph('fan_setpoint',timeNow,flow_set,true);
        if(fan_filter_low_eff!==undefined && fan_filter_normal_eff===undefined) {
            filter_eff = Number((fan_filter_low_eff).toFixed(0));
            if(filter_eff>100) filter_eff = 100;
        } else if(fan_filter_low_eff===undefined && fan_filter_normal_eff!==undefined) {
            filter_eff = Number((fan_filter_normal_eff).toFixed(0));
            if(filter_eff>100) filter_eff = 100;
        } else if(fan_filter_low_eff!==undefined && fan_filter_normal_eff!==undefined) {
            filter_eff = Number(((fan_filter_low_eff+fan_filter_normal_eff)/2).toFixed(0));
            if(filter_eff>100) filter_eff = 100;
        }
        saveDataGraph('filter_eff',timeNow,filter_eff,true);
        data.filter_eff = filter_eff;
        data.setpoint = flow_set;
        nibeData.emit('pluginFan',data);
    } finally {
        isRunFanExecuting = false;
    }
}


//##ORGINAL RUNFAN()
async function runFanOrginal() {
    async function checkBoost(data) {
        const promise = new Promise(async function (resolve,reject) {
        let config = nibe.getConfig();
        if(config.fan.enable_dm_boost!==undefined && config.fan.enable_dm_boost===true && config.system.pump!=="F370" && config.system.pump!=="F470") {
        data.dMadd = await getNibeData(hP['dMadd']).catch(console.log);
        data.dMaddstart = await getNibeData(hP['dMaddstart']).catch(console.log)
        data.dMstart = await getNibeData(hP['dMstart']).catch(console.log);
        if(data.dMaddstart===undefined) {
            data.dMaddstart = {}
            data.dMadd = await getNibeData(hP['dMadd']).catch(console.log);
            if(data.dMstart===undefined || data.dMadd===undefined) {
                nibe.log(`Kunde inte läsa gradminutregister, hoppar över boostkontroll.`,'fan','error');
                return reject(new Error('Kunde inte läsa gradminutregister'));
            }
            data.dMaddstart.data = data.dMstart.data-data.dMadd.data
            data.dMaddstart.raw_data = data.dMstart.raw_data-data.dMadd.raw_data
        }
        data.dM = await getNibeData(hP['dM']).catch(console.log);
            nibe.log(`Luftflödes boost vid låga gradminuter aktiverat.`,'fan','debug');
            if(config.fan.dm_boost_start===undefined || config.fan.dm_boost_start=="" || config.fan.dm_boost_start===0) {
                config.fan.dm_boost_start = 300;
                nibe.setConfig(config);
                nibe.log(`Inget standard värde för boosting, ställer 300 gradminuter som diff.`,'fan','debug');
            }
        let boost = (data.dMaddstart.data)+config.fan.dm_boost_start;
        nibe.log(`Boostvärde: ${boost}`,'fan','debug');
        if(boost>(data.dMstart.data-100)) {
            reject(new Error(`Startvärde för boost ligger för nära gradminuter vid start av kompressor, ${boost}>${data.dMstart.data-100}`))
        } else {
            var lock_freq_1 = await getNibeData(hP['lock_freq_1_activate']).catch(console.log);
            var lock_freq_2 = await getNibeData(hP['lock_freq_2_activate']).catch(console.log);

            if(lock_freq_1===undefined || lock_freq_2===undefined) {
                nibe.log(`Kunde inte läsa spärrbandsregister, hoppar över boostkontroll.`,'fan','error');
                return reject(new Error('Kunde inte läsa spärrbandsregister'));
            }
            if(data.dM.data<boost && lock_freq_1.data===0 && lock_freq_2.data===0) {
                nibe.log(`Gradminuter under gränsvärde för boost: ${boost}, Gradminuter: ${data.dM.data}`,'fan','debug');
                if(data.alarm.raw_data!==183) {
                    if(config.fan.dm_boost_value!==undefined && config.fan.dm_boost_value!=="" && config.fan.dm_boost_value!==0) {
                        if(fan_mode!='dMboost') {
                            fan_mode_saved = fan_mode
                            fan_mode = 'dMboost'
                            dMboost = true;
                            fan_saved = data.fan_speed.raw_data;
                            nibe.log(`Sparar fläkthastighet vid första upptäckt av forcering med gradminut boost, värde: ${fan_saved}%`,'fan','debug');
                        }
                        resolve(true)
                    } else {
                        reject(new Error('Inget boostvärde angivet'))
                    }
                } else {
                    nibe.log(`Gradminutboost uppfylld, men avfrostning pågår.`,'fan','debug');
                    reject();
                }
            } else if(lock_freq_1.data===1 && lock_freq_2.data===1) {
                dMboost = false;
                fan_mode = fan_mode_saved
                nibe.log(`Blockering av hög kompressorfrekvens pågår via elprisreglering`,'fan','debug');
                reject();
            } else if(data.dM.data>(boost+50)) {
                dMboost = false;
                fan_mode = fan_mode_saved
                nibe.log(`Gradminuter över gränsvärde för boost: ${boost+50}, Gradminuter: ${data.dM.data}`,'fan','debug');
                reject();
            } else {
                if(fan_mode=='dMboost') {
                    nibe.log(`Gradminuter under gränsvärde för boost, på väg mot stopp: ${boost}, Gradminuter: ${data.dM.data}`,'fan','debug');
                    resolve(true)
                } else {
                    dMboost = false;
                    fan_mode = fan_mode_saved
                    nibe.log(`Gradminuter över gränsvärde för boost: ${boost}, Gradminuter: ${data.dM.data}`,'fan','debug');
                    reject();
                }
            }
        }
    } else {
        dMboost = false;
        nibe.log(`Luftflödes boost vid låga gradminuter ej aktiverat.`,'fan','debug');
        reject();
    }
    if(fan_mode!=="dMboost" && fan_mode_saved=="dMboost") {
        if(data.alarm.raw_data!==183) {
            if(fan_saved!==undefined) {
                nibe.setData(hP.fan_speed,fan_saved);
                data.fan_speed.raw_data = fan_saved;
                nibe.log(`Återställer fläkthastighet (${fan_saved}%)`,'fan','debug');
            }
            if(config.fan[`speed_${fan_mode_saved}`]!==undefined) flow_set = config.fan[`speed_${fan_mode_saved}`];
            nibe.log(`Ställer in ${fan_mode_saved} luftflöde: ${config.fan[`speed_${fan_mode_saved}`]} m3/h`,'fan','debug');
        } else {
            nibe.log(`Avfrostning pågår, avvaktar, sparad fläkthastighet (${fan_saved}%)`,'fan','debug');
        }
    }
    });
    return promise;
    }
    let config = nibe.getConfig();
    var data = {};
    var timeNow = Date.now();
    if(config.fan===undefined) { config.fan = {}; nibe.setConfig(config); }
    if(config.home.inside_sensors===undefined) { config.home.inside_sensors = []; nibe.setConfig(config); }
    if(config.fan.enable!==true) {
        // Function turned off, stopping.
        return;
    }
    data.temp_fan_speed = await getNibeData(hP['fan_mode']).catch(console.log);
    if(data.temp_fan_speed===undefined) {
        nibe.log('Ingen data från fläktforceringsregister. Avbryter...','fan','error');
        return;
    }

    data.co2Sensor;
    data.fan_speed = await getNibeData(hP['fan_speed']).catch(console.log);
    data.bs1_flow = await getNibeData(hP['bs1_flow']).catch(console.log);
    // Check if bug with saving 0% resolves if(flow_set===undefined) flow_set = data.bs1_flow.raw_data;
    data.alarm = await getNibeData(hP['alarm']).catch(console.log);
    data.evaporator = await getNibeData(hP['evaporator']).catch(console.log);
    data.cpr_set = await getNibeData(hP['cpr_set']).catch(console.log);

    if(config.fan.enable_co2===true) {
    if(config.fan.sensor===undefined || config.fan.sensor=="Ingen") {
        nibe.log('CO2 givare inte vald.','fan','error');
    } else {
        let index = config.home.inside_sensors.findIndex(i => i.name == config.fan.sensor);
        if(index!==-1) {
            nibe.log('CO2 givare hittad.\n'+JSON.stringify(data.co2Sensor,null,2),'fan','debug');
            data.co2Sensor = Object.assign({}, config.home.inside_sensors[index]);
        } else {
            nibe.log('CO2 givare inte hittad.','fan','debug');
        }
    }
    if(data.co2Sensor!==undefined) {
        if(data.co2Sensor.source=="mqtt") {
            await nibe.getMQTTData(data.co2Sensor.register).then(atad => {
                let result = Object.assign({}, atad);
                nibe.log('Data från CO2 givare\n',result.data,'fan','debug');
                let sensor_timeout;
                if(config.home.sensor_timeout!==undefined && config.home.sensor_timeout!=="") {
                    sensor_timeout = result.timestamp+(config.home.sensor_timeout*60000);
                    nibe.log('Timeout vald för sensor, tid:'+config.home.sensor_timeout+" minuter",'fan','debug');
                } else if(config.home.sensor_timeout===0) {
                    sensor_timeout = timeNow;
                    nibe.log('Timeout är avvaktiverad för sensor','fan','debug');
                } else {
                    sensor_timeout = result.timestamp+(60*60000);
                    nibe.log('Timeout ej vald, sätter standard tid 60 minuter','fan','debug');
                }
                if(timeNow>sensor_timeout) {
                    nibe.log(`CO2 givare ${data.co2Sensor.name} har inte uppdaterats. Ignorerar.`,'fan','error');
                } else {
                    nibe.log(`CO2 givare ${data.co2Sensor.name} värde:${result.data}`,'fan','debug');
                    data.co2Sensor.data = result;
                    data.co2Sensor.data.timestamp = timeNow;
                    saveDataGraph('fan_co2Sensor',timeNow,data.co2Sensor.data.data,true)
                }

            },(error => {
                nibe.log(`CO2 givare ${data.co2Sensor.name} har inga värden än.`,'fan','error');
            }));
        } else if(data.co2Sensor.source=="tibber") {
            console.log('Tibber Data request');
        }
    }
}
    // Check if co2 wants boosting
        if(config.fan.enable_co2===true && config.fan.enable_high) {
            if(data.alarm.raw_data!==183) {
                nibe.log(`CO2 boosting aktiverad`,'fan','debug');
                if(config.fan.high_co2_limit===undefined || config.fan.high_co2_limit=="" || config.fan.high_co2_limit===0) {
                    nibe.log(`Inget standard värde för boosting, ställer in 1000 ppm`,'fan','debug');
                    config.fan.high_co2_limit = 1000;
                    nibe.setConfig(config);
                }
                data.high_co2_limit = config.fan.high_co2_limit;
                saveDataGraph('fan_high_co2_limit',timeNow,config.fan.high_co2_limit,true);
                if(data.co2Sensor!==undefined && data.co2Sensor.data!==undefined) {
                    data.co2Sensor.data.data = Number(data.co2Sensor.data.data);
                    if(data.co2Sensor.data.data>config.fan.high_co2_limit) {
                        nibe.log(`CO2 givares värde (${data.co2Sensor.data.data}) över gränsvärde ${config.fan.high_co2_limit}`,'fan','debug');
                        if(config.fan.speed_high!==undefined && config.fan.speed_high!="" && config.fan.speed_high!==0) {
                            if(fan_mode!='co2boost') {
                                fan_mode_saved = fan_mode
                                fan_mode = 'co2boost'
                                co2boost = true;
                            }
                            flow_set = config.fan.speed_high;
                            if(fan_mode!=="co2boost") {
                                fan_saved = data.fan_speed.raw_data;
                                nibe.log(`Sparar fläkthastighet vid första upptäckt av forcering med CO2, värde: ${fan_saved}%`,'fan','debug');
                            }
                            nibe.log(`Ställer in högt luftflöde: ${config.fan.speed_high} m3/h`,'fan','debug');
                            dMboost = false;
                        } else {
                            nibe.log(`Inget luftflöde valt för boosting.`,'fan','error');
                        }
                    } else {
                        nibe.log(`CO2 givares värde (${data.co2Sensor.data.data}) under gränsvärde ${config.fan.high_co2_limit}`,'fan','debug');

                        if(data.alarm.raw_data!==183) {
                            if(fan_saved!==undefined) {
                                nibe.setData(hP.fan_speed,fan_saved);
                                data.fan_speed.raw_data = fan_saved;
                                nibe.log(`Återställer fläkthastighet (${fan_saved}%)`,'fan','debug');
                            }
                            if(config.fan[`speed_${fan_mode_saved}`]!==undefined) flow_set = config.fan[`speed_${fan_mode_saved}`];
                            fan_mode = fan_mode_saved;
                            nibe.log(`Ställer in ${fan_mode_saved} luftflöde: ${config.fan[`speed_${fan_mode_saved}`]} m3/h`,'fan','debug');
                        } else {
                            nibe.log(`Avfrostning pågår, avvaktar, sparad fläkthastighet (${fan_saved}%)`,'fan','debug');
                        }
                    }
                } else {
                    nibe.log(`Inget värde på CO2 givare`,'fan','error');
                }
            } else {
                nibe.log(`Avfrostning pågår. Avvaktar.`,'fan','debug');
            }
    } else {
        nibe.log(`CO2 boosting ej aktiverad.`,'fan','debug');
    }
    if(fan_mode!=="co2boost") {
        co2boost = false;
        await checkBoost(data).then(result => {
            nibe.log(`Villkor för gradminutboosting uppfyllda.`,'fan','debug');
            flow_set = config.fan.dm_boost_value;

        },(err => {
            if(err) {
                //nibe.log(err,'fan','error');
            } else {
                if(config.fan.enable_low===true && data.cpr_set.raw_data<config.fan.low_cpr_freq) {
                    nibe.log(`Kompressorfrekvens under gränsvärde`,'fan','debug');
                    if(data.alarm.raw_data!==183) {
                        if(config.fan.enable_co2===true) {
                            nibe.log(`CO2 styrning aktiverad.`,'fan','debug');
                            if(data.co2Sensor!==undefined && data.co2Sensor.data!==undefined) {
                                nibe.log(`Värde finns från CO2 givare`,'fan','debug');
                                data.co2Sensor.data.data = Number(data.co2Sensor.data.data);
                                if(config.fan.low_co2_limit===undefined || config.fan.low_co2_limit=="" || config.fan.low_co2_limit===0) {
                                    config.fan.low_co2_limit = 800;
                                    nibe.setConfig(config);
                                    nibe.log(`Inget standard värde för CO2 valt, sätter 800 ppm.`,'fan','debug');
                                }
                                data.low_co2_limit = config.fan.low_co2_limit;
                                saveDataGraph('fan_low_co2_limit',timeNow,config.fan.low_co2_limit,true);
                                if(data.co2Sensor.data.data<config.fan.low_co2_limit) {
                                    if(fan_mode=="low") {
                                        flow_set = config.fan.speed_low;
                                        nibe.log(`CO2 givares värde (${data.co2Sensor.data.data}) ppm under gränsvärde för att kunna forcera låg fläkthastighet (${config.fan.low_co2_limit} ppm)`,'fan','debug');
                                    } else {
                                        if(fan_mode==="normal") {
                                            fan_saved = data.fan_speed.raw_data;
                                            nibe.log(`Sparar fläkthastighet vid första upptäckt av låg frekvens med CO2, värde: ${fan_saved}%`,'fan','debug');
                                        }
                                        fan_mode = "low";
                                    }
                                } else {
                                    if(fan_mode=="normal") {
                                        flow_set = config.fan.speed_normal;
                                        nibe.log(`CO2 givares värde (${data.co2Sensor.data.data}) ppm över gränsvärde för att kunna forcera låg fläkthastighet (${config.fan.low_co2_limit} ppm)`,'fan','debug');
                                    } else {
                                        fan_mode = "normal";
                                        nibe.log(`CO2 givares värde (${data.co2Sensor.data.data}) ppm över gränsvärde men avvaktar en cykel (${config.fan.low_co2_limit} ppm`,'fan','debug');
                                    }
                                }
                            } else {
                                    nibe.log(`Inget värde på CO2 givare, ställer in normalt luftflöde: ${config.fan.speed_normal} m3/h`,'fan','debug');
                                    flow_set = config.fan.speed_normal;
                                    fan_mode = "normal";
                            }
                        } else {
                            nibe.log(`CO2 styrning ej aktiverad`,'fan','debug');
                            if(config.fan.speed_low!==undefined && config.fan.speed_low!=="" && config.fan.speed_low!==0) {
                                if(fan_mode=="low") {
                                    flow_set = config.fan.speed_low;
                                    nibe.log(`Ställer in lågt luftflöde: ${config.fan.speed_low} m3/h`,'fan','debug');
                                } else {
                                    if(fan_mode==="normal") {
                                        fan_saved = data.fan_speed.raw_data;
                                        nibe.log(`Sparar fläkthastighet vid första upptäckt av låg frekvens, värde: ${fan_saved}%`,'fan','debug');
                                    }
                                    fan_mode = "low";
                                }
                            } else {
                                nibe.log(`Inget värde på lågt luftflöde`,'fan','debug');
                            }
                        }
                    } else {
                        nibe.log(`Avfrostning pågår, avvaktar.`,'fan','debug');
                    }
                } else {
                        if(fan_mode=="low") {
                            nibe.log(`Kompressorfrekvens över gränsvärde och föregående läge var låg frekvens.`,'fan','debug');
                            if(data.alarm.raw_data!==183) {
                                if(fan_saved!==undefined) {
                                    nibe.setData(hP.fan_speed,fan_saved);
                                    data.fan_speed.raw_data = fan_saved;
                                    nibe.log(`Återställer fläkthastighet (${fan_saved}%)`,'fan','debug');
                                }
                                flow_set = config.fan.speed_normal;
                                fan_mode = "normal";
                                nibe.log(`Ställer in normalt luftflöde: ${config.fan.speed_normal} m3/h`,'fan','debug');
                            } else {
                                nibe.log(`Avfrostning pågår, avvaktar, sparad fläkthastighet (${fan_saved}%)`,'fan','debug');
                            }
                        } else {
                            nibe.log(`Villkor uppfyllda för normalt luftflöde: ${config.fan.speed_normal} m3/h`,'fan','debug');
                            if(data.alarm.raw_data!==183) {
                                flow_set = config.fan.speed_normal;
                                fan_mode = "normal";
                                nibe.log(`Ställer in normalt luftflöde: ${config.fan.speed_normal} m3/h`,'fan','debug');
                            } else {
                                nibe.log(`Avfrostning pågår, avvaktar...`,'fan','debug');
                            }
                        }
                }
            }
        }));
    }


    // Start regulating only if not defrosting and vented air is above freezing temperatures.
    if((data.alarm.raw_data!==183 && data.evaporator.raw_data>0 && data.temp_fan_speed!==undefined && data.temp_fan_speed.raw_data===0)) {
        if(flow_set<30) {
            nibe.log(`För lågt luftflöde inställt, avbryter.`,'fan','error');
            return;
        }
        if(flow_set===undefined) {
            nibe.log(`Inget börvärde på flöde, avvaktar...`,'fan','error');
            return;
        }
        nibe.log(`Villkor uppfyllda för reglering av flöde.`,'fan','debug');
        nibe.log(`Flowset: ${flow_set}, Flöde: ${data.bs1_flow.raw_data}, Flowsaved: ${flow_saved}`,'fan','debug');
        if(fan_mode!=="dMboost" && fan_mode!=="co2boost" && fan_mode!=="low" && data.bs1_flow.raw_data>(flow_set+25) && (flow_saved===undefined || data.bs1_flow.raw_data>flow_saved+25)) {
            nibe.log(`Luftflöde långt över börvärde: ${flow_set}, Flöde: ${data.bs1_flow.raw_data} m3/h, Forcering pågår`,'fan','debug');
        } else if(data.bs1_flow.raw_data>(flow_set+20)) {
            if(data.fan_speed.raw_data-5>10) {
                nibe.log(`Luftflöde långt över gränsvärde: ${flow_set+20}, Flöde: ${data.bs1_flow.raw_data} m3/h, -5%`,'fan','debug');
                nibe.setData(hP.fan_speed,(data.fan_speed.raw_data-5));
            } else if(data.fan_speed.raw_data>10) {
                nibe.log(`Luftflöde långt över gränsvärde: ${flow_set+20}, Flöde: ${data.bs1_flow.raw_data} m3/h, -1%`,'fan','debug');
                nibe.setData(hP.fan_speed,(data.fan_speed.raw_data-1));
            }
        } else if(data.bs1_flow.raw_data>(flow_set+10)) {
            nibe.log(`Luftflöde över gränsvärde: ${flow_set+10}, Flöde: ${data.bs1_flow.raw_data} m3/h, -1%`,'fan','debug');
            if(data.fan_speed.raw_data>0) nibe.setData(hP.fan_speed,(data.fan_speed.raw_data-1));
        } else if(data.bs1_flow.raw_data<(flow_set-20)) {
            if(data.fan_speed.raw_data+5<100) {
                nibe.log(`Luftflöde långt under gränsvärde: ${flow_set+20}, Flöde: ${data.bs1_flow.raw_data} m3/h, +5%`,'fan','debug');
                nibe.setData(hP.fan_speed,(data.fan_speed.raw_data+5));
            } else if(data.fan_speed.raw_data<100) {
                nibe.log(`Luftflöde långt under gränsvärde: ${flow_set+20}, Flöde: ${data.bs1_flow.raw_data} m3/h, +1%`,'fan','debug');
                nibe.setData(hP.fan_speed,(data.fan_speed.raw_data+1));
            }
        } else if(data.bs1_flow.raw_data<(flow_set-10)) {
            nibe.log(`Luftflöde under gränsvärde: ${flow_set+10}, Flöde: ${data.bs1_flow.raw_data} m3/h, +1%`,'fan','debug');
            if(data.fan_speed.raw_data<100) nibe.setData(hP.fan_speed,(data.fan_speed.raw_data+1));
        } else {
            nibe.log(`Luftflöde stabilt (${data.bs1_flow.raw_data} m3/h)`,'fan','debug');
            dMboost = false;
            co2boost = false;
            flow_saved = data.bs1_flow.raw_data;
            if(config.fan.enable_filter===true) {
                nibe.log(`Filterkontroll är aktiverad`,'fan','debug');
            // Value is stable, save fan speeds if calibration is active.
            if(fan_mode=="low") {
                if(config.fan.filter_value_low===-1) {
                    config.fan.filter_value_low = data.fan_speed.raw_data;
                    nibe.setConfig(config);
                } else {
                    if(config.fan.filter_value_low!==undefined && config.fan.filter_value_low!="") {
                        let saved = config.fan.filter_value_low;
                        fan_filter_low_eff = Number(((saved/data.fan_speed.raw_data)*100).toFixed(0));
                    }
                }
            } else if(fan_mode=="normal") {
                if(config.fan.filter_value_normal===-1) {
                    config.fan.filter_value_normal = data.fan_speed.raw_data;
                    nibe.setConfig(config);
                } else {
                    if(config.fan.filter_value_normal!==undefined && config.fan.filter_value_normal!="") {
                        let saved = config.fan.filter_value_normal;
                        fan_filter_normal_eff = Number(((saved/data.fan_speed.raw_data)*100).toFixed(0));
                    }

                }
            }
            fan_mode = undefined;
            if(fan_filter_low_eff!==undefined && fan_filter_normal_eff===undefined) {
                filter_eff = Number((fan_filter_low_eff).toFixed(0));
                if(filter_eff>100) filter_eff = 100;
            } else if(fan_filter_low_eff===undefined && fan_filter_normal_eff!==undefined) {
                filter_eff = Number((fan_filter_normal_eff).toFixed(0));
                if(filter_eff>100) filter_eff = 100;
            } else if(fan_filter_low_eff!==undefined && fan_filter_normal_eff!==undefined) {
                filter_eff = Number(((fan_filter_low_eff+fan_filter_normal_eff)/2).toFixed(0));
                if(filter_eff>100) filter_eff = 100;
            } else {

            }
            }
        }
    } else {
        if(co2boost===false) nibe.log(`Villkor för reglering ej uppfyllt, CO2 boost inte över gränsvärde`,'fan','debug');
        if(dMboost===false) nibe.log(`Villkor för reglering ej uppfyllt, Gradminutboost inte under gränsvärde`,'fan','debug');
        if(data.alarm.raw_data===183) nibe.log(`Villkor för reglering ej uppfyllt, avfrostning pågår.`,'fan','debug');
        if(data.evaporator.raw_data<0) nibe.log(`Villkor för reglering ej uppfyllt, förångaren för kall (${data.evaporator.raw_data})`,'fan','debug');
        if(data.temp_fan_speed!==undefined && data.temp_fan_speed.raw_data!==0) nibe.log(`Villkor för reglering ej uppfyllt, Tillfällig fläktforcering pågår. värde: ${data.temp_fan_speed.raw_data}`,'fan','debug');
    }
    data.cpr_act = await getNibeData(hP['cpr_act']).catch(console.log);
    saveDataGraph('fan_setpoint',timeNow,flow_set,true);
    saveDataGraph('filter_eff',timeNow,filter_eff,true);
    data.filter_eff = filter_eff;
    data.setpoint = flow_set;
    nibeData.emit('pluginFan',data);
}
async function runRMU(result,array) {
    let config = nibe.getConfig();
    var data = Object.assign({}, result);
    if(config.rmu===undefined) config.rmu = {};
    for( var i = 1; i < 5; i++){
        data.system = "s"+i;
        let inside;
        if(config.rmu['sensor_s'+i]!==undefined && config.rmu['sensor_s'+i]!=="") {
            let ind = array.findIndex(index => index.name == config.rmu['sensor_s'+i]);
            if(ind!==-1) inside = array[ind];
        }
        let register = nibe.getRegister();
        let sensor = register.find(index => index.register == hP['rmu_sensor_s'+i]);
        if(sensor!==undefined && sensor.mode=="R/W") {
            if(inside!==undefined) {
                nibe.setData(hP['rmu_sensor_s'+i],inside.data);
            } else {
                sendError(`RMU40 System ${i}`,`Givare har inga värden, avbryter...`);
                return;
            }
            data.rmuSensor = inside;
            nibeData.emit('pluginRMU',data);
        } else {

        }
    }
}
async function getNibeData(register) {
    const promise = new Promise((resolve,reject) => {
    if(savedData[register]===undefined || Date.now()>(savedData[register].timestamp+30000)) {
        nibe.reqData(register).then(atad => {
            let data = Object.assign({}, atad);
            resolve(data);
        }).catch(err => {
            reject(err);
        });
    } else {
        resolve(savedData[register]);
    }
});
return promise;
}
isObject = function(a) {
    return (!!a) && (a.constructor === Object);
};
function saveDataGraph(name,ts,data,save=false) {
    function isValid(data) {
        if(data!==undefined) {
            //First data, saving.
            if(isObject(data)===true) {
                return true;
            } else {
                if(data>-3276) {
                    return true;
                } else {
                    return false;
                    //Invalid first data, not saving.
                }
            }
        } else {
            return false;
        }
    }
    if(savedGraph[name]===undefined) savedGraph[name] = [];
    let lastIndex = savedGraph[name].length-1;
    if(savedGraph[name].length>=2) {
        if(ts>=(savedGraph[name][lastIndex].x+55000)) {
            if(isValid(data)===true) {
                if((Math.abs(savedGraph[name][lastIndex].y-data)>0.1)) {
                    savedGraph[name].push({x:ts,y:data});
                } else {
                    if(savedGraph[name][lastIndex-1].y===data) {
                        savedGraph[name][lastIndex].x = ts;
                    } else {
                        savedGraph[name].push({x:ts,y:data});
                    }

                }
            }
        } else {
            // Check if the timestamp match saved timestamp.
            if(isValid(data)===true) {
                let index = savedGraph[name].findIndex(i => i.x == ts);
                if(index!==-1) {
                    savedGraph[name][index].y = data;
                }
            }
        }
    } else {
        if(isValid(data)===true) savedGraph[name].push({x:ts,y:data});
    }
    if(save===true) {
        savedData[name] = {data:data,raw_data:data,timestamp:ts};
    }

}
const gethP  = () => {
    return hP;
}
function getSavedData() {
    return savedData;
}
function getSavedGraph() {
    return savedGraph;
}
function getSystems() {
    return systems;
}
let defrostTimer = 60000;
let defrosting;
let cpr_running;
let defrost_saved;
let runTime;
let savedRunTime = Date.now();
async function checkEfficiency(runtime,defrost) {
    let time = Date.now();
    let total = runtime+defrost;
    let uptime = Number((runtime/total*100).toFixed(0));
    let downtime = 100-uptime;
    saveDataGraph('cpr_uptime',time,uptime,true);
    saveDataGraph('cpr_downtime',time,downtime,true);
}
async function runDiagnostic() {
    nibe.log(`Running diagnostic`,'diagnostic','debug');
    async function uptimeCheck() {
        getNibeData(hP['cpr_act']).then(cpr => {
            if(cpr.data>=1) {
                if(cpr_running===undefined) {
                    saveDataGraph('cpr_runtime',Date.now(),Number(((Date.now()-savedRunTime)/60000).toFixed(0)),true);
                } else if(cpr_running===false) {
                    nibe.log(`Compressor just started.`,'diagnostic','debug');
                    if(runTime!==undefined && defrost_saved!==undefined) {
                        nibe.log(`Cycle completed. Run time: ${(runTime/60000).toFixed()} minutes, Defrost time: ${(defrost_saved/60).toFixed(0)}`,'diagnostic','debug');
                        checkEfficiency(Number((runTime/1000).toFixed(0)),defrost_saved);
                        saveDataGraph('cpr_efficiency',Date.now(),{uptime:Number((runTime/1000).toFixed(0)),defrost:defrost_saved},true);
                        runTime = undefined;
                        defrost_saved = undefined;
                    }
                    savedRunTime = Date.now();
                    saveDataGraph('cpr_runtime',Date.now(),Number(((Date.now()-savedRunTime)/60000).toFixed(0)),true);
                    cpr_running = true;

                } else {
                    nibe.log(`Compressor running.`,'diagnostic','debug');
                    saveDataGraph('cpr_runtime',Date.now(),Number(((Date.now()-savedRunTime)/60000).toFixed(0)),true);
                }
            } else {
                if(cpr_running===undefined) {
                    nibe.log(`Compressor not running at startup`,'diagnostic','debug');
                    cpr_running = false;
                } else if(cpr_running===true) {
                    runTime = Date.now()-savedRunTime;
                    nibe.log(`Compressor just shutdown. Run time: ${(runTime/60000).toFixed(0)} minutes`,'diagnostic','debug');
                    cpr_running = false;
                }
                saveDataGraph('cpr_runtime',Date.now(),0,true);
            }
        }).catch(console.log);
    }
    async function defrostCheck() {
        if(timer.diagnostic!==undefined && timer.diagnostic._idleTimeout>0) {
            clearTimeout(timer.diagnostic);
        }
        nibe.log(`Defrost timer running...`,'diagnostic','debug');
        getNibeData(hP['defrost_time']).then(defrost => {
            nibe.log(`Got defrost data: ${defrost.data} sec`,'diagnostic','debug');
            if(defrost.data>0) {
                defrostTimer = 10000;
                defrost_saved = defrost.data;
                nibe.log(`Defrost is active!, checking again in ${defrostTimer/1000} sec`,'diagnostic','debug');
                saveDataGraph('defrosting',Date.now(),Number((defrost.data/60).toFixed(0)),true);
                saveDataGraph('cpr_runtime',Date.now(),0,true);
            } else {
                if(defrost_saved===undefined) {
                    defrost_saved = defrost.data;
                }
                saveDataGraph('defrosting',Date.now(),0,true);
                defrostTimer = 60000;
                nibe.log(`Defrost is inactive, checking again in ${defrostTimer/1000} sec`,'diagnostic','debug');
            }
            if(timer.diagnostic===undefined || timer.diagnostic._idleTimeout===-1) {
                timer.diagnostic = setTimeout(defrostCheck, defrostTimer);
            }
        }).catch(err => {
            nibe.log(`No defrost data.`,'diagnostic','debug');
            defrostTimer = 60000;
            if(timer.diagnostic===undefined || timer.diagnostic._idleTimeout===-1) {
                timer.diagnostic = setTimeout(defrostCheck, defrostTimer);
            }
        })
        uptimeCheck();
    }
    let config = nibe.getConfig();
    if(config.system===undefined) {
        config.system = {};
        nibe.setConfig(config);
    }
    if(config.system.pump!==undefined && (config.system.pump=="F730" || config.system.pump=="F750")) {
        nibe.log(`Heatpump is supported, starting defrost check timer, timer: ${defrostTimer/1000} sec`,'diagnostic','debug');
        if(timer.diagnostic===undefined || timer.diagnostic._idleTimeout===-1) {
            timer.diagnostic = setTimeout(defrostCheck, defrostTimer);
        }
    } else {
        nibe.log(`Heatpump is not supported`,'diagnostic','debug');
    }
}
async function tenMinuteUpdate() {
    let config = nibe.getConfig();
    if(config.system.auto_update===undefined || config.system.auto_update===true) {
        getNibeData(hP['inside_set_s1']).catch(console.log);
        if(systems!==undefined && systems.s2===true) {
            getNibeData(hP['inside_set_s2']).catch(console.log);
        }
    }
}
async function minuteUpdate() {
    let config = nibe.getConfig();
    if(config.system.auto_update===undefined) {
        config.system.auto_update = true;
        nibe.setConfig(config);
    }
    if(config.system.auto_update===true) {
        getNibeData(hP['outside']).catch(console.log);
        getNibeData(hP['inside_s1']).catch(console.log);
        getNibeData(hP['curveadjust_s1']).catch(console.log);
        getNibeData(hP['setpoint_s1']).catch(console.log);
        getNibeData(hP['supply_s1']).catch(console.log);
        if(systems!==undefined && systems.s2===true) {
            getNibeData(hP['inside_s2']).catch(console.log);
            getNibeData(hP['curveadjust_s2']).catch(console.log);
            getNibeData(hP['setpoint_s2']).catch(console.log);
            getNibeData(hP['supply_s2']).catch(console.log);
        }
    }
}
const checkTranslation = (node) => {
    let config = nibe.getConfig();
    if(config.system===undefined) {
        config.system = {language:"SE"};
        nibe.setConfig(config);
    }
    if(config.system.language===undefined) {
        config.system.language = "SE";
        nibe.setConfig(config);
    }
    text = require(`./language-${config.system.language}.json`)
    node.context().global.set(`translate`, translate);
}
    console.log(text.starting)

    function nibeConfig(n) {
        RED.nodes.createNode(this,n);
        var cron = require('node-cron');
        let config = nibe.getConfig();
        if(config.price===undefined) {
            config.price = {};
            nibe.setConfig(config);
            nibe.log(`Sätter config för första gången för elprisregleringen.`,'price','debug');
        }
        if(config.price.enable_freq===undefined) {
            config.price.enable_freq = false
            config.price.block_add = false
            config.price.enable_dM_reset = false
            config.price.min_freq = 21
            config.price.max_freq = 35
            config.price.min_temp = -20
            config.price.max_temp = 0
            nibe.setConfig(config);
            nibe.log(`Sätter config för Elprisreglering till standardvärden för frekvensstyrning`,'price','debug');
        }
        nibeData.emit('config',nibe.getConfig());
        checkTranslation(this);
        const handleMQTT = (config) => {
            if(config.mqtt===undefined) config.mqtt = {};
            nibe.handleMQTT(config.mqtt.enable,config.mqtt.host,config.mqtt.port,config.mqtt.user,config.mqtt.pass, (err,result) => {
                if(err) this.warn(err);
                if(result===true) {
                    //console.log('MQTT broker is connected')
                } else {
                    //console.log('MQTT broker is disconnected')
                }
            })
        }

        const handleCore = (config,force=false) => {
            if(config.connection===undefined) config.connection = {};
            if(config.serial===undefined) config.serial = {};
            if(config.tcp===undefined) config.tcp = {};
            console.log(`Heatpump Series: ${config.connection.series}`);
            if(config.connection.series=="fSeries") {
                hP = require('./dataregister.json').fSeries;
            } else if(config.connection.series=="sSeries") {
                hP = require('./dataregister.json').sSeries;
            } else {
                hP;
            }
            if(tcp_host!==config.tcp.host || tcp_port!==config.tcp.port || serialPort!==config.serial.port || series!==config.connection.series || force===true) {
                nibe.stopCore(nibe.core).then(result => {
                    nibe.resetCore();
                    if(config.connection.series=="fSeries") {
                    if(config.serial.port!=="" && config.serial.port!==undefined && (config.connection.enable==="serial" || config.connection.enable==="nibegw")) {
                        if(nibe.core===undefined || nibe.core.connected===undefined || nibe.core.connected===false) {
                            initiateCore(null,config.serial.port, async (err,result)=> {
                                if(err) console.log(err);
                                let config = nibe.getConfig();
                                if(config.system===undefined) {
                                    config.system = {};
                                    nibe.setConfig(config);
                                }
                                // 40047 and 40071 are probes: which register carries supply
                                // temp S1 depends on the pump model, and on models that have
                                // neither, the request can only ever be answered with
                                // "not in database". Ask the loaded register table instead of
                                // firing a request whose failure is the expected result. If
                                // the table is not populated yet, fall back to probing so the
                                // models that do have these registers still find them.
                                const registerTable = nibe.getRegister();
                                const tableLoaded = Array.isArray(registerTable) && registerTable.length > 0;
                                const hasRegister = (addr) => !tableLoaded || registerTable.some(entry => entry.register == addr);
                                if(hasRegister('40047')) {
                                    var c1 = await getNibeData('40047').catch(console.log)
                                    if(c1!==undefined && c1.data > 0) {
                                        hP.supply_s1 = "40047";
                                        console.log('Register 40047 found, using it for supply temp S1')
                                    }
                                }
                                if(hasRegister('40071')) {
                                    var c2 = await getNibeData('40071').catch(console.log)
                                    if(c2!==undefined && c2.data > 0)  {
                                        hP.supply_s1 = "40071";
                                        console.log('Register 40071 found, using it for supply temp S1')
                                    }
                                }

                                //if(config.system.pump=="F750") hP.supply_s1 = "40047";
                                //if(config.system.pump=="F1345") hP.supply_s1 = "40071";
                                sendError('Kärnan',`Nibe ${config.system.pump} är ansluten`);
                                console.log('Core is connected');
                                updateData(true);
                                nibe.redOn();
                                this.register = nibe.getRegister();
                                this.context().global.set(`register`, this.register);
                                nibeData.emit('ready',true);
                            })
                        }
                    }
                } else if(config.connection.series=="sSeries") {
                    if(config.tcp.host!==undefined && config.tcp.host!=="" && config.tcp.port!==undefined && config.tcp.port!=="" && config.connection.enable==="tcp") {
                        if(nibe.core===undefined || nibe.core.connected===undefined || nibe.core.connected===false) {
                            initiateCore(config.tcp.host,config.tcp.port, (err,result)=> {
                                if(err) console.log(err);
                                let config = nibe.getConfig();
                                if(config.system===undefined) {
                                    config.system = {};
                                    nibe.setConfig(config);
                                }
                                sendError('Kärnan',`Nibe ${config.tcp.pump} är ansluten`);
                                console.log('Core is connected');
                                updateData(true);
                                nibe.redOn();
                                this.register = nibe.getRegister();
                                this.context().global.set(`register`, this.register);
                                nibeData.emit('ready',true);
                            })
                        }
                    }
                }
                });
                }
            serialPort = config.serial.port;
            series = config.connection.series;
            tcp_host = config.tcp.host;
            tcp_port = config.tcp.port;
        }
        const checkReady = (cb) => {
            if(nibe.core!==undefined && nibe.core.connected!==undefined && nibe.core.connected===true) {
                cb(null,nibe.core.connected);
            }
        }
        if(nibe.core!==undefined && nibe.core.connected!==undefined && nibe.core.connected===true) {
            runDiagnostic();
        } else {
            nibeData.on('ready', (data) => {
                runDiagnostic();
            })
        }
        handleCore(nibe.getConfig());
        handleMQTT(nibe.getConfig());
        nibe.requireGraph().then(result => {
            let config = nibe.getConfig();
            if(config.system===undefined || config.system.save_graph!==true) return;
            if(result===undefined) return;
            savedGraph = result;
            //this.context().global.set(`graphs`, result);
        },(err => {

        }));

        RED.httpAdmin.post("/config/:id", RED.auth.needsPermission("nibe-config.write"), function(req, res) {
            nibe.setConfig(req.body.config);
            handleCore(req.body.config);
            nibeData.emit(req.params.id,req.body.data);
            //handleMQTT(req.body);
        });
        RED.httpAdmin.get('/config', function(req, res) {
            res.json(nibe.getConfig());
        });
        async function saveGraph() {
            const promise = new Promise((resolve,reject) => {
                let config = nibe.getConfig();

                    trimGraph().then(data => {
                        if(config.system.save_graph!==undefined && config.system.save_graph===true) {
                            if(savedGraph!==undefined && savedGraph.length!==0) {
                                nibe.saveGraph(savedGraph).then(result => {
                                    resolve(result);
                                },(err => {
                                    reject(err);
                                }));
                            }
                        } else {
                            reject('Not saving graphs')
                        }
                    })


        });
        return promise
        }
        function trimGraph() {
            const promise = new Promise((resolve,reject) => {
                for (var object in savedGraph) {
                    if (savedGraph.hasOwnProperty(object)) {
                        if(savedGraph[object]!==undefined && savedGraph[object].length>5000) {
                            let len = savedGraph[object].length-5000;
                            savedGraph[object].splice(0,len)
                        }
                    }
                }
                resolve()
            });
            return promise;
        }

        var everyminute = cron.schedule('*/1 * * * *', () => {
            if(nibe.core!==undefined && nibe.core.connected!==undefined && nibe.core.connected===true) {
                nibeData.emit('updateGraph');
                minuteUpdate();
                hotwaterPlugin();
                vvAiTick();
                runFan()
            }

        })
        var threeminutes = cron.schedule('*/3 * * * *', () => {
            if(nibe.core!==undefined && nibe.core.connected!==undefined && nibe.core.connected===true) {
                updateData();
            }

        })
        var tenminutes = cron.schedule('*/10 * * * *', () => {
            if(nibe.core!==undefined && nibe.core.connected!==undefined && nibe.core.connected===true) {
                tenMinuteUpdate()
            }
        })

        var hourly = cron.schedule('0 * * * *', () => {
            if(nibe.core!==undefined && nibe.core.connected!==undefined && nibe.core.connected===true) {
            //let graph = this.context().global.get(`graphs`);
            saveGraph().catch(err => {

            });
            updateData(true);
            }
        })

    nibe.data.on('config',data => {
        if(timer.config!==undefined && timer.config._idleTimeout>0) {
            clearTimeout(timer.config);
        }
        timer.config = setTimeout(() => {
            nibeData.emit('config',data);
        }, 500);
        this.config = data;
        this.context().global.set(`config`, this.config);
    })


    nibe.data.on('data',data => {
        nibeData.emit(data.register,data);
        nibeData.emit('data',data);
        savedData[data.register] = data;
        saveDataGraph(data.register,Date.now(),data.raw_data)
        //console.log(`${data.register}, ${data.titel}: ${data.data} ${data.unit}`)
    })
    nibe.data.on('mqttData',data => {
        saveDataGraph(data.register,data.timestamp,data.raw_data,true)
    })
    var rmu_ready = false;
    nibe.data.on('rmu_ready',data => {
        rmu_ready = true;
        nibeData.emit('rmu_ready',data);
    });
    function checkRMU() {
        return rmu_ready;
    }
    nibe.data.on('updateSensor',data => {
        nibeData.emit('ready',true);
    })
        nibe.data.on('fault',data => {
            if(data.from=="core") {
                sendError(data.from,data.message);
                nibe.core = undefined;
                handleCore(nibe.getConfig(),true);
            } else {
                sendError(data.from,data.message);
            }

        })
        this.config = nibe.getConfig();
        this.saveGraph = saveGraph;
        this.suncalc = suncalc;
        this.savedData = getSavedData;
        this.savedGraph = getSavedGraph;
        this.systems = getSystems;
        this.updateConfig = updateConfig;
        this.nibe = nibe;
        this.cron = cron;
        this.text = text;
        this.checkRMU = checkRMU;
        this.nibeData = nibeData;
        this.initiatePlugin = initiatePlugin;
        this.updateData = updateData;
        this.hotwaterPlugin = hotwaterPlugin;
        this.runTibber = getCloudData;
        this.runFan = runFan;
        this.sendError = sendError;
        this.curveAdjust = curveAdjust;
        this.hP = gethP;
        this.checkReady = checkReady;
        this.translate = translate;
        this.on('close', function() {
            console.log('Closing listeners');
            nibeData.removeAllListeners();
            nibe.data.removeAllListeners();
            everyminute.stop();
            threeminutes.stop();
            tenminutes.stop();
            hourly.stop();
            clearTimeout(timer.diagnostic);
        });
    }

    RED.nodes.registerType("nibe-config",nibeConfig);

}
