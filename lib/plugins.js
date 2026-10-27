// Plugin registration and the regular run: which registers each plugin needs, the
// retrying sign-up, and updateData, which reads them and runs the plugins.
module.exports = function (ctx) {
    const { getNibeData, indoorOffset, nibe, nibeData, priceOffset, reportPluginError, runIndoor, runPrice, runRMU, runSafely, runWeather, sendError, systems, weatherOffset } = ctx;

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

    return { initiatePlugin, pluginRetryTimers, updateData };
};
