// Indoor control: adjusts the heat curve toward the indoor setpoint.
module.exports = function (ctx) {
    const { curveAdjust, indoorOffset, nibe, nibeData, saveDataGraph, sendError } = ctx;

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

    return { runIndoor };
};
