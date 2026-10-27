// What the features share: pump reads with a short cache, the graph store, heat
// curve adjustments from several sources, and errors to the dashboard.
module.exports = function (ctx) {
    const { nibe, nibeData } = ctx;

    var systems = {};
    let adjust = [];
    let weatherOffset = {};
    let indoorOffset = {};
    let priceOffset = {};
    let savedData = {};
    let timer = {};
    const curveAdjust = (type,system,data) => {
        let curveadjust;
        if(ctx.hP!==undefined) {
            curveadjust = ctx.hP['curveadjust_'+system];
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
    // updateData runs from cron and from the dashboard without anyone awaiting it,
    // so an error in it was an unhandled rejection, and Node exits on those. A
    // plugin that threw over a register whose read had timed out restarted
    // Node-RED. Report the error and carry on instead, and keep one plugin's
    // error from stopping the others.
    const reportPluginError = (name,err) => {
        console.error(`${name} failed:`, err);
        nibe.log(`${name} failed: ${(err && err.message) ? err.message : err}`,'error','error');
    };
    const runSafely = (name,fn) => {
        try {
            Promise.resolve(fn()).catch(err => reportPluginError(name,err));
        } catch (err) {
            reportPluginError(name,err);
        }
    };
    const sendError = (from,message) => {
        let data = {from:from,message:message};
        nibeData.emit('fault',data);
    };
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
const isObject = (a) => (!!a) && (a.constructor === Object);
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
    if(ctx.savedGraph[name]===undefined) ctx.savedGraph[name] = [];
    let lastIndex = ctx.savedGraph[name].length-1;
    if(ctx.savedGraph[name].length>=2) {
        if(ts>=(ctx.savedGraph[name][lastIndex].x+55000)) {
            if(isValid(data)===true) {
                if((Math.abs(ctx.savedGraph[name][lastIndex].y-data)>0.1)) {
                    ctx.savedGraph[name].push({x:ts,y:data});
                } else {
                    if(ctx.savedGraph[name][lastIndex-1].y===data) {
                        ctx.savedGraph[name][lastIndex].x = ts;
                    } else {
                        ctx.savedGraph[name].push({x:ts,y:data});
                    }

                }
            }
        } else {
            // Check if the timestamp match saved timestamp.
            if(isValid(data)===true) {
                let index = ctx.savedGraph[name].findIndex(i => i.x == ts);
                if(index!==-1) {
                    ctx.savedGraph[name][index].y = data;
                }
            }
        }
    } else {
        if(isValid(data)===true) ctx.savedGraph[name].push({x:ts,y:data});
    }
    if(save===true) {
        savedData[name] = {data:data,raw_data:data,timestamp:ts};
    }

}
const gethP  = () => {
    return ctx.hP;
}
function getSavedData() {
    return savedData;
}
function getSavedGraph() {
    return ctx.savedGraph;
}
function getSystems() {
    return systems;
}
async function tenMinuteUpdate() {
    let config = nibe.getConfig();
    if(config.system.auto_update===undefined || config.system.auto_update===true) {
        getNibeData(ctx.hP['inside_set_s1']).catch(console.log);
        if(systems!==undefined && systems.s2===true) {
            getNibeData(ctx.hP['inside_set_s2']).catch(console.log);
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
        getNibeData(ctx.hP['outside']).catch(console.log);
        getNibeData(ctx.hP['inside_s1']).catch(console.log);
        getNibeData(ctx.hP['curveadjust_s1']).catch(console.log);
        getNibeData(ctx.hP['setpoint_s1']).catch(console.log);
        getNibeData(ctx.hP['supply_s1']).catch(console.log);
        if(systems!==undefined && systems.s2===true) {
            getNibeData(ctx.hP['inside_s2']).catch(console.log);
            getNibeData(ctx.hP['curveadjust_s2']).catch(console.log);
            getNibeData(ctx.hP['setpoint_s2']).catch(console.log);
            getNibeData(ctx.hP['supply_s2']).catch(console.log);
        }
    }
}

    return { curveAdjust, getNibeData, getSavedData, getSavedGraph, getSystems, gethP, indoorOffset, minuteUpdate, priceOffset, reportPluginError, runSafely, saveDataGraph, savedData, sendError, systems, tenMinuteUpdate, timer, weatherOffset };
};
