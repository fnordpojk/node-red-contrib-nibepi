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
    const getList = [];
    // A plugin registers once, when it starts, and the read that checks its system
    // exists can fail: the pump does not answer every request, and fewer of them
    // when another client shares the gateway. A failed check used to leave the
    // plugin out - silently, until its settings were touched. Keep retrying until
    // the pump answers, or until the plugin registers again and supersedes this.
    // A superseded request settles neither way, so it cannot overwrite the newer
    // registration's outcome.
    const PLUGIN_RETRY_MS = 60000;
    const pluginGeneration = {};
    const pluginRetryTimers = new Set();
    // Plugins whose failed read was logged, so how their registration finally
    // turns out is logged too - also when a newer registration settles it.
    const pluginReadFailed = new Set();
    function logPluginOutcome(plugin,system,outcome) {
        if(pluginReadFailed.delete(plugin+'_'+system)) nibe.log(`Plugin ${plugin} (${system}) ${outcome}`,'error','debug');
    }
    function reqDataForPlugin(register,plugin,system,generation) {
        const key = plugin+'_'+system;
        return new Promise((resolve,reject) => {
            const attempt = () => {
                nibe.reqData(register).then(data => {
                    if(pluginGeneration[key]!==generation) return;
                    resolve(data);
                }).catch(err => {
                    if(pluginGeneration[key]!==generation) return;
                    const message = (err && err.message) ? err.message : String(err);
                    // A register the pump does not have will not appear on retry.
                    if(message.includes('not in database')) return reject(err);
                    if(!pluginReadFailed.has(key)) nibe.log(`Plugin ${plugin} (${system}) could not read register ${register} (${message}), retrying every minute`,'error','debug');
                    pluginReadFailed.add(key);
                    const timer = setTimeout(() => {
                        pluginRetryTimers.delete(timer);
                        if(pluginGeneration[key]===generation) attempt();
                    }, PLUGIN_RETRY_MS);
                    pluginRetryTimers.add(timer);
                });
            };
            attempt();
        });
    }
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
        const generation = (pluginGeneration[plugin+'_'+system] || 0)+1;
        pluginGeneration[plugin+'_'+system] = generation;
        const promise = new Promise((resolve,reject) => {
            clearList(plugin,system).then(result => {
                var newSystem = true;

                for( let i = 0; i < arr.length; i++){
                    if(arr[i].register===undefined) {
                        arr[i].register = ctx.hP[arr[i].topic];
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
                                    }
                                }

                        }
                    }
                }
                let checkReg = ctx.hP['supply_'+system];
                function checkRMU() {
                    if(plugin=="rmu") {
                        reqDataForPlugin(ctx.hP['startHW_rmu_'+system],plugin,system,generation).then(data => {
                            if(data!==undefined) {
                                let regN = getList.findIndex(regN => regN.system == 's1');
                                if(regN!==-1) {
                                for( let i = 0; i < arr.length; i=i+1){
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
                    }
                }
                if(newSystem===true) {
                    let regN = getList.findIndex(regN => regN.system == system);
                    if(regN===-1) {
                        checkRMU();
                        reqDataForPlugin(checkReg,plugin,system,generation).then(data => {
                            if(data.data<-3276) {
                                checkRMU();
                                return reject(false);
                            } else {
                                systems[system] = true;
                                if(plugin=="fan") {
                                    reqDataForPlugin(ctx.hP.bs1_flow,plugin,system,generation).then(data => {
                                        if(data.data<-3276) {
                                            return reject(false);
                                        } else {
                                            let regN = getList.findIndex(regN => regN.system == system);
                                if(regN===-1) {
                                    getList.push({system:system,registers:[]});
                                    for( let i = 0; i < arr.length; i=i+1){
                                        let regI = getList.findIndex(regI => regI.system == system);
                                        let newArr = arr[i];
                                        newArr.plugin = [plugin];
                                        getList[regI].registers.push(newArr);
                                    }
                                } else {
                                    for( let i = 0; i < arr.length; i=i+1){
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
                                    for( let i = 0; i < arr.length; i=i+1){
                                        let regI = getList.findIndex(regI => regI.system == system);
                                        let newArr = arr[i];
                                        newArr.plugin = [plugin];
                                        getList[regI].registers.push(newArr);
                                    }
                                } else {
                                    for( let i = 0; i < arr.length; i=i+1){
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
                        reqDataForPlugin(checkReg,plugin,system,generation).then(data => {
                            if(data.data<-3276) {
                                checkRMU();
                                return reject(false);
                            } else {
                                systems[system] = true;
                                if(plugin=="fan") {
                                    reqDataForPlugin(ctx.hP.bs1_flow,plugin,system,generation).then(data => {
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
                    reqDataForPlugin(checkReg,plugin,system,generation).then(data => {
                        if(data.data<-3276) {
                            checkRMU();
                            return reject(false);
                        } else {
                            systems[system] = true;
                            if(plugin=="fan") {
                                reqDataForPlugin(ctx.hP.bs1_flow,plugin,system,generation).then(data => {
                                    if(data.data<-3276) {
                                        return reject(false);
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
    // Every rejection above means the pump answered that the system or sensor is
    // not there; a read that keeps failing retries instead of rejecting.
    promise.then(() => logPluginOutcome(plugin,system,'registered after earlier failed reads'),
                 () => logPluginOutcome(plugin,system,'not registered: not present on this pump'));
    return promise;
}
    function updateData(hourly=false) {
        return collectAndRun(hourly).catch(err => reportPluginError('updateData',err));
    }
    async function collectAndRun(hourly) {
        let timeNow = Date.now();
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
                                sendError(ctx.text.extra_sensor,`${ctx.text.extra_sensor} ${item.registers[i].name} ${ctx.text.not_updated}`)
                            } else {
                                data.system = item.system;
                                data.timestamp = timeNow;
                                data.name = item.registers[i].name;
                                data.topic = item.registers[i].register;
                                result[item.registers[i].register] = data;
                                array.push(data)
                            }

                        },(error => {
                            sendError(ctx.text.extra_sensor,`${ctx.text.extra_sensor} ${item.registers[i].name} ${ctx.text.no_values}`)
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
            runSafely('Inomhusreglering',() => runIndoor(result,array));
            runSafely('Elprisreglering',() => runPrice(result,array));
            runSafely('RMU',() => runRMU(result,array));
            if(hourly===true) {
                result.array = array;
                runSafely('Prognosreglering',() => runWeather(result));
            } else {
                result.array = array;
                runSafely('Prognosreglering',() => {
                    if(nibe.getConfig().weather['enable_'+item.system]===true) {
                        nibeData.emit('pluginWeather',result);
                    }
                });
            }
            nibeData.emit('updateGraph');
        }
      }

///////##########################################################
// ##################################################################
// # START: Algoritm från energy.anerdins-iot.se (ORIGINAL-LOGIK)   #
// ##################################################################







// ##################################################################
// # SLUT: Algoritm                                                 #
// ##################################################################









let fan_filter_normal_eff;
let fan_filter_low_eff;
let filter_eff;
let isRunFanExecuting = false;

async function runFan() {
    if (isRunFanExecuting) {
        nibe.log('runFan körs redan, avvaktar denna körning.', 'fan', 'debug');
        return;
    }
    isRunFanExecuting = true;

    try {
        let config = nibe.getConfig();
        var data = {};
        var timeNow = Date.now();
        if(config.fan===undefined) { config.fan = {}; nibe.setConfig(config); }
        if(config.fan.enable!==true) {
            return;
        }
        // Loggades före den här kontrollen, så ett avstängt luftflöde skrev en rad
        // i minuten - 1440 per dygn - om att köra något det inte gjorde.
        nibe.log('Kör runFan()', 'fan', 'debug');

        // Steg 1: Hämta grundläggande data (återgår till steg-för-steg-metoden)
        data.cpr_set = await getNibeData(ctx.hP['cpr_set']).catch(console.log);
        data.temp_fan_speed = await getNibeData(ctx.hP['fan_mode']).catch(console.log);
        data.fan_speed = await getNibeData(ctx.hP['fan_speed']).catch(console.log);
        data.bs1_flow = await getNibeData(ctx.hP['bs1_flow']).catch(console.log);
        data.alarm = await getNibeData(ctx.hP['alarm']).catch(console.log);
        data.evaporator = await getNibeData(ctx.hP['evaporator']).catch(console.log);

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
            data.dM = await getNibeData(ctx.hP['dM']).catch(console.log);
            data.dMstart = await getNibeData(ctx.hP['dMstart']).catch(console.log);
            data.dMaddstart = await getNibeData(ctx.hP['dMaddstart']).catch(console.log);

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
                if(data.fan_speed.raw_data - 5 > 10) nibe.setData(ctx.hP.fan_speed, (data.fan_speed.raw_data - 5));
                else if(data.fan_speed.raw_data > 10) nibe.setData(ctx.hP.fan_speed, (data.fan_speed.raw_data - 1));
            } else if(data.bs1_flow.raw_data > (flow_set + 10)) {
                if(data.fan_speed.raw_data > 0) nibe.setData(ctx.hP.fan_speed, (data.fan_speed.raw_data - 1));
            } else if(data.bs1_flow.raw_data < (flow_set - 20)) {
                if(data.fan_speed.raw_data + 5 < 100) nibe.setData(ctx.hP.fan_speed, (data.fan_speed.raw_data + 5));
                else if(data.fan_speed.raw_data < 100) nibe.setData(ctx.hP.fan_speed, (data.fan_speed.raw_data + 1));
            } else if(data.bs1_flow.raw_data < (flow_set - 10)) {
                if(data.fan_speed.raw_data < 100) nibe.setData(ctx.hP.fan_speed, (data.fan_speed.raw_data + 1));
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
        data.cpr_act = await getNibeData(ctx.hP['cpr_act']).catch(console.log);
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
        let sensor = register.find(index => index.register == ctx.hP['rmu_sensor_s'+i]);
        if(sensor!==undefined && sensor.mode=="R/W") {
            if(inside!==undefined) {
                nibe.setData(ctx.hP['rmu_sensor_s'+i],inside.data);
            } else {
                sendError(`RMU40 System ${i}`,`Givare har inga värden, avbryter...`);
                return;
            }
            data.rmuSensor = inside;
            nibeData.emit('pluginRMU',data);
        }
    }
}
let defrostTimer = 60000;
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
    async function uptimeCheck() {
        getNibeData(ctx.hP['cpr_act']).then(cpr => {
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
        getNibeData(ctx.hP['defrost_time']).then(defrost => {
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
        nibe.log(`Running diagnostic`,'diagnostic','debug');
        nibe.log(`Heatpump is supported, starting defrost check timer, timer: ${defrostTimer/1000} sec`,'diagnostic','debug');
        if(timer.diagnostic===undefined || timer.diagnostic._idleTimeout===-1) {
            timer.diagnostic = setTimeout(defrostCheck, defrostTimer);
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
