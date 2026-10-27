// Fan control: the airflow of exhaust air heat pumps.
module.exports = function (ctx) {
    const { getNibeData, nibe, nibeData, saveDataGraph } = ctx;

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

    return { runFan };
};
