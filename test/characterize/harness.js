'use strict';
// Characterization harness: loads the package's Node-RED nodes with a fake Node-RED,
// a fake nibepi core, fake cron, fake HTTPS and a mocked clock, drives them through
// a scenario minute by minute, and records everything they do to the outside world:
// pump reads and writes, log lines, events between the nodes, messages to the
// dashboard and HTTP requests. Recorded traces from known-good code are compared
// with traces from changed code, so a refactor that changes behavior is caught.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const EventEmitter = require('events');
const https = require('https');
const { mock } = require('node:test');

const PKG = path.resolve(__dirname, '../..');
const NODE_FILES = ['config_node.js', 'config_req.js', 'output.js', 'input.js', 'request.js', 'weather.js', 'indoor.js',
    'price.js', 'hotwater.js', 'rmu.js', 'fan.js', 'graph.js', 'hotwater_ai.js'];
const LARGE = 600;   // payloads longer than this are recorded as a hash

// ---------- stable serialization ----------
function stable(value) {
    const seen = new WeakSet();
    const walk = (v) => {
        if (v === undefined) return null;
        if (typeof v === 'function') return '[fn]';
        if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
        if (v === null || typeof v !== 'object') return v;
        if (v instanceof Date) return v.toISOString();
        if (v instanceof Error) return `${v.name}: ${v.message}`;
        if (Buffer.isBuffer(v)) return 'buf:' + v.toString('hex');
        if (seen.has(v)) return '[circular]';
        seen.add(v);
        if (v instanceof EventEmitter && v._fakeNode) return `[node ${v.type} ${v.id}]`;
        if (Array.isArray(v)) return v.map(walk);
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
        return out;
    };
    return JSON.stringify(walk(value));
}
function compact(value) {
    const s = typeof value === 'string' ? value : stable(value);
    if (s.length <= LARGE) return s;
    return `sha1:${crypto.createHash('sha1').update(s).digest('hex').slice(0, 16)}:${s.length}`;
}

// ---------- trace ----------
class Trace {
    constructor(clock) { this.clock = clock; this.events = []; }
    add(kind, ...args) {
        const t = new Date(Date.now()).toISOString().slice(0, 19);
        this.events.push([t, kind, ...args.map(compact)].join(' | '));
    }
}

// ---------- fake nibepi core ----------
function makeCore(sc, trace, model) {
    const data = new EventEmitter();
    data.setMaxListeners(0);
    let config = JSON.parse(JSON.stringify(sc.config));
    const overlay = new Map();                 // values written with setData
    const meta = new Map(model.map(r => [String(r.register), r]));
    // Scenarios see what was written, so e.g. a started hot-water charge can warm the tank.
    const read = (addr) => {
        if (overlay.has(addr)) return overlay.get(addr);
        return sc.read(addr, Date.now(), (a) => overlay.get(String(a)));
    };
    const api = {
        data,
        core: undefined,
        getConfig: () => config,
        setConfig: (c) => { config = c; trace.add('core.setConfig', c); data.emit('config', config); },
        log: (msg, plugin, level) => trace.add('core.log', plugin, level, String(msg)),
        reqData: (address) => {
            const addr = String(address);
            trace.add('core.reqData', addr);
            if (!api.core || api.core.connected !== true) return Promise.reject(new Error('Core is not started.'));
            if (!meta.has(addr)) return Promise.reject(new Error('Register (' + addr + ') not in database'));
            const v = read(addr);
            if (v === 'timeout') return Promise.reject(new Error('No respond from register (' + addr + ')'));
            // As the core does: the model's register object, with raw_data the scaled value
            // and data the same value, or its text when the model maps it (e.g. 41929's
            // price levels 1/2/3 -> CHEAP/NORMAL/EXPENSIVE).
            const m = meta.get(addr);
            const mapped = Array.isArray(m.map) ? m.map.find(e => Number(Object.keys(e)[0]) == v) : undefined;
            const d = Object.assign({}, m, { register: addr, data: mapped ? Object.values(mapped)[0] : v,
                        raw_data: v, timestamp: Date.now() });
            data.emit('data', d);
            return Promise.resolve(d);
        },
        setData: (address, value, cb = () => {}) => {
            const addr = String(address);
            trace.add('core.setData', addr, value);
            overlay.set(addr, Number(value));
            setImmediate(() => cb(null, true));
        },
        getRegister: () => model,
        redOn: () => trace.add('core.redOn'),
        addRegister: (a) => trace.add('core.addRegister', String(a)),
        removeRegister: (a) => trace.add('core.removeRegister', String(a)),
        addSensor: (s) => trace.add('core.addSensor', s),
        removeSensor: (s) => trace.add('core.removeSensor', s),
        refreshConfig: () => trace.add('core.refreshConfig'),
        initiateCore: (host, port, cb) => {
            trace.add('core.initiateCore', host, port);
            const core = { connected: true };
            api.core = core;
            setImmediate(() => cb(null, core));
        },
        stopCore: () => Promise.resolve(true),
        resetCore: () => trace.add('core.resetCore'),
        handleMQTT: (en, host, port, user, pass, cb) => { if (cb) cb(null, false); },
        getMQTTData: () => Promise.reject({}),
        saveGraph: () => Promise.resolve('saved'),
        requireGraph: () => Promise.reject('No graphs to load.'),
    };
    return api;
}

// ---------- fake cron ----------
function makeCron(tasks) {
    return {
        schedule: (expr, fn) => {
            const task = { expr, fn, stopped: false, stop() { this.stopped = true; }, start() { this.stopped = false; } };
            tasks.push(task);
            return task;
        },
        validate: () => true,
    };
}
function cronDue(expr, d) {
    const [min, hour] = expr.trim().split(/\s+/);
    const match = (field, v) => field === '*' ||
        (field.startsWith('*/') ? v % Number(field.slice(2)) === 0 : field.split(',').map(Number).includes(v));
    return match(min, d.getMinutes()) && match(hour, d.getHours());
}

// ---------- fake https ----------
function installHttps(sc, trace) {
    const orig = { request: https.request, get: https.get };
    const respond = (opts, body, cb) => {
        const host = typeof opts === 'string' ? new URL(opts).hostname : opts.hostname;
        const p = typeof opts === 'string' ? new URL(opts).pathname + new URL(opts).search : opts.path;
        trace.add('https', host, p, body || '');
        const r = sc.http(host, p, body, Date.now()) || { status: 404, body: 'not found' };
        const res = new EventEmitter();
        res.statusCode = r.status;
        setImmediate(() => {
            if (cb) cb(res);
            setImmediate(() => { res.emit('data', typeof r.body === 'string' ? r.body : JSON.stringify(r.body)); res.emit('end'); });
        });
    };
    https.request = (opts, cb) => {
        const req = new EventEmitter();
        let body = '';
        req.write = (chunk) => { body += chunk; };
        req.end = (chunk) => { if (chunk) body += chunk; respond(opts, body, cb); };
        req.setTimeout = () => req;
        req.destroy = () => {};
        return req;
    };
    https.get = (opts, cb) => {
        const req = new EventEmitter();
        req.setTimeout = () => req;
        req.destroy = () => {};
        respond(opts, '', cb);
        return req;
    };
    return () => { https.request = orig.request; https.get = orig.get; };
}

// ---------- fake Node-RED ----------
function makeRED(trace) {
    const types = {};
    const nodes = {};
    const globalCtx = new Map();
    function FakeNode(cfg) {
        EventEmitter.call(this);
        this.setMaxListeners(0);
        this._fakeNode = true;
        this.id = cfg.id;
        this.type = cfg.type;
        this.name = cfg.name;
        const local = new Map();
        this.context = () => ({
            get: (k) => local.get(k), set: (k, v) => { local.set(k, v); },
            global: { get: (k) => globalCtx.get(k), set: (k, v) => { globalCtx.set(k, v); } },
            flow: { get: (k) => local.get('flow:' + k), set: (k, v) => { local.set('flow:' + k, v); } },
        });
    }
    Object.setPrototypeOf(FakeNode.prototype, EventEmitter.prototype);
    FakeNode.prototype.send = function (msg) { trace.add('send', this.type + ':' + this.id, msg); };
    FakeNode.prototype.status = function (s) { trace.add('status', this.type + ':' + this.id, s); };
    FakeNode.prototype.warn = function (m) { trace.add('warn', this.type + ':' + this.id, String(m)); };
    FakeNode.prototype.error = function (m) { trace.add('error', this.type + ':' + this.id, String(m)); };
    FakeNode.prototype.log = function (m) { trace.add('nodelog', this.type + ':' + this.id, String(m)); };
    const RED = {
        nodes: {
            createNode(node, cfg) { FakeNode.call(node, cfg); },
            registerType(name, ctor) { types[name] = ctor; Object.setPrototypeOf(ctor.prototype, FakeNode.prototype); },
            getNode(id) { return nodes[id]; },
        },
        httpAdmin: { get() {}, post() {} },
        auth: { needsPermission: () => (req, res, next) => next && next() },
        settings: {},
        log: { info() {}, warn() {}, error() {}, debug() {} },
        util: { cloneMessage: (m) => JSON.parse(JSON.stringify(m)) },
    };
    const create = (type, cfg) => {
        const node = new types[type](Object.assign({ type }, cfg));
        nodes[cfg.id] = node;
        return node;
    };
    return { RED, create, nodes };
}

// ---------- module loading ----------
// Active for the whole run: node-cron is required inside the config node's constructor.
function installStubs(stubs) {
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
        return origLoad.apply(this, arguments);
    };
    return () => { Module._load = origLoad; };
}
function clearPackageCache() {
    for (const k of Object.keys(require.cache)) if (k.startsWith(PKG + path.sep) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
}

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// ---------- one scenario ----------
async function run(sc) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nibepi-char-'));
    fs.writeFileSync(path.join(dir, 'vv_ai_profile.json'), JSON.stringify(sc.vvAiStore || {
        profile: new Array(168).fill(0), tempPlan: new Array(168).fill(0), modePlan: new Array(168).fill(0), meta: {} }));
    process.env.NIBEPI_CONFIG_DIR = dir;
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: sc.start });
    const trace = new Trace();
    const model = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', sc.model + '.json'), 'utf8'));
    const core = makeCore(sc, trace, model);
    const tasks = [];
    const restoreHttps = installHttps(sc, trace);
    const restoreStubs = installStubs({ nibepi: core, 'node-cron': makeCron(tasks),
        suncalc: require(require.resolve('suncalc', { paths: [__dirname] })) });
    const { RED, create, nodes } = makeRED(trace);
    const origConsole = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a) => trace.add('console', a.map(x => typeof x === 'string' ? x : stable(x)).join(' '));
    console.warn = console.log;
    console.error = console.log;
    try {
        clearPackageCache();
        for (const f of NODE_FILES) require(path.join(PKG, f))(RED);
        const server = create('nibe-config', { id: 'cfg' });
        const realEmit = server.nibeData.emit.bind(server.nibeData);
        // Register readings are re-emitted under their address and as 'data': they are the
        // simulated pump's own values, already visible as core.reqData, so they are not recorded.
        server.nibeData.emit = (ev, ...args) => {
            if (ev !== 'data' && !/^\d+$/.test(String(ev))) trace.add('emit', ev, ...args);
            return realEmit(ev, ...args);
        };
        await flush();
        for (const n of sc.nodes) create(n.type, Object.assign({ server: 'cfg' }, n));
        await flush();
        // Run minute by minute: timers in 5-second steps, cron at each minute boundary.
        for (let minute = 0; minute < sc.minutes; minute++) {
            for (let s = 0; s < 12; s++) { mock.timers.tick(5000); await flush(5); }
            const now = new Date(Date.now());
            for (const t of tasks) if (!t.stopped && cronDue(t.expr, now)) { t.fn(); await flush(); }
            if (sc.at) { const step = sc.at[minute + 1]; if (step) { step({ core, nodes, trace }); await flush(); } }
        }
        for (const id of Object.keys(nodes)) nodes[id].emit('close');
        await flush();
    } finally {
        console.log = origConsole.log; console.warn = origConsole.warn; console.error = origConsole.error;
        restoreStubs();
        restoreHttps();
        mock.timers.reset();
        delete process.env.NIBEPI_CONFIG_DIR;
        fs.rmSync(dir, { recursive: true, force: true });
    }
    return trace.events;
}

module.exports = { run, stable };
