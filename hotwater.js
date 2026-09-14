
module.exports = function(RED) {
     function nibeHotwater(config) {
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
            const arr = [
                //{topic:"bt6",source:"nibe"},
                //{topic:"bt7",source:"nibe"},
            ];
            let conf = server.nibe.getConfig();
            if(conf.price===undefined) {
                conf.price = {};
                server.nibe.setConfig(conf);
            }
            server.initiatePlugin(arr,'hotwater').then(result => {
            this.status({ fill: 'green', shape: 'dot', text: `` });
            this.send({enabled:true});
        },(reject => {
            this.status({ fill: 'red', shape: 'dot', text: `` });
            this.send({enabled:false});
        }));
        }
        
        if(server.nibe.core!==undefined && server.nibe.core.connected!==undefined && server.nibe.core.connected===true) {
            startUp();
        } else {
            sub('ready', (data) => {
                startUp();
            })
        }
        this.on('input', function(msg) {
            let conf = server.nibe.getConfig();
            if(msg.topic=="update") {
                server.hotwaterPlugin();
                return;
            }
            if(msg.payload!==undefined && msg.topic!==undefined && msg.topic!=="") {
                let req = msg.topic.split('/');
                if(conf[req[0]][req[1]+'_'+config.system]!==msg.payload) {
                    conf[req[0]][req[1]+'_'+config.system] = msg.payload;
                    server.nibe.setConfig(conf);
                    startUp();
                }
            }
            
        });
        sub(this.id, (data) => {
            if(data.changed===true) {
                if(server.nibe.core!==undefined && server.nibe.core.connected!==undefined && server.nibe.core.connected===true) {
                    startUp();
                }
            }
        })
        sub('pluginHotwaterAutoLuxury', (value) => {
            if(value.bt7!==undefined && value.bt7.data>-3276) {
                this.send({topic:"BT7 Topp",payload:value.bt7.data})
                this.send({topic:"BT6 Laddning",payload:value.bt6.data})
                if(value.hwTriggerTemp!==undefined) this.send({topic:"Startvärde",payload:value.hwTriggerTemp})
                if(value.hwTargetValue!==undefined) {
                    this.send({topic:"Stoppvärde",payload:value.hwTargetValue});
                } else {
                    this.send({topic:"Stoppvärde",payload:value.bt6.data});
                }
            }
    })
        sub('pluginHotwaterPriority', (value) => {
                if(value.bt7!==undefined && value.bt7.data>-3276) {
                    this.send([null,{topic:"BT7 Topp",payload:value.bt7.data}])
                    this.send([null,{topic:"BT6 Laddning",payload:value.bt6.data}])
                    this.send([null,{topic:"Startvärde",payload:value.hwStartTemp.data}])
                    this.send([null,{topic:"Stoppvärde",payload:value.hwStopTemp.data}])
                    
                }
        })
        this.on('close', function() {
            this.status({ fill: 'yellow', shape: 'dot', text: `` });
        });
    }
    RED.nodes.registerType("nibe-hotwater",nibeHotwater);
}
