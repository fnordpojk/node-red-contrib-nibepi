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
    const priceAdjustCurve = async (dataIn) => {
        var data = Object.assign({}, dataIn);
        let system = data.system;
        let inside = data.priceSensor;
        nibe.log(`Startar elprisjustering priceAdjustCurve() för ${data.system}`,'price','debug');
        let config = nibe.getConfig();
        // A read that timed out leaves its register out of data. Skip this run
        // rather than adjust on a value that is not there; the next one reads again.
        const missing = [];
        if(data['inside_set_'+system]===undefined) missing.push('inside_set_'+system);
        if(config.system.pump!=="F370" && config.system.pump!=="F470") {
            if(data.dM===undefined) missing.push('dM');
            if(data.dMstart===undefined) missing.push('dMstart');
        }
        if(missing.length>0) {
            nibe.log(`Elprisreglering (${system}): saknar värde för ${missing.join(', ')}, hoppar över.`,'price','debug');
            return;
        }


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
                    nibe.reqData(ctx.hP.hw_mode).then(result => {
                        if(result.raw_data!==hw_adjust) nibe.setData(ctx.hP.hw_mode,hw_adjust);
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
                                    data.dM = await getNibeData(ctx.hP['dM']).catch(console.log)
                                }
                                if(data.dM.data > 0 && data.dM.data > data.dMstart.data+25) {
                                    nibe.log(`Ställer in gradminuter nära start ${data.dMstart.data+25}`,'price','debug');
                                    nibe.setData(ctx.hP['dM'],(data.dMstart.data+25));
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
                                    data.dM = await getNibeData(ctx.hP['dM']).catch(console.log);
                                }
                                if(data.dM.data > 0 && data.dM.data > data.dMstart.data+25) {
                                    nibe.log(`Ställer in gradminuter nära start ${data.dMstart.data+25}`,'price','debug');
                                    nibe.setData(ctx.hP['dM'],(data.dMstart.data+25));
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
                    nibe.reqData(ctx.hP.hw_mode).then(result => {
                        if(result.raw_data!==hw_adjust) nibe.setData(ctx.hP.hw_mode,hw_adjust);
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
        const system = data.system;
        let config = nibe.getConfig();

        // Apply VAT and AI-only markup (öre) to chart values (shown in SEK). Tibber graph stays unchanged.
        const vatRate = (config.price && typeof config.price.vat === "number") ? config.price.vat : 0.25;
        const additionOre = (config.price && typeof config.price.addition_ore === "number") ? config.price.addition_ore : 88.01;

        if(config.price===undefined) {
            config.price = {};
            nibe.setConfig(config);
        }
        const heat_enable = config.price['enable_heat_'+system];
        const hotwaterAdjust = (level) => {
            if(level=="VERY_CHEAP") return Number(config.price.hotwater_very_cheap);
            if(level=="CHEAP") return Number(config.price.hotwater_cheap);
            if(level=="EXPENSIVE") return Number(config.price.hotwater_expensive);
            if(level=="VERY_EXPENSIVE") return Number(config.price.hotwater_very_expensive);
            return Number(config.price.hotwater_normal);
        };
        const priceArrayHeat = heat.prices;
        priceArrayHeat.sort(function(a,b){return a.value - b.value});
        const priceArrayHW = hw.prices;
        priceArrayHW.sort(function(a,b){return a.value - b.value});

        const ownPrice = !!(config && config.price && config.price.enable_own_price);
        const applyVat = !!(config && config.price && config.price.apply_vat === true);
        const valueArray = [];
        const adjustArrayHeat = [];
        const adjustArrayHW = [];
        for (let o = 0; o < priceArrayHeat.length; o++) {
            const timestamp = priceArrayHeat[o].ts;
            const level = priceArrayHeat[o].level;
            const baseKr = (priceArrayHeat[o].value/100);
            const value = Number((ownPrice ? (baseKr * (applyVat ? (1 + vatRate) : 1) + (additionOre/100)) : baseKr).toFixed(2));
            let adjust = 0;
            if(heat_enable!==undefined && heat_enable===true) {
                if(level=="VERY_CHEAP") adjust = config.price['heat_very_cheap_'+system]||0;
                else if(level=="CHEAP") adjust = config.price['heat_cheap_'+system]||0;
                else if(level=="NORMAL") adjust = config.price['heat_normal_'+system]||0;
                else if(level=="EXPENSIVE") adjust = config.price['heat_expensive_'+system]||0;
                else if(level=="VERY_EXPENSIVE") adjust = config.price['heat_very_expensive_'+system]||0;
            }
            valueArray.push({x:timestamp,y:Number(value)});
            adjustArrayHeat.push({x:timestamp,y:Number(adjust.toFixed(2))})
        }
        for (let o = 0; o < priceArrayHW.length; o++) {
            adjustArrayHW.push({x:priceArrayHW[o].ts,y:Number(hotwaterAdjust(priceArrayHW[o].level).toFixed(2))})
        }
        valueArray.sort((a, b) => (a.x > b.x) ? 1 : -1)
        adjustArrayHeat.sort((a, b) => (a.x > b.x) ? 1 : -1)
        adjustArrayHW.sort((a, b) => (a.x > b.x) ? 1 : -1)

        const sendArray = [
            {
                "series":["Pris","Värmejustering","Varmvattenläge"],
                "data":[valueArray,adjustArrayHeat,adjustArrayHW],
                "labels":["Pris","Värmejustering","Varmvattenläge"]
            }];
        if(prio_add_enable!==undefined) {
            if(config.price.prio_enable===true) {
                nibe.log(`Prioriterad tillsats är aktiverad som elprisreglering, skapar graf`,'price','debug');
                const prioArray = [];
                const fee = config.price.prio_tax+config.price.prio_transfer
                const cop = config.price.prio_cop
                const cost = config.price.prio_cost
                for (let o = 0; o < priceArrayHeat.length; o++) {
                    const price = Number((priceArrayHeat[o].value).toFixed(2));
                    // 10 = reglering, 0 = ingen reglering
                    prioArray.push({x:priceArrayHeat[o].ts,y:(price+fee > cost*cop) ? 10 : 0})
                }
                prioArray.sort((a, b) => (a.x > b.x) ? 1 : -1)
                sendArray[0].series.push('Prio. tillsats')
                sendArray[0].data.push(prioArray)
                sendArray[0].labels.push('Prio. tillsats')
            }
        }
        return {values:sendArray,system:system};
    }

///////##########################################################
// ##################################################################
// # START: Algoritm från energy.anerdins-iot.se (ORIGINAL-LOGIK)   #
// ##################################################################







// ##################################################################
// # SLUT: Algoritm                                                 #
// ##################################################################

// runPrice, nu med 15-min stöd och dynamisk hantering av sommar-/vintertid
// Hourly prices from quarter-hour prices: the quarters of each hour averaged, each hour
// keeping the time zone suffix of its first quarter. startOf and priceOf read the fields
// of the source's price objects.
function hourlyFromQuarters(quarters, startOf, priceOf) {
    const groupedByHour = quarters.reduce((acc, price) => {
        const hour = startOf(price).substring(0, 13); // "2025-09-30T10"
        if (!acc[hour]) {
            acc[hour] = [];
        }
        acc[hour].push(price);
        return acc;
    }, {});
    const hourly = [];
    for (const hour in groupedByHour) {
        const itemsInHour = groupedByHour[hour];
        const averagePrice = itemsInHour.reduce((sum, p) => sum + priceOf(p), 0) / itemsInHour.length;
        // "2025-11-25T10:00:00.000+01:00" -> ".000+01:00"; "2025-11-25T10:00:00+01:00" -> "+01:00"
        const timeZoneSuffix = startOf(itemsInHour[0]).slice(19);
        hourly.push({
            startsAt: `${hour}:00:00${timeZoneSuffix}`,
            total: averagePrice
        });
    }
    return hourly;
}

// Tibber's prices for today and, once published, tomorrow, as hourly prices. Undefined when
// there are none; the reason is logged.
async function tibberHourlyPrices(config) {
    const tibberOptions = {
        hostname: 'api.tibber.com',
        port: 443,
        path: '/v1-beta/gql',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.price.token}`, 'Content-Type': 'application/json' }
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
    const hourlyPriceList = hourlyFromQuarters(quarterlyPriceList, p => p.startsAt, p => p.total);
    nibe.log(`Hämtade ${quarterlyPriceList.length} kvartspunkter och konverterade till ${hourlyPriceList.length} stabila timpunkter.`, 'price', 'debug');
    nibe.log(`Hämtade ${hourlyPriceList.length} kvartspunkter för analys.`, 'price', 'debug');
    return hourlyPriceList;
}

// elprisetjustnu.se's prices for today and, once published, tomorrow, as hourly prices.
// Undefined when there are none; the reason is logged.
async function elprisHourlyPrices(config) {
    const area = config.price.area || 'SE3';
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const todayYear = today.getFullYear();
    const todayMonthDay = today.toISOString().slice(5, 10); // "10-07"
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
    const hourlyPriceList = hourlyFromQuarters(rawPriceList, p => p.time_start, p => p.SEK_per_kWh);
    nibe.log(`Hämtade ${rawPriceList.length} kvartspunkter och konverterade till ${hourlyPriceList.length} stabila timpunkter.`, 'price', 'debug');
    return hourlyPriceList;
}

// Price levels for heat and hot water from hourly prices, whichever service they came from,
// and everything that follows from them: own thresholds, prioritized additional heat, the
// heat curve, the pool and the graphs.
async function applyLocalPriceAnalysis(data, config, fullPriceList) {
    // VV-AI: cacha timpriser i RAM för VV-analys (ingen SD-skrivning)
    ctx.vvAiPriceCache = fullPriceList;

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
    const optimalTrades = optimizeElectricityTrading(priceDataForAlgo, {
        timeWindow: config.price.time,
        minSpread: config.price.min_spread
    });
    const heatLevels = priceLevelsFromTrades(optimalTrades, currentHourDate, fullPriceList);
    const heat = {
        level: heatLevels.level,
        current: currentHour.total * 100,
        prices: heatLevels.prices
    };

    // Varmvattnet har en egen tidshorisont: optimeringen körs en gång till med time_hw när
    // den skiljer sig från värmens fönster. Kortare fönster för varmvatten är det vanliga:
    // tanken räcker några timmar, huset längre.
    const heatWindow = Number(config.price.time);
    const hwWindow = Number(config.price.time_hw);
    let hw;
    if (Number.isFinite(hwWindow) && hwWindow > 0 && hwWindow !== heatWindow) {
        const hwTrades = optimizeElectricityTrading(priceDataForAlgo, {
            timeWindow: hwWindow,
            minSpread: config.price.min_spread
        });
        const hwLevels = priceLevelsFromTrades(hwTrades, currentHourDate, fullPriceList);
        hw = {
            level: hwLevels.level,
            current: heat.current,
            prices: hwLevels.prices
        };
        nibe.log(`Varmvatten på egen tidshorisont ${hwWindow} h (värme ${heatWindow} h): ` +
            `nivå ${hw.level}, värme ${heat.level}`, 'price', 'debug');
    } else {
        hw = { ...heat };
    }
    data.priceai = { heat, hw };

    // The price shown, in öre: with VAT and the addition when own price is on.
    const ownPrice = !!(config && config.price && config.price.enable_own_price);
    const applyVat = !!(config && config.price && config.price.apply_vat === true);
    const vat = (typeof config.price.vat === 'number' ? config.price.vat : 0.25);
    const addOre = ((config && config.price && config.price.addition_ore) || 0);
    const baseKr = (Number(heat.current) || 0) / 100;
    const shownKr = ownPrice ? (baseKr * (applyVat ? (1 + vat) : 1) + (addOre/100)) : baseKr;
    const shownOre = Number((shownKr * 100).toFixed(2));
    data.price_current = {
        data: shownOre,
        raw_data: shownOre,
        info: "Current electrical price",
        titel: "Electric price",
        register: "electric_price",
        unit: "öre",
        icon_name: "fa-flash"
    };

    // Own thresholds override the levels of both heat and hot water.
    try {
        if (config && config.price && config.price.enable_own_setting === true) {
            const ownVat = (config && config.price && typeof config.price.vat === 'number') ? config.price.vat : 0.25;
            const ownAddOre = Number((config && config.price && config.price.addition_ore) || 0);
            const vLow = Number(config && config.price ? config.price.verycheap : NaN);
            const vHigh = Number(config && config.price ? config.price.veryexpensive : NaN);
            const krNow = Number(currentHour && currentHour.total) || 0; // kr/kWh
            const oreNow = (config.price.enable_own_price === true)
                ? (((config.price.apply_vat === true) ? krNow*(1+ownVat) : krNow) * 100) + ownAddOre
                : (krNow*100);
            if (isFinite(vLow) && isFinite(vHigh)) {
                const level = (oreNow >= vHigh) ? 'VERY_EXPENSIVE' : (oreNow <= vLow) ? 'VERY_CHEAP' : 'NORMAL';
                heat.level = level;
                if (hw && typeof hw.level !== 'undefined') hw.level = level;
                nibe.log('OWN THRESHOLDS APPLIED (local) → heat.level='+heat.level+', oreNow='+oreNow.toFixed(2)+' öre (vLow='+vLow+', vHigh='+vHigh+')','price','debug');
            }
        }
    } catch(e) {}

    data.heat_price_level = { data: heat.level, raw_data: heat.level };
    data.hw_price_level = { data: hw.level, raw_data: hw.level };

    nibe.log(`Lokal analys klar. Nivå: ${heat.level}, Pris: ${data.price_current.data} öre`, 'price', 'debug');

    const prio_add_enable = await getNibeData(ctx.hP['prio_add_enable']).catch(() => {});
    if(prio_add_enable!==undefined) {
        if(config.price.prio_enable===true) {
            if(config.price.prio_cop===undefined) config.price.prio_cop = 3;
            if(config.price.prio_cost===undefined) config.price.prio_cost = 1;
            if(config.price.prio_tax===undefined) config.price.prio_tax = 45;
            if(config.price.prio_transfer===undefined) config.price.prio_transfer = 25;
            nibe.setConfig(config); // Save defaults if they were missing

            nibe.log(`Prioriterad tillsats är aktiverad som elprisreglering`,'price','debug');
            const price = data.price_current.raw_data;
            const fee = config.price.prio_tax + config.price.prio_transfer;
            const cop = config.price.prio_cop;
            const cost = config.price.prio_cost;

            // Jämför kostnad för 1 kWh värme från pumpen vs. alternativet
            // (price + fee) / cop  vs  cost * 100
            if((price + fee) > (cost * 100 * cop)) {
                if(prio_add_enable.raw_data===0) {
                    nibe.log(`Värmepumpen är dyrare att köra än prioriterad tillsats. Slår på tillsats.`, 'price', 'debug');
                    nibe.setData(ctx.hP['prio_add_enable'],1);
                }
            } else {
                if(prio_add_enable.raw_data===1) {
                    nibe.log(`Värmepumpen är billigare att köra än prioriterad tillsats. Slår av tillsats.`, 'price', 'debug');
                    nibe.setData(ctx.hP['prio_add_enable'],0);
                }
            }
        }
    }

    priceAdjustCurve(data).catch(err => reportPluginError('Elprisreglering',err));
    adjustPool(data,data.system)
    .then(pool => {
        if(pool!==undefined){ nibe.log('POOL-EMIT sys='+data.system,'price','debug'); nibeData.emit('pluginPriceGraphPool',priceBuildPoolGraph(heat,data.system)); }
    })
    .catch(console.log);

    nibeData.emit('pluginPrice',data);
    nibeData.emit('pluginPriceGraph',priceaiBuildGraph(heat,hw,data,prio_add_enable));
}

async function runPrice(data,array) {

    let config = nibe.getConfig();
    // De här raderna loggades innan funktionen kollade om elprisregleringen
    // överhuvudtaget var påslagen. Själva uppslaget nedan måste ligga kvar där det
    // ligger - det sätter data.priceSensor som andra delar läser även när
    // regleringen är av - så det är bara loggningen som flyttar.
    const priceEnabled = (config.price!==undefined && config.price.enable===true);
    let inside;
    if(priceEnabled) {
        nibe.log(`Startar elprisreglering runPrice()`,'price','debug');
        nibe.log(`Letar efter givare ${config.price['sensor_'+data.system]}`,'price','debug');
    }
    if(config.price['sensor_'+data.system]!==undefined && config.price['sensor_'+data.system]!=="") {
        let index = array.findIndex(i => i.name == config.price['sensor_'+data.system]);
        if(index!==-1) {
            inside = array[index];
            if(priceEnabled) {
                nibe.log(`Sätter inomhusgivare ${config.price['sensor_'+data.system]}, ${inside.data} grader`,'price','debug');
            }
        }
    }
    data.priceSensor = inside;
    if(priceEnabled) {
        nibe.log(`Elprisreglering är aktiverad`,'price','debug');
        if(config.price.source=="tibber") {
            nibe.log(`Källan är Lokal AI via Tibber`,'price','debug');
            if(config.price.token === undefined || config.price.token === "") {
                sendError('Lokal AI',`Tibber Token krävs för att hämta prisdata.`);
                return;
            }
            try {
                const prices = await tibberHourlyPrices(config);
                if (prices) await applyLocalPriceAnalysis(data, config, prices);
            } catch(err) {
                nibe.log(`Fel i Lokal AI-styrning: ${err}`, 'price', 'error');
                console.log(err);
            }
        } else if(config.price.source=="nibe") {
            nibe.log(`Källan är Nibe`,'price','debug');
            data.price_level = await getNibeData(ctx.hP['price_level']).catch(console.log);
            data.price_enable = await getNibeData(ctx.hP['price_enable']).catch(console.log);
            priceAdjustCurve(data).catch(err => reportPluginError('Elprisreglering',err));
            data.price_current = await getNibeData(ctx.hP['price_current']).catch(console.log);
            nibeData.emit('pluginPriceGraph',nibeBuildGraph(data,data.system));
            nibeData.emit('pluginPrice',data);
        } else if(config.price.source=="priceai" || config.price.source=="local_ai") {
            nibe.log(`Källan är Lokal AI (via elprisetjustnu.se)`,'price','debug');
            try {
                const prices = await elprisHourlyPrices(config);
                if (prices) await applyLocalPriceAnalysis(data, config, prices);
            } catch (err) {
                nibe.log(`Fel vid hämtning/analys från elprisetjustnu.se: ${err}`, 'price', 'error');
                console.log(err);
            }
        }
    }
}

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
                    const poolTemp = getNibeData(ctx.hP['pool_temp_'+system]).catch(console.log)
                    const poolStart = getNibeData(ctx.hP['pool_start_temp_'+system]).catch(console.log)
                    const poolStop = getNibeData(ctx.hP['pool_stop_temp_'+system]).catch(console.log)
                    const poolCpr = getNibeData(ctx.hP['pool_cpr_'+system]).catch(console.log)
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
                                nibe.setData(ctx.hP['pool_start_temp_'+system],config.price.NORMAL_START_POOL_HEAT)
                                nibe.setData(ctx.hP['pool_stop_temp_'+system],config.price.NORMAL_STOP_POOL_HEAT)
                            } else {
                                var adjust = config.price[`${level}_POOL_HEAT`]
                                var start = config.price.NORMAL_START_POOL_HEAT
                                var stop = config.price.NORMAL_STOP_POOL_HEAT
                                nibe.setData(ctx.hP['pool_start_temp_'+system],Math.min(start+adjust,config.price.pool_max_temp))
                                nibe.setData(ctx.hP['pool_stop_temp_'+system],Math.min(stop+adjust,config.price.pool_max_temp))
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
        var req = JSON.parse(request)
        if(req.name=="heat") {
                get(options,request).then(async (data) => {
                    resolve(data)
                }).catch(async (err) => {
                    reject(err)
                })
        } else if(req.name=="hw") {
                try {
                    const bt6 = getNibeData(ctx.hP['bt6']).catch(console.log);
                    const bt7 = getNibeData(ctx.hP['bt7']).catch(console.log);
                    const hwStartTemp = getNibeData(ctx.hP['hw_start_0']).catch(console.log);
                    const hwStopTemp = getNibeData(ctx.hP['hw_stop_2']).catch(console.log);
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
        var outside = getNibeData(ctx.hP['outside']).catch(console.log);
        var lock_freq_1 = getNibeData(ctx.hP['lock_freq_1_activate']).catch(console.log);
        var lock_freq_2 = getNibeData(ctx.hP['lock_freq_2_activate']).catch(console.log);
        var lock_freq_1_min = getNibeData(ctx.hP['lock_freq_1_min']).catch(console.log);
        var lock_freq_1_max = getNibeData(ctx.hP['lock_freq_1_max']).catch(console.log);
        var lock_freq_2_min = getNibeData(ctx.hP['lock_freq_2_min']).catch(console.log);
        var lock_freq_2_max = getNibeData(ctx.hP['lock_freq_2_max']).catch(console.log);
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
                    nibe.setData(ctx.hP['lock_freq_1_min'],frequency,(err,result) => {
                        if(!err) {
                            nibe.setData(ctx.hP['lock_freq_1_activate'],"0",(err,result) => {
                                if(!err) {
                                    nibe.setData(ctx.hP['lock_freq_1_activate'],"1")
                                }

                            });
                        }

                    });
                }

            } else if(frequency < lock_freq_1_min.data) {
                nibe.setData(ctx.hP['lock_freq_1_min'],frequency);
            }
            if(lock_freq_1_max.data!==70) nibe.setData(ctx.hP['lock_freq_1_max'],"70");
            if(lock_freq_2_min.data!==71) nibe.setData(ctx.hP['lock_freq_2_min'],"71");
            if(lock_freq_2_max.data!==120) nibe.setData(ctx.hP['lock_freq_2_max'],"120");
            if(options.heat < 0) {
                // Aktivera spärrband
                if(lock_freq_1.data!==1) nibe.setData(ctx.hP['lock_freq_1_activate'],"1");
                if(lock_freq_2.data!==1) nibe.setData(ctx.hP['lock_freq_2_activate'],"1");
                if(config.price.block_add===true) {
                    var dM = await getNibeData(ctx.hP['dM']).catch(console.log)
                    var dMaddstart = await getNibeData(ctx.hP['dMaddstart']).catch(console.log)
                    if(dMaddstart!==undefined) {
                        if(dM.data < (dMaddstart.data+50)) {
                            nibe.setData(ctx.hP['dM'],(dMaddstart.data+100));
                            nibe.log(`Förhindrar gradminuter från att starta tillsats`,'price','debug');
                        }
                    } else {
                        var dMadd = await getNibeData(ctx.hP['dMadd']).catch(console.log);
                        var dMstart = await getNibeData(ctx.hP['dMstart']).catch(console.log);
                        if(dMadd===undefined || dMstart===undefined) {
                            nibe.log(`Kunde inte läsa gradminutregister, hoppar över frekvensspärr.`,'price','error');
                            return resolve(null);
                        }
                        dMaddstart = dMstart.data-dMadd.data
                        if(dM.data < (dMaddstart.data+50)) {
                            nibe.setData(ctx.hP['dM'],(dMaddstart.data+100));
                            nibe.log(`Förhindrar gradminuter från att starta tillsats`,'price','debug');
                        }
                    }
                }
                resolve(frequency)
            } else if(options.heat >= 0) {
                // Avaktivera spärrband
                if(lock_freq_1.data!==0) nibe.setData(ctx.hP['lock_freq_1_activate'],"0");
                if(lock_freq_2.data!==0) nibe.setData(ctx.hP['lock_freq_2_activate'],"0");
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
    const dM = await getNibeData(ctx.hP['dM']).catch(console.log);
    const dMstart = await getNibeData(ctx.hP['dMstart']).catch(console.log);
    if(dM===undefined || dMstart===undefined) {
        nibe.log(`Kunde inte läsa gradminutregister, hoppar över blockering av tillsats.`,'price','error');
        return reject(new Error('Kunde inte läsa gradminutregister'));
    }

    // Pumps without a dMaddstart register: derive it as dMstart - dMadd, which
    // is what the original fallback path did.
    let dMaddstart = await getNibeData(ctx.hP['dMaddstart']).catch(() => undefined);
    if(dMaddstart===undefined || dMaddstart.data===undefined) {
        const dMadd = await getNibeData(ctx.hP['dMadd']).catch(console.log);
        if(dMadd===undefined) {
            nibe.log(`Kunde inte läsa gradminutregister, hoppar över blockering av tillsats.`,'price','error');
            return reject(new Error('Kunde inte läsa gradminutregister'));
        }
        dMaddstart = { data: dMstart.data - dMadd.data };
    }

    if(dM.data < dMstart.data+(-100)) {
        nibe.setData(ctx.hP['dM'],(dMstart.data/2));
        nibe.log(`Återställer gradminuter`,'price','debug');
    } else {
        if(dM.data < (dMaddstart.data+50)) {
            nibe.setData(ctx.hP['dM'],(dMaddstart.data+100));
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
