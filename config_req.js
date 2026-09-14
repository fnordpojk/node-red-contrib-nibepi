module.exports = function(RED) {
    function nibeRequest(config) {
        RED.nodes.createNode(this,config);
        this.server = RED.nodes.getNode(config.server);
        // Track this node's own subscriptions so close() can release exactly
        // those. They were previously either never removed (leaking on every
        // redeploy) or cleared with removeAllListeners(), which also wiped every
        // other node's subscriptions from the shared emitter.
        const __server = this.server;
        const __subs = [];
        const sub = (ev, fn) => { __subs.push([ev, fn]); __server.nibeData.on(ev, fn); return fn; };
        this.on('close', function() {
            for (const s of __subs) __server.nibeData.removeListener(s[0], s[1]);
            __subs.length = 0;
        });
        let nibe = this.server.nibe;
        let translate = this.server.translate;
        function getInfo(data,node,msg={}) {
            let category = data.category;
            let parameter = data.parameter;
            let label = data.label;
            if(category!==undefined && category!=="" && parameter!==undefined && parameter!=="") {
                if(label===undefined || label=="") label = parameter;
                let config = nibe.getConfig();
                if(config[category]!==undefined && config[category][parameter]!==undefined) {
                    node.status({ fill: 'green', shape: 'dot', text: `Received parameter ${parameter}` });
                    // Check if parameter should be visible
                    if(parameter!=="enable") {
                        if(config[category].enable===true) {
                            msg.enabled = true;
                        } else {
                            msg.enabled = false;
                        }
                    }
                    // Labeling
                    let language = "SE"; // default language
                    if(config.system!==undefined && config.system.language!==undefined) {
                        language = config.system.language;
                    }
                    if(translate!==undefined && translate.dash!==undefined && translate.dash[label]!==undefined && translate.dash[label][language]!==undefined) {
                        label = translate.dash[label][language]
                    }
                    msg.label = label;
                    msg.payload = config[category][parameter];
                    node.send(msg);
                } else {
                    node.status({ fill: 'red', shape: 'dot', text: `Could not found parameter` });
                    node.send(msg);
                }
            }
        }
        if (this.server) {
            getInfo(config,this);
            this.on('input', function(msg) {
                if(msg.topic=="setConfig") {
                    this.server.updateConfig(config.category,config.parameter,msg.payload);
                } else {
                    getInfo(config,this,msg)
                }
            });
            if(config.category!==undefined && config.parameter!==undefined) {
                sub(`config_${config.category}`, (data) => {
                    getInfo(config,this)
                })
            }
            
        } else {
            this.status({ fill: 'red', shape: 'dot', text: `No configuration node configured` });
            // No config node configured
        }
    }
    RED.nodes.registerType("nibe-config-req",nibeRequest);
}