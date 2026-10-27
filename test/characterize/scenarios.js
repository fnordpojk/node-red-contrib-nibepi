'use strict';
// Scenarios for the characterization harness. Each is a configuration, the plugin
// nodes a flow would have, a simulated pump (register values over time) and
// simulated price and weather services. Everything is deterministic: the same
// scenario always produces the same trace from the same code.

const path = require('path');
const REG = require(path.join(__dirname, '../../dataregister.json')).fSeries;
const ADDR_NAMES = {};
for (const [name, addr] of Object.entries(REG)) (ADDR_NAMES[addr] = ADDR_NAMES[addr] || []).push(name);

const HOUR = 3600000;
const localDate = (s) => new Date(s).getTime();          // TZ is set to Europe/Stockholm by run.js
const hourOf = (t) => { const d = new Date(t); return d.getHours() + d.getMinutes() / 60; };
const wave = (t, phase = 0) => Math.sin(((hourOf(t) - phase) / 24) * 2 * Math.PI);
const round1 = (v) => Math.round(v * 10) / 10;

// ---------- prices ----------
// Spot price in SEK/kWh for a local date and quarter (0..95): a daily wave with
// morning and evening peaks, a little different each day.
function spot(dateStr, q) {
    const h = q / 4;
    const day = Number(dateStr.slice(8, 10));
    let p = 0.55 + 0.25 * Math.sin(((h - 9) / 24) * 2 * Math.PI) + 0.02 * (day % 3);
    if (h >= 7 && h < 9) p += 0.7;
    if (h >= 17 && h < 20) p += 1.1;
    if (h >= 1 && h < 4) p -= 0.3;
    return Math.round((p + 0.01 * (q % 4)) * 10000) / 10000;
}
function isoLocal(t) {                                   // 2026-10-12T00:00:00+02:00
    const d = new Date(t);
    const off = -d.getTimezoneOffset();
    const pad = (n) => String(Math.abs(n)).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00` +
        `${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}
function quarters(dateStr) {                             // local quarter-hour start times of a date
    const out = [];
    const start = localDate(dateStr + 'T00:00:00');
    for (let t = start; new Date(t).getDate() === new Date(start).getDate(); t += 15 * 60000) out.push(t);
    return out;
}
const dateOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const addDays = (dateStr, n) => dateOf(localDate(dateStr + 'T12:00:00') + n * 24 * HOUR);

function tibber(now) {
    const today = dateOf(now), tomorrow = addDays(today, 1);
    const list = (d) => quarters(d).map((t, q) => ({ startsAt: isoLocal(t), total: Math.round(spot(d, q) * 1.25 * 10000) / 10000 }));
    const afterOne = new Date(now).getHours() >= 13;
    return { data: { viewer: { homes: [{ currentSubscription: { priceInfo: { today: list(today), tomorrow: afterOne ? list(tomorrow) : [] } } }] } } };
}
function elpris(p, now) {                                // /api/v1/prices/2026/10-12_SE3.json
    const m = p.match(/\/(\d{4})\/(\d{2})-(\d{2})_/);
    if (!m) return null;
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    if (d > dateOf(now) && new Date(now).getHours() < 13) return { status: 404, body: 'not published yet' };
    return { status: 200, body: quarters(d).map((t, q) => ({ SEK_per_kWh: spot(d, q), EUR_per_kWh: Math.round(spot(d, q) / 11 * 10000) / 10000,
        EXR: 11, time_start: isoLocal(t), time_end: isoLocal(t + 15 * 60000) })) };
}
function smhi(now) {                                     // snow1g point forecast, hourly from this hour
    const start = Math.floor(now / HOUR) * HOUR;
    const series = [];
    for (let i = 0; i < 49; i++) {
        const t = start + i * HOUR;
        series.push({ time: new Date(t).toISOString().replace('.000Z', 'Z'), data: {
            air_temperature: round1(4 + 5 * wave(t, 9) - i * 0.05), wind_speed: round1(3 + 2 * wave(t, 15)),
            wind_from_direction: (200 + i * 7) % 360, wind_speed_of_gust: round1(6 + 3 * wave(t, 15)), symbol_code: (i % 6) + 1 } });
    }
    return { approvedTime: new Date(start).toISOString(), referenceTime: new Date(start).toISOString(), timeSeries: series };
}
function http(host, p, body, now) {
    if (host === 'api.tibber.com') return { status: 200, body: tibber(now) };
    if (host === 'www.elprisetjustnu.se') return elpris(p, now);
    if (host === 'opendata-download-metfcst.smhi.se') return { status: 200, body: smhi(now) };
    return null;
}

// ---------- the pump ----------
// A hot water tank: cools slowly, loses heat to draws, warms while charging. Charging
// starts when NibePi writes startHW=4 or the tank top falls below the pump's own
// start temperature, and stops at the stop temperature for the current mode.
function makeTank(draws, startT) {
    const s = { t: startT, bt7: 48, bt6: 44, charging: false };
    return (now, written) => {
        while (s.t + 60000 <= now) {
            s.t += 60000;
            const h = hourOf(s.t);
            const lux = written(REG.startHW) === 4;
            const stopTemp = lux ? 53 : 50;
            if (!s.charging && (lux || s.bt7 < 42)) s.charging = true;
            if (s.charging && s.bt7 >= stopTemp) s.charging = false;
            if (s.charging) { s.bt7 += 0.2; s.bt6 = Math.min(s.bt7 - 2, s.bt6 + 0.4); }
            else { s.bt7 -= 0.4 / 60; s.bt6 -= 0.5 / 60; }
            for (const d of draws) if (h >= d.at && h < d.at + d.minutes / 60) { s.bt6 -= d.bt6 / d.minutes; s.bt7 -= d.bt7 / d.minutes; }
        }
        return { bt6: round1(s.bt6), bt7: round1(s.bt7), prio: s.charging ? 20 : 30 };
    };
}

function pump({ model = 'F1245', draws = [], start, timeouts = {}, overrides = {} } = {}) {
    const tank = makeTank(draws, start);
    const values = Object.assign({
        outside: (t) => round1(3 + 4 * wave(t, 9)),
        inside: (t) => round1(21.2 + 0.4 * wave(t, 15)),
        inside_set_s1: 21.5, inside_enable_s1: 0, inside_factor_s1: 2,
        dM: (t) => Math.round(-180 + 120 * wave(t, 3)), dMstart: -60, dMadd: -400, dMaddstart: -700,
        supply_s1: (t) => round1(34 + 4 * wave(t, 21)), supply_s2: -3276.8, setpoint_s1: 34,
        heatcurve: 5, curveadjust: 0, exhaust: 22, vented: 5, evaporator: -6,
        hw_mode: 1, hw_period: 30, startHW: 0,
        hw_start_0: 42, hw_start_1: 45, hw_start_2: 47, hw_stop_0: 48, hw_stop_1: 50, hw_stop_2: 53,
        price_current: 0, price_level: 0, price_enable: 0, alarm: 0,
        cpr_act: (t) => Math.round(45 + 20 * wave(t, 6)), cpr_set: 60, fan_speed: 60, bs1_flow: 150, fan_mode: 0,
        defrost_time: 0, prio_add_enable: 0, cpr_tot_kwh: 12000, cpr_hw_kwh: 3000,
    }, overrides);
    return {
        model,
        read(addr, now, written) {
            const names = ADDR_NAMES[addr] || [];
            for (const n of names) if (timeouts[n] && timeouts[n](now)) return 'timeout';
            if (names.some(n => n === 'bt6' || n === 'bt7' || n === 'prio')) {
                const s = tank(now, written);
                return s[names.find(n => n === 'bt6' || n === 'bt7' || n === 'prio')];
            }
            for (const n of names) if (n in values) return typeof values[n] === 'function' ? values[n](now) : values[n];
            return 0;
        },
    };
}

// ---------- configurations ----------
function baseConfig(pumpModel) {
    return {
        connection: { series: 'fSeries', enable: 'nibegw' }, serial: { port: '192.168.1.50' }, tcp: {},
        mqtt: { enable: false }, registers: [],
        log: { enable: true, info: true, error: true, debug: true, price: true, hotwater: true, fan: true, weather: true },
        system: { pump: pumpModel, firmware: 9721, language: 'SE', save_graph: false, auto_update: true },
        home: { lat: '59.33', lon: '18.06', hours_s1: 6, inside_sensors: [], sensor_timeout: 0 },
        indoor: { enable_s1: false }, weather: { enable_s1: false }, price: { enable: false },
        hotwater: { enable_autoluxury: false, enable_hw_priority: false, diff: 20, time: 30 }, fan: { enable: false }, rmu: {},
        data: { graph: [] },
    };
}
const priceSettings = (source) => ({
    enable: true, source, token: 'test-token', tibber_home: 0, area: 'SE3', time: 8, time_hw: 12, min_spread: 20,
    enable_heat_s1: true, heat_very_cheap_s1: 3, heat_cheap_s1: 1, heat_normal_s1: 0, heat_expensive_s1: -1, heat_very_expensive_s1: -3,
    hotwater_enable: true, hotwater_very_cheap: 3, hotwater_cheap: 1, hotwater_normal: 0, hotwater_expensive: -2, hotwater_very_expensive: -4,
    enable_temp_s1: true, temp_low_s1: 1, sensor_s1: 'Ingen',
    enable_freq: true, block_add: true, enable_dM_reset: true, min_freq: 21, max_freq: 35, min_temp: -20, max_temp: 0,
    apply_vat: true, vat: 0.25, addition_ore: 88.01, hw_speed: 20,
});
const nodesFor = (...types) => types.map((type, i) => Object.assign({ id: type + '-' + i, type, system: 's1' },
    type === 'nibe-graph' ? { select: 'start_1' } : {}));

const START = localDate('2026-10-12T05:58:00');        // a Monday morning
const DRAWS = [{ at: 7.1, minutes: 8, bt6: 14, bt7: 3 }, { at: 19.5, minutes: 12, bt6: 18, bt7: 5 }, { at: 21, minutes: 30, bt6: 9, bt7: 2 }];

function scenario(name, { minutes, model = 'F1245', configure, nodes, draws = DRAWS, timeouts, overrides, vvAiStore, start = START }) {
    const config = baseConfig(model);
    configure(config);
    return Object.assign({ name, start, minutes, config, nodes, http, vvAiStore }, pump({ model, draws, start, timeouts, overrides }));
}

// A learned profile with morning and evening peaks every day.
function profileStore() {
    const profile = new Array(168).fill(0.05);
    for (let d = 0; d < 7; d++) { profile[d * 24 + 7] = 3.5; profile[d * 24 + 19] = 2.5; profile[d * 24 + 20] = 4.2; profile[d * 24 + 21] = 1.4; }
    return { profile, tempPlan: new Array(168).fill(0), modePlan: new Array(168).fill(0), meta: {} };
}

module.exports = [
    scenario('price-tibber', { minutes: 480, nodes: nodesFor('nibe-price', 'nibe-graph'),
        configure: (c) => { c.price = priceSettings('tibber'); } }),
    scenario('price-tibber-own', { minutes: 480, nodes: nodesFor('nibe-price'),
        configure: (c) => { c.price = Object.assign(priceSettings('tibber'), { enable_own_setting: true, verycheap: 70, veryexpensive: 150 }); } }),
    scenario('price-elprisetjustnu', { minutes: 480, nodes: nodesFor('nibe-price'),
        configure: (c) => { c.price = priceSettings('priceai'); } }),
    // F1255: frequency limiting and pool control exist here (not on the F1245). No lowest
    // indoor temperature, so expensive levels lower the heat.
    scenario('price-f1255-freq-pool', { minutes: 480, model: 'F1255', nodes: nodesFor('nibe-price'),
        overrides: { pool_temp_s1: (t) => round1(29 + 2 * wave(t, 12)), pool_start_temp_s1: 28, pool_stop_temp_s1: 32, pool_cpr_s1: 1,
                     lock_freq_1_activate: 0, lock_freq_2_activate: 0, lock_freq_1_min: 20, lock_freq_1_max: 50, lock_freq_2_min: 20, lock_freq_2_max: 50 },
        configure: (c) => {
            c.price = Object.assign(priceSettings('tibber'), { enable_temp_s1: false, pool_enable_s1: true, pool_max_temp: 31,
                VERY_CHEAP_POOL_HEAT: 3, CHEAP_POOL_HEAT: 1, NORMAL_POOL_HEAT: 0, NORMAL_START_POOL_HEAT: 28, NORMAL_STOP_POOL_HEAT: 32,
                EXPENSIVE_POOL_HEAT: -1, VERY_EXPENSIVE_POOL_HEAT: -3, VERY_CHEAP_POOL_CPR: 1, CHEAP_POOL_CPR: 1, NORMAL_START_POOL_CPR: 1,
                NORMAL_STOP_POOL_CPR: 1, EXPENSIVE_POOL_CPR: 0, VERY_EXPENSIVE_POOL_CPR: 0 });
        } }),
    // The pump's own price level (Smart price adaption) as the source.
    scenario('price-nibe', { minutes: 480, nodes: nodesFor('nibe-price'),
        overrides: { price_enable: 1, price_level: (t) => [1, 1, 2, 2, 3, 3, 2, 1][Math.floor(hourOf(t) / 3) % 8],
                     price_current: (t) => Math.round(80 + 60 * wave(t, 12)) },
        configure: (c) => { c.price = Object.assign(priceSettings('nibe'), { enable_temp_s1: false }); } }),
    scenario('indoor-weather', { minutes: 300, nodes: nodesFor('nibe-indoor', 'nibe-weather', 'nibe-graph'),
        configure: (c) => {
            c.indoor = { enable_s1: true, sensor_s1: 'Ingen', dm_reset_enable: true, dm_reset_value: -200, dm_reset_enable_stop: true,
                         dm_reset_stop_diff: 0.7, dm_reset_slow_diff: 0.3 };
            c.weather = { enable_s1: true, sensor_s1: 'Ingen', enable_up: true, enable_down: true, sun_enable: true, wind_enable: true,
                          forecast_adjust: true, clear: 2, half_clear: 1, mostly_clear: 0.5,
                          wind_factor_n: 1, wind_factor_e: 0.5, wind_factor_s: 0.3, wind_factor_w: 0.8 };
        } }),
    scenario('hotwater-classic', { minutes: 900, nodes: nodesFor('nibe-hotwater'),
        configure: (c) => { Object.assign(c.hotwater, { enable_autoluxury: true, enable_hw_priority: true, diff: 15, time: 30 }); } }),
    scenario('vvai-day', { minutes: 1500, nodes: nodesFor('nibe-hotwater-ai', 'nibe-price'), vvAiStore: profileStore(),
        configure: (c) => {
            c.price = priceSettings('tibber');
            Object.assign(c.hotwater, { enable_vv_learning: true, enable_vv_ai_control: true, vv_ai_use_price_enable: true,
                vv_ai_min_temp_enable: true, vv_ai_min_temp: 40, vv_ai_price_window_enable: true, vv_ai_price_window_hours: 8,
                vv_ai_preheat_enable: true, vv_ai_preheat_hours: 2 });
        } }),
    // Evaporator swings above and below freezing, degree minutes dip below the boost
    // start, the compressor runs slow at night: so low flow, boost and normal all occur.
    scenario('fan-f750', { minutes: 600, model: 'F750', nodes: nodesFor('nibe-fan'),
        overrides: { evaporator: (t) => round1(-2 + 8 * wave(t, 8)), dM: (t) => Math.round(-250 + 150 * wave(t, 2)),
                     cpr_act: (t) => Math.round(42 + 18 * wave(t, 8)), cpr_set: (t) => Math.round(42 + 18 * wave(t, 8)),
                     exhaust: (t) => round1(21 + 1.5 * wave(t, 16)) },
        configure: (c) => { c.fan = { enable: true, speed_normal: 60, speed_low: 40, low_cpr_freq: 40, enable_low: true,
            enable_dm_boost: true, dm_boost_start: -300, dm_boost_value: 80, enable_filter: true, filter_value_normal: 70,
            filter_value_low: 50, enable_co2: false }; } }),
    scenario('timeouts', { minutes: 240, nodes: nodesFor('nibe-indoor', 'nibe-price', 'nibe-weather'),
        timeouts: { inside_set_s1: (t) => hourOf(t) >= 6.5 && hourOf(t) < 7, outside: (t) => hourOf(t) >= 8 && hourOf(t) < 8.25,
                    supply_s1: (t) => t < START + 3 * 60000 },
        configure: (c) => {
            c.indoor = { enable_s1: true, sensor_s1: 'Ingen' };
            c.weather = { enable_s1: true, sensor_s1: 'Ingen', enable_up: true, enable_down: true };
            c.price = priceSettings('tibber');
        } }),
];
