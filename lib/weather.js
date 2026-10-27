// Forecast control: adjusts the heat curve for the SMHI forecast, sun and wind.
module.exports = function (ctx) {
    const https = require('https');
    const { curveAdjust, getNibeData, nibe, nibeData, saveDataGraph, savedData, weatherOffset } = ctx;

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

    return { runWeather, suncalc };
};
