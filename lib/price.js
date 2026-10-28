// Price control: prices from Tibber, elprisetjustnu.se or the pump's own level,
// and the heat curve, hot water, pool and frequency adjustments that follow.
module.exports = function (ctx) {
    const https = require('https');
    const { curveAdjust, getNibeData, nibe, nibeData, optimizeElectricityTrading, priceLevelsFromTrades, priceOffset, reportPluginError, sendError } = ctx;

    const priceAdjustCurve = async (dataIn) => {
        var data = Object.assign({}, dataIn);
        let system = data.system;
        let inside = data.priceSensor;
        nibe.log(`Startar elprisjustering priceAdjustCurve() för ${data.system}`,'price','debug');
        let config = nibe.getConfig();
        // No sensor chosen ("Ingen"): the pump's own room sensor BT50, as in indoor and
        // forecast control. A chosen sensor that gave no value is not replaced by it.
        const chosenSensor = config.price && config.price['sensor_'+system];
        if(inside===undefined && (chosenSensor===undefined || chosenSensor==="" || chosenSensor==="Ingen")) {
            inside = data['inside_'+system];
        }
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
                            // Only write a temperature the pump does not already have; one
                            // that could not be read is written.
                            const writeIfChanged = (key, current, target) => {
                                if(Number(val(current)) !== Number(target)) nibe.setData(ctx.hP[key+system],target);
                            };
                            if(level=="NORMAL") {
                                writeIfChanged('pool_start_temp_',poolStart,config.price.NORMAL_START_POOL_HEAT)
                                writeIfChanged('pool_stop_temp_',poolStop,config.price.NORMAL_STOP_POOL_HEAT)
                            } else {
                                const adjust = config.price[`${level}_POOL_HEAT`]
                                const start = config.price.NORMAL_START_POOL_HEAT
                                const stop = config.price.NORMAL_STOP_POOL_HEAT
                                writeIfChanged('pool_start_temp_',poolStart,Math.min(start+adjust,config.price.pool_max_temp))
                                writeIfChanged('pool_stop_temp_',poolStop,Math.min(stop+adjust,config.price.pool_max_temp))
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
                        // The caller reports it: only it knows whether the answer was
                        // expected, as tomorrow's prices are before they are published.
                        reject(res.statusMessage)
                    }

                });
                })

                req.on('error', (error) => {
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

    return { getCloudData, runPrice };
};
