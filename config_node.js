module.exports = function(RED) {
    const EventEmitter = require('events').EventEmitter;
    require('events').EventEmitter.defaultMaxListeners = 850;
    const nibeData = new EventEmitter()
    const nibe = require('nibepi')
    var serialPort = "";
    var tcp_host = "";
    var tcp_port = "";
    // State that several parts replace while running: always read it through ctx,
    // never keep a copy. hP is the register map, chosen when the core connects.
    const ctx = {
        text: require('./language-SE.json'),
        hP: undefined,
        savedGraph: {},
        vvAiPriceCache: null, // VV-AI: prislista i RAM (ingen SD-skrivning)
    };
    let translate = require('./translate.json')
    var series = "";





























    const initiateCore = (host,port,cb) => {
        nibe.initiateCore(host,port, (err,data) => {
            if(err) console.log(err);
            nibe.core = data;
            cb(null,true);
        });
    }
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

///////##########################################################
// ##################################################################
// # START: Algoritm från energy.anerdins-iot.se (ORIGINAL-LOGIK)   #
// ##################################################################







// ##################################################################
// # SLUT: Algoritm                                                 #
// ##################################################################












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
    ctx.text = require(`./language-${config.system.language}.json`)
    node.context().global.set(`translate`, translate);
}
    console.log(ctx.text.starting)

    // Features in lib/, created in dependency order. They share through ctx.
    Object.assign(ctx, { nibe });
    const { optimizeElectricityTrading, priceLevelsFromTrades } = Object.assign(ctx, require('./lib/price-trading')(ctx));
    Object.assign(ctx, { nibe, nibeData });
    const { curveAdjust, getNibeData, getSavedData, getSavedGraph, getSystems, gethP, indoorOffset, minuteUpdate, priceOffset, reportPluginError, runSafely, saveDataGraph, savedData, sendError, systems, tenMinuteUpdate, timer, weatherOffset } = Object.assign(ctx, require('./lib/shared')(ctx));
    Object.assign(ctx, { getNibeData, nibe, nibeData });
    const { vvAiTick } = Object.assign(ctx, require('./lib/vvai')(ctx));
    Object.assign(ctx, { curveAdjust, getNibeData, nibe, nibeData, optimizeElectricityTrading, priceLevelsFromTrades, priceOffset, reportPluginError, sendError });
    const { getCloudData, runPrice } = Object.assign(ctx, require('./lib/price')(ctx));
    Object.assign(ctx, { curveAdjust, getNibeData, nibe, nibeData, saveDataGraph, savedData, weatherOffset });
    const { runWeather, suncalc } = Object.assign(ctx, require('./lib/weather')(ctx));
    Object.assign(ctx, { curveAdjust, indoorOffset, nibe, nibeData, saveDataGraph, sendError });
    const { runIndoor } = Object.assign(ctx, require('./lib/indoor')(ctx));
    Object.assign(ctx, { getNibeData, nibe, nibeData, saveDataGraph });
    const { hotwaterPlugin } = Object.assign(ctx, require('./lib/hotwater')(ctx));
    Object.assign(ctx, { getNibeData, nibe, nibeData, saveDataGraph });
    const { runFan } = Object.assign(ctx, require('./lib/fan')(ctx));
    Object.assign(ctx, { getNibeData, nibe, saveDataGraph, timer });
    const { runDiagnostic } = Object.assign(ctx, require('./lib/diagnostic')(ctx));
    Object.assign(ctx, { nibe, nibeData, sendError });
    const { runRMU } = Object.assign(ctx, require('./lib/rmu')(ctx));
    Object.assign(ctx, { getNibeData, indoorOffset, nibe, nibeData, priceOffset, reportPluginError, runIndoor, runPrice, runRMU, runSafely, runWeather, sendError, systems, weatherOffset });
    const { initiatePlugin, pluginRetryTimers, updateData } = Object.assign(ctx, require('./lib/plugins')(ctx));
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
            })
        }

        const handleCore = (config,force=false) => {
            if(config.connection===undefined) config.connection = {};
            if(config.serial===undefined) config.serial = {};
            if(config.tcp===undefined) config.tcp = {};
            console.log(`Heatpump Series: ${config.connection.series}`);
            if(config.connection.series=="fSeries") {
                ctx.hP = require('./dataregister.json').fSeries;
            } else if(config.connection.series=="sSeries") {
                ctx.hP = require('./dataregister.json').sSeries;
            } else {
                ctx.hP;
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
                                        ctx.hP.supply_s1 = "40047";
                                        console.log('Register 40047 found, using it for supply temp S1')
                                    }
                                }
                                if(hasRegister('40071')) {
                                    var c2 = await getNibeData('40071').catch(console.log)
                                    if(c2!==undefined && c2.data > 0)  {
                                        ctx.hP.supply_s1 = "40071";
                                        console.log('Register 40071 found, using it for supply temp S1')
                                    }
                                }

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
            ctx.savedGraph = result;
        },(err => {

        }));

        RED.httpAdmin.post("/config/:id", RED.auth.needsPermission("nibe-config.write"), function(req, res) {
            nibe.setConfig(req.body.config);
            handleCore(req.body.config);
            nibeData.emit(req.params.id,req.body.data);
        });
        RED.httpAdmin.get('/config', function(req, res) {
            res.json(nibe.getConfig());
        });
        async function saveGraph() {
            const promise = new Promise((resolve,reject) => {
                let config = nibe.getConfig();

                    trimGraph().then(data => {
                        if(config.system.save_graph!==undefined && config.system.save_graph===true) {
                            if(ctx.savedGraph!==undefined && ctx.savedGraph.length!==0) {
                                nibe.saveGraph(ctx.savedGraph).then(result => {
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
                for (var object in ctx.savedGraph) {
                    if (ctx.savedGraph.hasOwnProperty(object)) {
                        if(ctx.savedGraph[object]!==undefined && ctx.savedGraph[object].length>5000) {
                            let len = ctx.savedGraph[object].length-5000;
                            ctx.savedGraph[object].splice(0,len)
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
        this.text = ctx.text;
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
            for (const t of pluginRetryTimers) clearTimeout(t);
            pluginRetryTimers.clear();
        });
    }

    RED.nodes.registerType("nibe-config",nibeConfig);

}
