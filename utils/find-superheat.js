const mtl = require("/opt/node/lib/node_modules/@burgrp/mqtt-reg/node_modules/@burgrp/mqtt-mtl")
const createRegister = require("/opt/node/lib/node_modules/@burgrp/mqtt-reg").mqttReg;


let mqtt = mtl(`mqtt://${process.env.MQTT}`);

let values = {};

["coldWaterInTemp", "coldWaterOutTemp", "hotWaterInTemp", "hotWaterOutTemp", "superheatActual"].forEach(regName => createRegister(mqtt, `nanook.${regName}`, value => {
    values[regName] = value;
}));

let superheat = createRegister(mqtt, "nanook.superheatTarget", () => { });

let maxPerf;

async function run() {
    let t0 = new Date().getTime();
    let minsPerDegC = 5;

    while (true) {
        let loaded = !Object.values(values).some(v => !Number.isFinite(v));

        if (loaded) {

            let sh = Math.floor((new Date().getTime() - t0) / (60 * 1000 * minsPerDegC));
            if (sh >= 26) {
                break;
            }

            superheat.set(sh);

            let perf = (values.hotWaterOutTemp - values.hotWaterInTemp) * (values.coldWaterInTemp - values.coldWaterOutTemp);

            if (!maxPerf || perf > maxPerf.perf) {
                maxPerf = {
                    sh,
                    ...values,
                    perf
                };
            }

            console.info([
                sh,
                values.superheatActual,
                values.coldWaterInTemp,
                values.coldWaterOutTemp,
                values.hotWaterInTemp,
                values.hotWaterOutTemp,
                perf
            ].map(v => v.toFixed(2)).join(";"));
        }

        await new Promise(resolve => setTimeout(resolve, 2 * 1000));
    }

    console.info(`Max performance ${maxPerf.perf.toFixed(2)} at superheat ${maxPerf.sh}`);
    superheat.set(maxPerf.sh);

}

run().catch(e => console.error(e));
