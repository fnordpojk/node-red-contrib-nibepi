module.exports = function(RED) {
    function nibeRequest(config) {
        RED.nodes.createNode(this,config);
        var timer;
        var reqOn = false;
        var absentReported = false;
        this.server = RED.nodes.getNode(config.server);
        let nibe = this.server.nibe;
        const suncalc = this.server.suncalc;
        if (this.server) {
            this.on('input', function(msg) {
                let register = config.name;
                if(this.server.hP()[config.name]!==undefined) {
                    register = this.server.hP()[config.name]
                }
                if(register.toLowerCase()=="astro") {
                    timer = setTimeout(() => {
                        this.status({ fill: 'yellow', shape: 'dot', text: `` });
                    }, 5000);
                    this.status({ fill: 'green', shape: 'dot', text: `Requesting astro data` });
                    msg.astro = suncalc(msg)
                    this.status({ fill: 'green', shape: 'dot', text: `` });
                    this.send(msg);
                } else if(register.toLowerCase()=="config") {
                    this.status({ fill: 'yellow', shape: 'dot', text: `Requesting configuration` });
                    let config = nibe.getConfig();
                    if(config!==undefined) {
                        this.status({ fill: 'green', shape: 'dot', text: `Received configuration` });
                        msg.config = config;
                        this.send([msg,{topic:config.name,payload:msg.config}]);
                    } else {
                        this.send(msg);
                        this.status({ fill: 'red', shape: 'dot', text: `Timeout requesting configuration` });
                    }
                  
                } else {
                    if(reqOn===false) {
                        reqOn = true;
                        this.status({ fill: 'yellow', shape: 'dot', text: `Requesting data` });
                        nibe.reqData(register).then(result => {
                            this.status({ fill: 'green', shape: 'dot', text: `Value: ${result.data}${result.unit}` });
                            clearTimeout(timer);
                            msg[config.name+"_raw"] = result;
                            msg[config.name] = result.data;
                            this.send([msg,{topic:config.name,payload:result.data}])
                            reqOn = false;
                            setTimeout(() => {
                                this.status({ fill: 'yellow', shape: 'dot', text: `` });
                            }, 10000);
                        }).catch((err) => {
                            const message = (err!==undefined && err!==null && err.message!==undefined) ? err.message : String(err);
                            // These nodes cover several pump models, so the ones for
                            // other models permanently miss on this one. Say that once
                            // instead of logging a raw Error object every trigger.
                            if(message.indexOf('not in database')!==-1) {
                                if(absentReported===false) {
                                    absentReported = true;
                                    this.warn(`Register ${register} is not available on this heat pump model`);
                                }
                                this.status({ fill: 'grey', shape: 'ring', text: `Not on this model` });
                            } else {
                                console.log(message)
                                this.status({ fill: 'red', shape: 'dot', text: `Could not get data.` });
                            }
                        })
                        timer = setTimeout(() => {
                            reqOn = false;
                            this.send(msg);
                            this.status({ fill: 'red', shape: 'dot', text: `Timeout requesting data` });
                        }, 30000,msg);
                        
                    }
                    
                }
            });
        } else {
            // No config node configured
        }
    }
    RED.nodes.registerType("nibe-request",nibeRequest);
}
