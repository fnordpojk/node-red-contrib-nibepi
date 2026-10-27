// Hot water control: automatic luxury and hot water priority.
module.exports = function (ctx) {
    const { getNibeData, nibe, nibeData, saveDataGraph } = ctx;

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

    return { hotwaterPlugin };
};
