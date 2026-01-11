module.exports = function (RED) {
    "use strict";

    function hourOfWeekFromTs(ts) {
        const d = new Date(ts);
        let day = d.getDay(); // 0 = sn .. 6 = lr
        const hour = d.getHours();
        // Gr mndag = 0
        day = (day + 6) % 7;
        return day * 24 + hour;
    }

    function NibeHotwaterAI(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.topic = config.topic || "nibe_vv_ai";

        const context = node.context();
        const storeName = "vvStore";

        // Frsk koppla mot nibe-config s vi kan lyssna p backend-eventet
        const server = RED.nodes.getNode(config.server);
        let backendListener = null;

        if (server && server.nibeData && typeof server.nibeData.on === "function") {
            backendListener = function (vvAi) {
                // vvAi = VV-AI-paketet frn backend (profil, BT6/BT7, min-temp, preheat osv.)
                const msg = {
                    topic: node.topic,
                    payload: vvAi
                };

                if (vvAi && typeof vvAi === "object") {
                    const bt6 = typeof vvAi.bt6 === "number" ? vvAi.bt6 : null;
                    const bt7 = typeof vvAi.bt7 === "number" ? vvAi.bt7 : null;
                    let text = "VV-AI frn backend";
                    const parts = [];
                    if (bt6 !== null) parts.push("BT6 " + bt6.toFixed(1) + "C");
                    if (bt7 !== null) parts.push("BT7 " + bt7.toFixed(1) + "C");
                    if (parts.length) {
                        text = parts.join(", ");
                    }
                    node.status({
                        fill: "green",
                        shape: "dot",
                        text
                    });
                } else {
                    node.status({
                        fill: "green",
                        shape: "dot",
                        text: "VV-AI frn backend"
                    });
                }

                node.send(msg);
            };

            server.nibeData.on("pluginHotwaterAI", backendListener);
        }

        node.on("input", function (msg, send, done) {
            send = send || function () { node.send.apply(node, arguments); };

            if (!msg || typeof msg !== "object") {
                if (done) done();
                return;
            }

            // === Backend-lge via flde: vv_profile/BT6/BT7 ligger redan i msg.payload ===
            const p = msg.payload;
            if (
                p && typeof p === "object" &&
                (
                    Array.isArray(p.profile) ||
                    typeof p.bt6 === "number" ||
                    typeof p.bt7 === "number"
                )
            ) {
                msg.topic = node.topic;
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "VV-AI frn backend (via flde)"
                });
                send(msg);
                if (done) done();
                return;
            }

            // === Legacy-lge: rkna enkel BT7-profil lokalt fr grafen ===
            let bt7 = null;

            if (typeof msg.bt7 === "number") {
                bt7 = msg.bt7;
            } else if (
                typeof msg.payload === "number" &&
                typeof msg.topic === "string" &&
                msg.topic.toLowerCase().indexOf("bt7") !== -1
            ) {
                bt7 = msg.payload;
            }

            if (typeof bt7 !== "number" || isNaN(bt7)) {
                // Inget vi kan gra p den hr inputen
                if (done) done();
                return;
            }

            const ts = (typeof msg.timestamp === "number" && !isNaN(msg.timestamp))
                ? msg.timestamp
                : Date.now();
            const idx = hourOfWeekFromTs(ts);

            let profile = context.get("vv_profile", storeName);
            if (!Array.isArray(profile) || profile.length !== 168) {
                profile = [];
                for (let i = 0; i < 168; i++) {
                    profile.push({ count: 0, avg: null });
                }
            }

            const bucket = profile[idx] || { count: 0, avg: null };
            const prevCount = typeof bucket.count === "number" ? bucket.count : 0;
            const prevAvg = (typeof bucket.avg === "number" && !isNaN(bucket.avg)) ? bucket.avg : bt7;
            const newCount = prevCount + 1;
            const newAvg = prevAvg + (bt7 - prevAvg) / newCount;

            bucket.count = newCount;
            bucket.avg = newAvg;
            profile[idx] = bucket;

            context.set("vv_profile", profile, storeName);

            const avg = (typeof bucket.avg === "number" && !isNaN(bucket.avg)) ? bucket.avg : bt7;

            const profileAvg = profile.map(b => (b && typeof b.avg === "number" ? b.avg : null));

            const out = {
                timestamp: ts,
                hourIndex: idx,
                value: bt7,
                norm: null,
                profile: profileAvg,
                bt6: null,
                bt7: bt7
            };

            msg.topic = node.topic;
            msg.payload = out;

            node.status({
                fill: "yellow",
                shape: "dot",
                text: "Legacy BT7-profil"
            });

            send(msg);
            if (done) done();
        });

        node.on("close", function (removed, done) {
            if (
                backendListener &&
                server &&
                server.nibeData &&
                typeof server.nibeData.removeListener === "function"
            ) {
                server.nibeData.removeListener("pluginHotwaterAI", backendListener);
            }
            if (done) done();
        });
    }

    RED.nodes.registerType("nibe-hotwater-ai", NibeHotwaterAI);
};
