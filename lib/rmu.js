// RMU 40 room units.
module.exports = function (ctx) {
    const { nibe, nibeData, sendError } = ctx;

async function runRMU(result,array) {
    let config = nibe.getConfig();
    var data = Object.assign({}, result);
    if(config.rmu===undefined) config.rmu = {};
    for( var i = 1; i < 5; i++){
        data.system = "s"+i;
        let inside;
        const chosen = config.rmu['sensor_s'+i]!==undefined && config.rmu['sensor_s'+i]!=="" && config.rmu['sensor_s'+i]!=="Ingen";
        if(chosen) {
            let ind = array.findIndex(index => index.name == config.rmu['sensor_s'+i]);
            if(ind!==-1) inside = array[ind];
        }
        let register = nibe.getRegister();
        let sensor = register.find(index => index.register == ctx.hP['rmu_sensor_s'+i]);
        if(sensor!==undefined && sensor.mode=="R/W") {
            if(inside!==undefined && inside.data!==undefined && inside.data!==null) {
                nibe.setData(ctx.hP['rmu_sensor_s'+i],inside.data);
            } else if(chosen) {
                // The chosen sensor has no reading: tell the pump there is
                // none, so it stops using the last one it was sent.
                nibe.setData(ctx.hP['rmu_sensor_s'+i],null);
                sendError(`RMU40 System ${i}`,`Givare har inga värden, skickar "inget värde" till pumpen`);
                continue;
            } else {
                sendError(`RMU40 System ${i}`,`Ingen givare vald`);
                continue;
            }
            data.rmuSensor = inside;
            nibeData.emit('pluginRMU',data);
        }
    }
}

    return { runRMU };
};
