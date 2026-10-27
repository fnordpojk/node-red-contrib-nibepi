module.exports = function(RED) {
    const EventEmitter = require('events').EventEmitter;
    require('events').EventEmitter.defaultMaxListeners = 850;
    const https = require('https');
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
            if(val.outside===undefined) {
                val.outside = await getNibeData(ctx.hP['outside']).catch(console.log)
            }
            if(val.outside===undefined) {
                nibe.log(`Kunde inte läsa utomhustemperaturen, hoppar över prognosreglering.`,'weather','error');
                return;
            }
            let outside = val.outside.data;
            nibe.log(`Aktuell utomhustemperatur: ${outside}`,'weather','debug');
            if(val['heatcurve_'+val.system]===undefined) {
                console.log('Hämtar värmekurva manuellt.')
                val['heatcurve_'+val.system] = await getNibeData(ctx.hP['heatcurve_'+val.system]).catch(console.log)
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
                                        const rawHistory = (Array.isArray(ctx.savedGraph[rawName]) ? ctx.savedGraph[rawName] : []).filter(point => point.x < timeNow);
                                        ctx.savedGraph[rawName] = rawHistory.concat(rawForecastGraph).sort((a, b) => (a.x > b.x) ? 1 : -1);
                                        savedData['weather_unfilterd_'+val.system] = {
                                            data:tempPredictedRaw,
                                            raw_data:tempPredictedRaw,
                                            timestamp:toTimestamp(timeLaterString)
                                        }
                                    }
                                    if(adjustedForecastGraph.length>0) {
                                        const adjustedName = 'weather_forecast_'+val.system;
                                        const adjustedHistory = (Array.isArray(ctx.savedGraph[adjustedName]) ? ctx.savedGraph[adjustedName] : []).filter(point => point.x < timeNow);
                                        ctx.savedGraph[adjustedName] = adjustedHistory.concat(adjustedForecastGraph).sort((a, b) => (a.x > b.x) ? 1 : -1);
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
        // A read that timed out leaves its register out of data. Skip this run
        // rather than regulate on a value that is not there; the next one reads again.
        const enabled = conf.indoor['enable_'+data.system]===true;
        const dmReset = conf.indoor.dm_reset_enable===true && conf.system.pump!=="F370" && conf.system.pump!=="F470";
        const missing = [];
        if(inside_set===undefined) missing.push('inside_set_'+data.system);
        if(enabled && factor===undefined) missing.push('inside_factor_'+data.system);
        if(dmReset && dM===undefined) missing.push('dM');
        if(dmReset && dMstart===undefined) missing.push('dMstart');
        if(missing.length>0) {
            nibe.log(`Inomhusreglering (${data.system}): saknar värde för ${missing.join(', ')}, hoppar över.`,'error','debug');
            return;
        }
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

///////##########################################################
// ##################################################################
// # START: Algoritm från energy.anerdins-iot.se (ORIGINAL-LOGIK)   #
// ##################################################################







// ##################################################################
// # SLUT: Algoritm                                                 #
// ##################################################################









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
            hwON = await getNibeData(ctx.hP['startHW']).catch(console.log);
            bt6 = await getNibeData(ctx.hP['bt6']).catch(console.log);
            bt7 = await getNibeData(ctx.hP['bt7']).catch(console.log);
            hwMode = await getNibeData(ctx.hP['hw_mode']).catch(console.log);
            if(hwMode===undefined) {
                nibe.log(`Kunde inte läsa varmvattenläge, hoppar över varmvattenreglering.`,'hw','error');
                return;
            }
            hwStopTemp = await getNibeData(ctx.hP['hw_stop_'+hwMode.raw_data]).catch(console.log);
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
            let difference = Number(config.hotwater.diff);
            let diff_time = Number(config.hotwater.time);
            hwSavedTemp.unshift(bt6.data);
            if(hwSavedTemp.length>=diff_time) {
                if(hwSavedTemp.length>diff_time) {
                    hwSavedTemp.splice(diff_time,hwSavedTemp.length);
                }
                hwTriggerTemp = hwSavedTemp.pop()
                hwTriggerTemp = hwTriggerTemp-difference;
            } else {
                hwTriggerTemp = hwSavedTemp[hwSavedTemp.length-1]
                hwTriggerTemp = hwTriggerTemp-difference;
            }
            hwTriggerTemp = Number(hwTriggerTemp.toFixed(2));
            let hw_target_temp;
            if(hwON.raw_data!==4) {
                    if(bt6.data<=hwTriggerTemp) {
                        hwTargetValue = hwTriggerTemp+difference-5;
                        hwTargetValue = Number(hwTargetValue.toFixed(2));
                        hw_target_temp = hwTargetValue;
                        nibe.setData(ctx.hP['startHW'],4);
                    }

            } else {
                if(hwTargetValue!==undefined) {
                    if(bt6.data>=hwTargetValue || bt6.data>=hwStopTemp.data) {
                        hwTargetValue = undefined;
                        nibe.setData(ctx.hP['startHW'],0);
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
            hwStartTemp = await getNibeData(ctx.hP['hw_start_'+hwMode.data]).catch(console.log);
            if(hwStartTemp===undefined) {
                nibe.log(`Kunde inte läsa starttemperatur för varmvatten, hoppar över.`,'hw','error');
                return;
            }
            hwStartTemp.timestamp = time;
            if(hwON.raw_data!==4) {
                if(bt7.data<=hwStartTemp.data) {
                    nibe.setData(ctx.hP['startHW'],4);
                }
            } else {
                    if(bt7.data>=hwStopTemp.data && hwTargetValue===undefined) {
                        nibe.setData(ctx.hP['startHW'],0);
                    }
            }
            data.hwStartTemp = hwStartTemp;
            saveDataGraph('hw_start_temp',time,hwStartTemp.data,true);
            nibeData.emit('pluginHotwaterPriority',data);
        }

    }
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
