module.exports = function(RED) {
    function nibePrice(config) {
        RED.nodes.createNode(this,config);
        const server = RED.nodes.getNode(config.server);
        // Track this node's own subscriptions so close() can release exactly
        // those. They were previously either never removed (leaking on every
        // redeploy) or cleared with removeAllListeners(), which also wiped every
        // other node's subscriptions from the shared emitter.
        const __subs = [];
        const sub = (ev, fn) => { __subs.push([ev, fn]); server.nibeData.on(ev, fn); return fn; };
        this.on('close', function() {
            for (const s of __subs) server.nibeData.removeListener(s[0], s[1]);
            __subs.length = 0;
        });
        const startUp = () => {
            let system = config.system.replace('s','S');
            let conf = server.nibe.getConfig();
            this.status({ fill: 'yellow', shape: 'dot', text: `System ${system}` });
            let arr = [
                {topic:"inside_set_"+config.system,source:"nibe"},
                {topic:"outside",source:"nibe"}
            ];
            if(conf.system.pump!=="F370" && conf.system.pump!=="F470") {
                arr.push({topic:"dM",source:"nibe"});
                arr.push({topic:"dMstart",source:"nibe"})
            }
            
            if(conf.price===undefined) {
                conf.price = {};
                server.nibe.setConfig(conf);
            }
            if(conf.home.inside_sensors===undefined) {
                conf.home.inside_sensors = [];
                server.nibe.setConfig(conf);
            }
            
            if(conf.price['sensor_'+config.system]===undefined || conf.price['sensor_'+config.system]=="Ingen") {
                arr.push({topic:"inside_"+config.system,source:"nibe"});
            } else {
                let index = conf.home.inside_sensors.findIndex(i => i.name == conf.price['sensor_'+config.system]);
                if(index!==-1) {
                    var insideSensor = Object.assign({}, conf.home.inside_sensors[index]);
                    arr.push(insideSensor);
                }
            }
            if(conf.price.enable!==true) arr = [];
                server.initiatePlugin(arr,'price',config.system).then(data => {
                    this.status({ fill: 'green', shape: 'dot', text: `System ${system}` });
                    this.send({enabled:true});
                },(reject => {
                    this.status({ fill: 'red', shape: 'dot', text: `System ${system}` });
                    this.send({enabled:false});
                }));
        
        }
        this.on('input', function(msg) {
            let conf = server.nibe.getConfig();
            if(msg.topic=="update") {
                let data = {system:config.system}
                server.updateData(data);
                return;
            } else if(msg.topic=="price/enable") {
                let req = msg.topic.split('/');
                if(conf[req[0]]===undefined) conf[req[0]] = {};
                if(conf[req[0]][req[1]]!==msg.payload) {
                    conf[req[0]][req[1]] = msg.payload;
                    server.nibe.setConfig(conf);
                }
                startUp();
            } else if(msg.payload!==undefined && msg.topic!==undefined && msg.topic!=="") {
                let req = msg.topic.split('/');
                if(conf[req[0]]===undefined) conf[req[0]] = {};
                if(conf[req[0]][req[1]+'_'+config.system]!==msg.payload) {
                    conf[req[0]][req[1]+'_'+config.system] = msg.payload;
                    server.nibe.setConfig(conf);
                }
                startUp();
            }
            
        });
        if(server.nibe.core!==undefined && server.nibe.core.connected!==undefined && server.nibe.core.connected===true) {
            startUp();
        } else {
            sub('ready', (data) => {
                startUp();
            })
        }
        sub(this.id, (data) => {
            if(data.changed===true) {
                config.system = data.system;
                if(server.nibe.core!==undefined && server.nibe.core.connected!==undefined && server.nibe.core.connected===true) {
                    startUp();
                }
            }
        })
        sub('pluginPriceGraph', (data) => {
            if(data.system===config.system) {
                this.send({topic:"Graf",payload:[]});
                this.send({topic:"Graf",payload:data.values});
            }
        });
        // === FIX: forward pool graph as its own topic so Price 1.1 can route it ===
        sub('pluginPriceGraphPool', (data) => {
            if(data.system===config.system) {
                this.warn("POOL-GRAPH sys="+data.system+" len="+(data.values?data.values.length:0)); this.send({topic:"Graf Pool",payload:[]});
                this.send({topic:"Graf Pool",payload:data.values});
            }
        });
        sub('pluginPrice', (data) => {
            if(data.system===config.system) {
                if(data.price_level===undefined) {
                    this.send({topic:"Nuvarande Elprisnivå",payload:data.heat_price_level.data});
                    this.send({topic:"Nuvarande Elprisnivå (VV)",payload:data.hw_price_level.data});
                    this.send({topic:"Nuvarande Elpris",payload:data.price_current.data});
                    this.send([null,{topic:"test",payload:data}]);
                } else {
                    this.send({topic:"Nuvarande Elprisnivå",payload:data.price_level.data});
                    this.send({topic:"Nuvarande Elpris",payload:data.price_current.data});
                    this.send([null,{topic:"test",payload:data}]);
                }
            }
        })

        this.on('close', function() {
            let system = config.system.replace('s','S');
            this.status({ fill: 'yellow', shape: 'dot', text: `System ${system}` });
        });
    }
    RED.nodes.registerType("nibe-price",nibePrice);
}