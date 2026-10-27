// VV-AI: learns when hot water is used, plans heating windows before the peaks,
// and runs the hot water control every minute.
module.exports = function (ctx) {
    const path = require('path');
    const fs = require('fs');
    const { getNibeData, nibe, nibeData } = ctx;

    // Robust bool-tolkning (Node-RED kan ibland ge true/false som strängar)
    const vvAiIsTrue = (v) => {
        if (v === true || v === 1) return true;
        if (typeof v === 'string') {
            const s = v.trim().toLowerCase();
            return (s === 'true' || s === '1' || s === 'on' || s === 'yes');
        }
        return false;
    };
    // VV-AI's profile, plan and prices are 168 hour-of-week slots, Monday 00:00 = 0.
    // A heating window may run across midnight, and from Sunday into Monday.
    const vvWrap = (i) => ((i % 168) + 168) % 168;
    // vvAiBuildPlan records each planned window as {start, len, peak, cheapStart}:
    // the window's first slot and length, the peak it heats for, and the first of the
    // two consecutive hours in it that are cheapest (null without prices for them).
    // With price control on, plan heating may happen in those two hours, or in the
    // last two before the peak once they have passed. The control tick and the chart
    // both use this, so the hours shown are the hours allowed.
    const vvAiPlanHeatAllowed = (blocks, hourIndex) => {
        if (!Array.isArray(blocks) || blocks.length === 0) return true;
        let allowed = false;
        for (const b of blocks) {
            if (vvWrap(hourIndex - b.start) >= b.len) continue;
            if (b.cheapStart === null) return true;
            const second = vvWrap(b.cheapStart + 1);
            if (hourIndex === b.cheapStart || hourIndex === second) {
                allowed = true;
                continue;
            }
            const untilPeak = vvWrap(b.peak - hourIndex);
            if ((untilPeak === 1 || untilPeak === 2) && untilPeak < vvWrap(b.peak - second)) {
                allowed = true;
            }
        }
        return allowed;
    };
    const vvAiHeatMask = (blocks) => {
        const mask = new Array(168).fill(false);
        for (const b of (Array.isArray(blocks) ? blocks : [])) {
            if (b.cheapStart === null) continue;
            mask[b.cheapStart] = true;
            mask[vvWrap(b.cheapStart + 1)] = true;
        }
        return mask;
    };
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
    let vvEventHistory = [];    // BT6 under pågående event, för VV_DRAW_TRAIL_MS
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
    // Har BT6 under så här lång tid bara fallit i avsvalningstakt är tappet slut
    // och eventet stängs. Annars samlar ett event som öppnats av ett verkligt tapp
    // på sig avsvalning tills något annat stoppar det, och bedöms på ett snitt
    // där tappet späds ut - eller där avsvalningen fyller ut ett litet tapp till
    // över minDrop. Längre än mellanrummen mellan en diskmaskins fyllningar.
    const VV_DRAW_TRAIL_MS = 60 * 60 * 1000;
    // Ren säkerhetsbroms så att ett event inte kan leva hur länge som helst.
    // Gränsen var 90 min och gjorde dubbelt arbete: den användes också för att
    // förkasta stillestånd, och förkastade därmed verkliga kvällstapp som tagit
    // mer än 90 minuter. Den bedömningen görs nu på VV_DRAW_MIN_RATE.
    const VV_DRAW_MAX_MS = 360 * 60 * 1000;
    // Skyddar mot överlappande vvAiTick(): cron startar en ny tick varje minut
    // utan att invänta den förra, och alla vv*-variabler ovan är delade.
    let vvTickRunning = false;
    let vvLastManualSchedule = false; // tidsstyrning VV – tidigare läge (on/off)
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
            // Att filen saknas är normaltillståndet vid första starten, och efter
            // en avsiktlig rensning av profilen. Det är inte ett fel, och ska inte
            // loggas som ett: writeLog lyfter en dashboard-fault för både error
            // och info, så en tom disk gav en fault varje gång containern
            // startade. En trasig eller oläsbar fil är däremot ett verkligt fel
            // och ska fortsätta synas.
            if (err && err.code === 'ENOENT') {
                nibe.log(`VV-AI: ingen sparad profil i ${VV_AI_STORE_FILE}, ` +
                    `börjar från en tom profil`, 'hotwater', 'debug');
            } else {
                nibe.log(`VV-AI load error: ${err}`, 'hotwater', 'error');
            }
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
                `${durMin} min, ${rate.toFixed(2)} °C/h, ` +
                `timme ${getWeekHourIndex(learnTs)}/167, avslut: ${why}`,
                'hotwater', 'debug');
        } else if (tooSlow) {
            nibe.log(`VV-tapp förkastat (stillestånds-/cirkulationsförlust): ` +
                `${span.toFixed(1)} °C (${bt6Span}) på ${durMin} min ` +
                `= ${rate.toFixed(2)} °C/h < ${VV_DRAW_MIN_RATE.toFixed(2)} °C/h`,
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
        vvEventHistory = [];
        vvEventPeak = current;
        vvEventPeakTs = ts;
    }
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
                    const rEco = await getNibeData(ctx.hP['hw_stop_0']).catch(() => undefined);
                    if (rEco && typeof rEco.data === 'number' && Number.isFinite(rEco.data)) {
                        ecoStop = rEco.data;
                    }
                } catch (e) {
                    // ignorerar, ecoStop får ev. förbli NaN
                }
            }

            if (!Number.isFinite(normalStop)) {
                try {
                    const rNormal = await getNibeData(ctx.hP['hw_stop_1']).catch(() => undefined);
                    if (rNormal && typeof rNormal.data === 'number' && Number.isFinite(rNormal.data)) {
                        normalStop = rNormal.data;
                    }
                } catch (e) {
                    // ignorerar, normalStop får ev. förbli NaN
                }
            }

            if (!Number.isFinite(luxStop)) {
                try {
                    const rLux = await getNibeData(ctx.hP['hw_stop_2']).catch(() => undefined);
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

            const heatBlocks = [];
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
                // A day runs from 02:00 to 02:00 the next morning, as in daySum above, so a
                // draw just after midnight belongs to the evening before. Hours are offsets
                // from the day's midnight (2..25).
                for (let h = 2; h < 26; h++) {
                    const v = profile[vvWrap(base + h)];

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
                    // peak is the peak hour's slot, unwrapped: the window before it may start
                    // the previous day, or before Monday 00:00.
                    const peak = base + peakHour;
                    const minHeatLen = Math.max(1, ph); // minst 1h även om ph=0

                    // Heat up to the start of the peak hour, or with price control in the
                    // cheapest minHeatLen hours within priceWindowHours before it.
                    let start = peak - minHeatLen;
                    if (priceControlEnabled && priceByIndex) {
                        const lookback = Math.max(minHeatLen, Math.floor(priceWindowHours));
                        let bestStart = null;
                        let bestSum = Infinity;
                        for (let s = peak - lookback; s <= peak - minHeatLen; s++) {
                            let sum = 0;
                            let ok = true;
                            for (let k = 0; k < minHeatLen; k++) {
                                const ore = priceByIndex[vvWrap(s + k)];
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
                        if (bestStart !== null) start = bestStart;
                    }
                    const end = start + minHeatLen;

                    for (let h = start; h < end; h++) {
                        const idx = vvWrap(h);
                        modePlan[idx] = dayMode;
                        if (dayMode === 1 && Number.isFinite(ecoStop)) {
                            tempPlan[idx] = ecoStop;
                        } else if (dayMode === 2 && Number.isFinite(normalStop)) {
                            tempPlan[idx] = normalStop;
                        } else if (dayMode === 3 && Number.isFinite(luxStop)) {
                            tempPlan[idx] = luxStop;
                        }
                    }

                    // The cheapest two consecutive hours of the window, ending before the peak.
                    let cheapStart = null;
                    if (priceByIndex) {
                        const from = Math.max(start, peak - Math.max(2, Math.floor(priceWindowHours)));
                        let bestSum = Infinity;
                        for (let s = from; s + 1 < end; s++) {
                            const p1 = priceByIndex[vvWrap(s)];
                            const p2 = priceByIndex[vvWrap(s + 1)];
                            if (p1 === null || p2 === null || !Number.isFinite(p1) || !Number.isFinite(p2)) continue;
                            if (p1 + p2 < bestSum || (p1 + p2 === bestSum && s > cheapStart)) {
                                bestSum = p1 + p2;
                                cheapStart = s;
                            }
                        }
                    }
                    heatBlocks.push({
                        start: vvWrap(start),
                        len: minHeatLen,
                        peak: vvWrap(peak),
                        cheapStart: cheapStart === null ? null : vvWrap(cheapStart),
                    });
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
            store.meta.vvHeatBlocks = heatBlocks;
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

// VV-pris (grön): the hours the control tick may heat in by plan (vvAiPlanHeatAllowed).
const vvPriceHeatMask = (priceGraphActive && !scheduleGraphActive && store && store.meta)
    ? vvAiHeatMask(store.meta.vvHeatBlocks)
    : new Array(168).fill(false);

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
                    // Standard: visa AI-planen (tempPlan och modePlan). Only inside the windows:
                    // with the min-temp floor on, tempPlan holds the floor in every other hour,
                    // which would draw as a plan to heat around the clock.
                    tempSeries.push({ x, y: m > 0 ? Number(t.toFixed(1)) : 0 });
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
					getNibeData(ctx.hP['hw_stop_0']).catch(() => undefined),
					getNibeData(ctx.hP['hw_stop_1']).catch(() => undefined),
					getNibeData(ctx.hP['hw_stop_2']).catch(() => undefined),
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
            if (ctx.vvAiPriceCache && Array.isArray(ctx.vvAiPriceCache) && ctx.vvAiPriceCache.length > 0) {
                const priceHorizon = vvAiBuildPriceHorizon(ts, ctx.vvAiPriceCache);
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
            if (!Number.isFinite(store.meta.hwClosedUntilTs)) {
                store.meta.hwClosedUntilTs = 0;
            }
            if (typeof store.meta.vvMinActive !== 'boolean') {
                store.meta.vvMinActive = false;
            }
            if (!Number.isFinite(store.meta.vvMinTarget)) {
                store.meta.vvMinTarget = null;
            }

            let bt6;
            try {
                bt6 = await getNibeData(ctx.hP['bt6']).catch(() => undefined);
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
                const prio = await getNibeData(ctx.hP['prio']).catch(() => undefined);
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
                } else if (vvEventPeakTs !== null &&
                    (ts - vvEventPeakTs) >= VV_DRAW_REBASE_MS &&
                    ((vvEventPeak - current) / ((ts - vvEventPeakTs) / 3600000)) < VV_DRAW_REBASE_RATE) {
                    // Mellan tappen följer toppen annars inte med när tanken svalnar,
                    // så nästa tapp mäts mot en inaktuell topp: avsvalningen räknas in
                    // i spannet och späder ut fallhastigheten.
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
                    vvEventHistory = [{ ts: ts, v: current }];
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

                vvEventHistory.push({ ts: ts, v: current });
                while (vvEventHistory.length > 1 && vvEventHistory[1].ts <= ts - VV_DRAW_TRAIL_MS) {
                    vvEventHistory.shift();
                }
                let drawOver = false;
                const oldest = vvEventHistory[0];
                if ((ts - (vvEventStartTs || ts)) >= VV_DRAW_TRAIL_MS && oldest &&
                    oldest.ts <= ts - VV_DRAW_TRAIL_MS) {
                    const trailRate = (oldest.v - current) / ((ts - oldest.ts) / 3600000);
                    drawOver = trailRate < VV_DRAW_REBASE_RATE;
                }

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
                    vvEventHistory = [{ ts: ts, v: current }];
                } else if (recovered || sinceNewLow >= VV_DRAW_IDLE_CLOSE_MS || tooLong || drawOver) {
                    const idleMin = Math.round(VV_DRAW_IDLE_CLOSE_MS / 60000);
                    const maxMin = Math.round(VV_DRAW_MAX_MS / 60000);
                    const why = recovered
                        ? 'återhämtning'
                        : (sinceNewLow >= VV_DRAW_IDLE_CLOSE_MS
                            ? `ingen ny botten på ${idleMin} min`
                            : (drawOver
                                ? 'tappet är över'
                                : `tidsgräns ${maxMin} min`));
                    vvCloseDrawEvent(hw, minDrop, current, ts, why);
                }
                vvLastBt6 = current;
            }

            await vvAiBuildPlan(store, hw);

            let bt7;
            try {
                bt7 = await getNibeData(ctx.hP['bt7']).catch(() => undefined);
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
                const hwPeriodKey = ctx.hP && ctx.hP['hw_period'];
                const startHWKey = ctx.hP && ctx.hP['startHW'];

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
                    const hwRegOn = (hwConf.enable_hw_priority === true) || (hwConf.enable_autoluxury === true);


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
                    // Elprisreglering (vv_ai_use_price_enable): plan heating (prio 3) only in the
                    // hours vvAiBuildPlan picked for its window. Min-temp (prio 1) och tidsstyrning
                    // (prio 2) påverkas inte.
                    let vvAiCheapHeatAllowedThisHour = true;
                    if (priceControlEnabled && !manualScheduleEnabled) {
                        vvAiCheapHeatAllowedThisHour = vvAiPlanHeatAllowed(store && store.meta && store.meta.vvHeatBlocks, hourIndex);
                    }

                    // 3) VV-AI-veckoplan: once BT7 reaches the target, the rest of the window is
                    //    closed, also across midnight; a later window (a second peak) still heats.
                    if (!wantHeat && aiOk && Number.isFinite(bt7Now) && planMode > 0 && planTemp !== null && (!priceControlEnabled || vvAiCheapHeatAllowedThisHour)) {
                        const closedUntilTs = (store && store.meta && Number.isFinite(store.meta.hwClosedUntilTs))
                            ? store.meta.hwClosedUntilTs
                            : 0;
                        if (ts >= closedUntilTs) {
                            targetTemp = planTemp;
                            wantHeat = (bt7Now < targetTemp);
                            if (!wantHeat) {
                                // modePlan, not tempPlan: with the min-temp floor on, tempPlan
                                // is non-zero in every hour, and the window would never end.
                                let rest = 0;
                                while (rest < 23 && Array.isArray(store.modePlan) &&
                                       Number(store.modePlan[vvWrap(hourIndex + rest + 1)]) > 0) {
                                    rest++;
                                }
                                const hourStart = new Date(ts);
                                hourStart.setMinutes(0, 0, 0);
                                store.meta.hwClosedUntilTs = hourStart.getTime() + (rest + 1) * 3600000;
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

    return { vvAiTick };
};
