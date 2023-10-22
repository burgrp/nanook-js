const createRegister = require("./register.js");
const createPersistentRegister = require("./persistent.js");
const asyncWait = require("./async-wait.js");
const deepEqual = require("fast-deep-equal");
const tariffHours = require("./tariff-hours.js");

module.exports = async config => {

    let saturationData = config.saturationData[config.refrigerant];

    let peripherals = config.peripherals;

    let dataDir = config.dataDir || (__dirname + "/../data");
    console.info("Data directory", dataDir);

    let registers;
    registers = [
        await createPersistentRegister(dataDir, "maxOutTemp", "Max Out Temperature", 45, "°C"),
        await createPersistentRegister(dataDir, "minInTemp", "Min In Temperature", 30, "°C"),
        await createPersistentRegister(dataDir, "manualControl", "Manual Control", true),
        createRegister("sequenceInProgress", "Sequence In Progress"),
        createRegister("startedAt", "Started At"),
        createRegister("stoppedAt", "Stopped At"),
        await createPersistentRegister(dataDir, "blockingHours", "Blocking Hours", ""),
        createRegister("refrigerant", "Refrigerant", config.refrigerant),
        createRegister("evaporationTemp", "Evaporation Temperature", undefined, "°C"),
        await createPersistentRegister(dataDir, "superheatTarget", "Superheat Target", 12, "°C"),
        createRegister("superheatActual", "Superheat Actual", undefined, "°C"),
        await createPersistentRegister(dataDir, "mqttBroker", "MQTT Broker", ""),
        ...peripherals.registers
    ];

    registers = registers.reduce((map, reg) => {
        map[reg.key] = reg;
        return map;
    }, {});

    let systemErrors = {};
    let systemErrorsListeners = [];

    let ledSetting;
    async function updateRgbLed() {

        function getLedSetting() {

            // Error
            if (Object.keys(systemErrors).length) return { rampUpTime: 5, onTime: 5, rampDownTime: 5, offTime: 5, rgb: [255, 0, 0] };

            // Measure
            if (registers.sequenceInProgress.value === "measure") return { rampUpTime: 10, onTime: 10, rampDownTime: 10, offTime: 0, rgb: [0, 100, 255] };

            // Start
            if (registers.sequenceInProgress.value === "start") return { rampUpTime: 10, onTime: 10, rampDownTime: 10, offTime: 0, rgb: [0, 255, 100] };

            // Running
            if (registers.compressorRelay.value) return { rampUpTime: 100, onTime: 100, rampDownTime: 50, offTime: 5, rgb: [0, 255, 100] };

            // Stand by
            return { rampUpTime: 200, onTime: 0, rampDownTime: 200, offTime: 20, rgb: [255, 255, 255] };
        }

        try {
            let newSetting = getLedSetting();
            if (!deepEqual(newSetting, ledSetting)) {
                ledSetting = newSetting;
                await peripherals.setRgbLed(ledSetting);
            }
        } catch (e) {
            console.error("Error while updating RGB LED", e);
        }
    }


    function systemErrorsUpdated() {
        updateRgbLed().catch(console.error);
        systemErrorsListeners.forEach(listener => {
            try {
                listener(systemErrors);
            } catch (e) {
                console.error("Error in system error listener", e);
            }
        });
    }

    function clearSystemError(key) {
        delete systemErrors[key];
        systemErrorsUpdated();
    }

    function setSystemError(key, message) {
        if (systemErrors[key] !== message) {
            if (message === undefined) {
                delete systemErrors[key];
            } else {
                systemErrors[key] = message;
            }
            systemErrorsUpdated();
        }
    }

    Object.values(registers).forEach(register => {
        register.watch(async register => {
            setSystemError(`register-${register.key}`, register.error ? `Register ${register.key} error: ${register.error.message || register.error}` : undefined);
        });
    });

    function checkRegisters() {

        function checkRegister(reg, min, max) {
            try {
                if (isNaN(reg.value)) throw "has no value";
                if (reg.error) throw "is in error state: " + reg.error;
                if (reg.value < min) throw `value ${reg.value} under it's minimum ${min}`;
                if (reg.value > max) throw `value ${reg.value} over it's maximum ${max}`;
            } catch (e) {
                let message = `Register ${reg.name} ${e.message || e}`;
                setSystemError(`registerCheck-${reg.name}`, message);
                throw message;
            }
        }

        checkRegister(registers.coldFrigoPressure, 0, 10);
        checkRegister(registers.hotFrigoPressure, 0, 27);
        checkRegister(registers.psLow, true, true);
        checkRegister(registers.psHigh, true, true);
        checkRegister(registers.hotFrigoInTemp, 0, 145);
    }

    function isBlockedNow() {
        let hours = tariffHours.parseHours(registers.blockingHours.value);
        return tariffHours.isHighTariff(new Date(), hours);
    }

    async function checkRegistersAndStop() {
        if (registers.compressorRelay.value === true) {
            try {
                checkRegisters();
            } catch (e) {
                await stop();
            }
        }
    }

    registers.coldFrigoPressure.watch(checkRegistersAndStop);
    registers.hotFrigoPressure.watch(checkRegistersAndStop);
    registers.psLow.watch(checkRegistersAndStop);
    registers.psHigh.watch(checkRegistersAndStop);
    registers.hotFrigoInTemp.watch(checkRegistersAndStop);

    function getSaturationTempC(pressureBar) {
        for (let i = 0; i < saturationData.length; i++) {
            if (pressureBar === saturationData[i][0]) {
                return saturationData[i][1];
            } else if (pressureBar < saturationData[i][0]) {
                if (i === 0) return;
                return saturationData[i - 1][1] + (saturationData[i][1] - saturationData[i - 1][1]) * (pressureBar - saturationData[i - 1][0]) / (saturationData[i][0] - saturationData[i - 1][0]);
            }
        }
    }

    async function updateActualSuperheat() {
        let saturationTemp = getSaturationTempC(registers.coldFrigoPressure.value + 1);
        await registers.evaporationTemp.set(saturationTemp);
        let superheatActual = registers.coldFrigoOutTemp.value - saturationTemp;
        await registers.superheatActual.set(isNaN(superheatActual) ? undefined : superheatActual);
    }

    registers.coldFrigoPressure.watch(updateActualSuperheat);
    registers.coldFrigoOutTemp.watch(updateActualSuperheat);

    let minTempDiff = 15;

    registers.maxOutTemp.watch(async () => {
        await registers.maxOutTemp.set(
            Math.min(
                config.maxOutTemp,
                registers.maxOutTemp.value
            )
        );
        await registers.minInTemp.set(
            Math.min(
                registers.minInTemp.value,
                registers.maxOutTemp.value - config.minTempDiff
            )
        );
    });

    registers.minInTemp.watch(async () => {
        await registers.maxOutTemp.set(
            Math.max(
                registers.maxOutTemp.value,
                registers.minInTemp.value + config.minTempDiff
            )
        );
    });


    async function sweep(cb, from, to, timeMs, periodMs = 100) {
        let steps = Math.ceil(timeMs / periodMs);
        for (let step = 0; step <= steps; step++) {
            await cb(from + (to - from) * step / steps);
            await asyncWait(periodMs);
        }
    }

    let sequenceInProgress;

    function notifySequenceChange() {
        async function doAsync() {
            try {
                await registers.sequenceInProgress.set(sequenceInProgress);
                await updateRgbLed();
            } catch (e) {
                console.error("Error in notifySequenceChange", e);
            }
        }
        doAsync().catch(console.error);
    }

    async function runSequence(sequenceName, cb) {

        clearSystemError(sequenceName + "Sequence");

        console.info(`Starting sequence '${sequenceName}'...`);
        try {

            if (sequenceInProgress) {
                throw `Can not start sequence '${sequenceName}', because '${sequenceInProgress}' is in progress`;
            }

            sequenceInProgress = sequenceName;
            notifySequenceChange();

            let result = await cb();
            console.info(`Sequence '${sequenceName}' finished.`);

            sequenceInProgress = undefined;
            notifySequenceChange();

            return result;

        } catch (e) {

            console.error(`Sequence '${sequenceName}' failed: ${e.message || e}`);
            setSystemError(sequenceName + "Sequence", `${e.message || e} in sequence ${sequenceName}`);

            sequenceInProgress = undefined;
            notifySequenceChange();

            throw e;
        }
    }

    async function start() {

        try {

            await runSequence("start", async () => {

                await registers.startedAt.set(new Date());

                if (registers.compressorRelay.value === true) {
                    throw "Compressor already running";
                }

                checkRegisters();

                await config.peripherals.setColdWaterPump(true);
                await config.peripherals.setHotWaterPump(true);

                // fully open
                await config.peripherals.eevRun(-500, true);
                // let evaporator get enough refrigerant to avoid too low pressure on cold start
                await asyncWait(20000);

                await sweep(async r => {
                    await peripherals.setCompressorRamp(r);
                }, 50, 100, 800);
                await peripherals.setCompressorRelay(true);
                await asyncWait(1000);
                await peripherals.setCompressorRamp(0);

                await asyncWait(4000);
            });

        } catch (e) {
            await stop();
            throw e;
        }
    }

    async function stop() {
        await runSequence("stop", async () => {

            await registers.stoppedAt.set(new Date());

            try {
                if (registers.compressorRelay.value === true) {
                    await peripherals.setCompressorRamp(100);
                    await asyncWait(1000);
                    await peripherals.setCompressorRelay(false);
                    await asyncWait(1000);
                    await peripherals.setCompressorRamp(0);
                }
            } finally {

                await peripherals.setCompressorRelay(false);

                try {
                    await peripherals.setCompressorRamp(0);
                } catch (e) {
                    // FALL THROUGH
                    // Ramp DAC is powered from COMP_5V, which may be down in case of pressure switch stop
                }

                await peripherals.eevRun(500, true);
                await peripherals.setColdWaterPump(false);
                await peripherals.setHotWaterPump(false);
            }

        });
    }

    let lastSuperheat;

    setInterval(() => {
        let actual = registers.superheatActual.value;
        if (!sequenceInProgress && registers.manualControl.value === false && registers.compressorRelay.value === true) {
            let stepsPerC = config.eevStepsPerC || 1;
            let target = registers.superheatTarget.value;
            let steps = Math.round(((target - actual) - (actual - (lastSuperheat === undefined ? actual : lastSuperheat)) * 2 / 3) * stepsPerC);
            let maxSteps = config.eevMaxStepsPerCheck || 10;
            if (steps > maxSteps) {
                steps = maxSteps;
            }
            if (steps < -maxSteps) {
                steps = -maxSteps;
            }
            console.info(`EEV check - last SH: ${lastSuperheat}°C, actual SH: ${actual}°C, target SH: ${target}°C, steps: ${steps}`);
            if (steps) {
                peripherals.eevRun(steps, false);
            }
        }
        lastSuperheat = actual;
    }, 1000 * (config.eevIntervalSec || 5));

    function scheduleTargetTempStart(scheduleMs) {
        setTimeout(async () => {
            if (!registers.manualControl.value && registers.minInTemp.value && registers.compressorRelay.value === false && !isBlockedNow()) {
                try {
                    let nowMs = new Date().getTime();
                    console.info("Target temp start check");

                    // check for start

                    let minIdleTimeMs = (config.minIdleTimeMin || 3) * 60 * 1000;
                    let idleTimeMs = nowMs - (registers.stoppedAt.value && registers.stoppedAt.value.getTime());
                    if (idleTimeMs < minIdleTimeMs) {
                        console.info(`Need to wait another ${(minIdleTimeMs - idleTimeMs) / 1000} seconds for minimum idle time`);
                    } else {

                        let hotWaterInTemp = await runSequence("measure", async () => {
                            let previousHotWaterPump = registers.hotWaterPump.value;
                            if (previousHotWaterPump === undefined) {
                                throw "Unknown state of hot water pump";
                            }

                            await peripherals.setHotWaterPump(true);
                            await asyncWait((config.tempCheckPumpTimeSec || 30) * 1000);
                            let temp = registers.hotWaterInTemp.value;
                            await peripherals.setHotWaterPump(previousHotWaterPump);
                            return temp;
                        });

                        console.info("Water inlet temperature is", hotWaterInTemp, "will start at", registers.minInTemp.value);
                        if (hotWaterInTemp <= registers.minInTemp.value) {
                            await start();
                        }

                    }
                } catch (e) {
                    console.error("Exception in target temp start check", e);
                    setSystemError("targetTempStartCheck", e.message || e);
                }
            }
            scheduleTargetTempStart(1000 * (config.targetTempStartCheckSec || (5 * 60)));
        }, scheduleMs);
    }

    function scheduleTargetTempStop() {
        setTimeout(async () => {
            if (!registers.manualControl.value && registers.maxOutTemp.value && registers.compressorRelay.value === true) {
                try {
                    let nowMs = new Date().getTime();
                    console.info("Target temp stop check");

                    // check for stop

                    let minRunTimeMs = (config.minRunTimeMin || 7) * 60 * 1000;
                    let runTimeMs = nowMs - (registers.startedAt.value && registers.startedAt.value.getTime());
                    if (runTimeMs < minRunTimeMs) {
                        console.info(`Need to wait another ${(minRunTimeMs - runTimeMs) / 1000} seconds for minimum run time`);
                    } else {

                        let hotWaterOutTemp = registers.hotWaterOutTemp.value;

                        console.info("Water outlet temperature is", hotWaterOutTemp, "will stop at", registers.maxOutTemp.value);
                        if (
                            (hotWaterOutTemp >= registers.maxOutTemp.value)
                        ) {
                            await stop();
                        } else if (isBlockedNow()) {
                            console.info("Stopping because of blocking hours");
                            await stop();
                        }

                    }
                } catch (e) {
                    console.error("Exception in target temp stop check", e);
                    setSystemError("targetTempStopCheck", e.message || e);
                }
            }
            scheduleTargetTempStop();
        }, 1000 * (config.targetTempStopCheckSec || 10));
    }

    scheduleTargetTempStart(5000);
    scheduleTargetTempStop();

    await updateRgbLed();

    config.flashConfig.watch({
        name: "wifi.txt",
        format: config.flashConfig.text,
        callback: async c => {
            try {
                await config.networkManager.configure(c, "nanook");
                console.info(`Connection to ${c.ssid} configured!`);
            } catch (e) {
                setSystemError("flashConfig", e.message || e);
            }
        }
    }).start();

    return {

        registers,

        systemErrors,

        start,

        stop,

        watchSystemErrors(listener) {
            systemErrorsListeners.push(listener);
        },

        async setColdWaterPump(state) {
            await peripherals.setColdWaterPump(state);
        },

        async setHotWaterPump(state) {
            await peripherals.setHotWaterPump(state);
        },

        async setCompressorRelay(state) {
            await peripherals.setCompressorRelay(state);
        },

        async setCompressorRamp(ramp) {
            await peripherals.setCompressorRamp(ramp);
        },

        async eevRun(fullSteps, fast) {
            await peripherals.eevRun(fullSteps, fast);
        },

        async clearSystemError(key) {
            clearSystemError(key);
        },

        async setEevPosition(position) {
            await peripherals.setEevPosition(position);
        },

        async setRgbLed(led) {
            await peripherals.setRgbLed(led);
        }
    }
}
